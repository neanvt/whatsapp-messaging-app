# Requirements — Tenant Template Isolation

Last updated: 2025-02-14

## Summary

Tenant B (Surshyam, `userId cmv321v6j0000hjwlr4cxp7w5`) can see Tenant A's
(Utkranti, `userId cmn1cinmh0000jmdn4fs17kn1`) WhatsApp message templates. The
leak is **not** in the list query: `GET /api/templates`
(`src/app/api/templates/route.ts`) already filters by `session.user.id`.
Instead, Utkranti's templates are **physically stored** as `Template` rows under
Surshyam's `userId`. Verified against the live Turso DB: both users have 7
`Template` rows with the same `name` and the same `metaTemplateId`
(e.g. `harinaam_technical_update=1280785560136375`,
`test_appoint=1430233625232770`,
`update_app_harinaam_mahanidhi_2=1261692206144791`), and those `metaTemplateId`s
belong to Utkranti's WABA `1290990196241997`.

Root cause chain (confirmed against the real code):

1. Surshyam connected number `919720996300` through
   `POST /api/numbers/manual` (`src/app/api/numbers/manual/route.ts`) with
   `wabaId = 989050294147122`, which is a Meta *Messaging-account* id, **not** a
   WhatsApp Business Account id. The manual-connect handler's three-way WABA
   tie-check treats a **failed** `GET /{wabaId}/phone_numbers` call as
   *non-fatal* (branch `(c)`: `console.warn` + proceed). That non-fatal branch
   let the wrong id be saved as `wabaId` on a `verified` `WhatsAppNumber` row.
2. When Surshyam ran Sync Status (`POST /api/templates/sync`,
   `src/app/api/templates/sync/route.ts`), the handler resolved that number's
   `wabaId`+token, fetched `message_templates` from Meta, and — in the "Import
   templates that exist on Meta but not locally" loop — created `Template` rows
   under `session.user.id` (Surshyam) for every Meta template returned. Because
   the `wabaId`/token combination resolved to Utkranti's WABA, Utkranti's
   templates were imported under Surshyam.

The current sync code already (a) dedupes verified numbers by `wabaId`,
(b) tags each fetched Meta template with a transient `__sourceNumberId`, and
(c) sets `whatsappNumberId: meta.__sourceNumberId` on import. So **new** imports
bind a non-null `whatsappNumberId`; the brief's "imports set
`whatsappNumberId=null`" claim is stale for new imports. However, the
**existing leaked DB rows** may still have `whatsappNumberId = null`, and no
guard verifies that an imported template's WABA is one the tenant actually owns.

This document specifies the requirements to (1) harden the sync import path,
(2) make the manual-connect WABA validation reject non-WABA ids, (3) clean up
the already-leaked rows via an idempotent script, and (4) handle the Surshyam
number's bad `wabaId`. Design decisions are out of scope here.

### Assumptions

- A1. A tenant may only ever sync/import against a `wabaId` stored on one of
  **their own** `WhatsAppNumber` rows (`userId == session.user.id`,
  `verificationStatus == "verified"`). The sync handler already queries only
  the current user's numbers, so this is a hardening/validation assumption, not
  a new ownership model.
- A2. A "real" WABA id is one for which `GET /{wabaId}/phone_numbers`
  (or an equivalent WABA-scoped Graph read) succeeds for the tenant's token.
  A messaging-account id such as `989050294147122` causes that call to fail with
  a Graph error indicating the object is not a WABA / unsupported field — this
  is the signal used to reject.
- A3. A "leaked" row is a `Template` under Surshyam's `userId` whose
  `metaTemplateId` is non-null **and** also exists on a row under a *different*
  `userId`. A locally-authored draft that merely shares a `name` but has a
  distinct or null `metaTemplateId` is **not** leaked and must be preserved.
- A4. The correct WABA id for Surshyam's number is unknown and must not be
  guessed; the number is Pending on Meta.
- A5. Transient Graph failures (rate limit, 5xx, network) and
  permission-scoped failures are distinct from "not a WABA" failures and must
  remain non-fatal at connect time, matching the current defensive intent.

## Functional Requirements

- FR1. Harden `POST /api/templates/sync` so it can never create a `Template`
  row under tenant X from a WABA that tenant X does not own.
- FR2. Ensure every `Template` row created or updated by sync import is stamped
  with a non-null `whatsappNumberId` that belongs to the current tenant, and
  (via that number) a verifiable source `wabaId`.
- FR3. Validate the supplied `wabaId` at manual connect time
  (`POST /api/numbers/manual`) so a non-WABA id (e.g. a messaging-account id) is
  rejected before any DB write, while transient/permission errors stay
  non-fatal.
- FR4. Provide a one-time, idempotent cleanup script under `scripts/` (modeled
  on `scripts/add-tenant-meta-app-table.mjs`, using `@libsql/client` with manual
  `.env` parsing) that removes only the leaked Utkranti templates stored under
  the Surshyam `userId`.
- FR5. Address the Surshyam `WhatsAppNumber` row carrying the bad
  `wabaId = 989050294147122` so the wrong-id state does not persist unresolved.
- FR6. Preserve all existing legitimate behavior: Meta→local status mapping,
  local name de-duplication, the per-tenant WABA resolution used by
  submit/delete, credits accounting, the `#131008` send fix, and superadmin
  behavior.

## Non-Functional Requirements

- NFR1. Multi-tenant isolation: every template query and every Meta Graph call
  stays scoped to `session.user.id`; a tenant may only sync/import/submit/delete
  against a WABA on one of their own verified `WhatsAppNumber` rows.
- NFR2. Secrets safety: never log access tokens or ciphertext; continue to route
  all credential resolution through `resolveWabaCredentials` and `@/lib/crypto`.
- NFR3. No new runtime dependencies (zero-new-deps preferred). TypeScript; App
  Router handlers return `NextResponse`. DB mutations run through
  `@libsql/client` scripts because `npm run db:push` fails (Prisma 5.22 rejects
  `libsql://`).
- NFR4. The cleanup script must be safe to re-run (idempotent) and must perform a
  dry-run report before any deletion.

## Acceptance Criteria (EARS, numbered)

### Sync import hardening (`src/app/api/templates/sync/route.ts`)

1. WHEN `POST /api/templates/sync` resolves the current user's verified numbers,
   THE SYSTEM SHALL only fetch and import templates from a `wabaId` that is
   stored on a `WhatsAppNumber` row owned by `session.user.id` with
   `verificationStatus == "verified"`, `wabaId != null`, and
   `accessToken != null`.
2. WHEN sync imports a Meta template that has no matching local row,
   THE SYSTEM SHALL create the `Template` with `userId == session.user.id` and
   `whatsappNumberId` set to the source number's id (non-null), such that no
   imported row is ever persisted with `whatsappNumberId == null`.
3. IF a Meta template cannot be attributed to a concrete source
   `WhatsAppNumber` of the current tenant (missing/invalid `__sourceNumberId`),
   THEN THE SYSTEM SHALL NOT create or update a `Template` row for it.
4. WHILE processing a `wabaId` during sync, IF that `wabaId` is determined to be
   invalid as a WABA (same not-a-WABA signal as AC12), THEN THE SYSTEM SHALL NOT
   import any templates fetched under it and SHALL surface a clear
   non-500 error or skip that number without importing.
5. WHEN sync runs for a tenant whose numbers resolve only to WABAs they do not
   legitimately own, THE SYSTEM SHALL create zero new cross-tenant `Template`
   rows (the regression that produced the Surshyam leak).
6. WHEN sync encounters a credential-resolution failure
   (`resolveWabaCredentials` throws), THE SYSTEM SHALL abort with HTTP 500
   `{"error":"credential error"}` and SHALL NOT log the token or ciphertext
   (preserve current behavior).
7. WHEN sync completes, THE SYSTEM SHALL return the existing response shape
   `{ synced, updated, imported, duplicatesRemoved }` and SHALL preserve the
   current Meta→local status mapping (`mapMetaStatus`) and local name
   de-duplication.
8. THE SYSTEM SHALL keep `GET /api/templates` scoped by `session.user.id`
   (unchanged) so the list endpoint never returns another tenant's rows.

### Template-row source invariant

9. WHERE a `Template` row has a non-null `metaTemplateId`,
   THE SYSTEM SHALL guarantee that row was created from a WABA owned by the
   row's `userId` via that tenant's own verified `WhatsAppNumber`
   (the enforced invariant from NFR1).
10. WHEN sync updates an existing local template's status/category from Meta,
    THE SYSTEM SHALL only match it against Meta templates fetched from the
    tenant's own WABA(s) (no cross-tenant status bleed).

### Manual connect WABA validation (`src/app/api/numbers/manual/route.ts`)

11. WHEN `GET /{wabaId}/phone_numbers` succeeds AND the `phoneNumberId` is
    present in the list, THE SYSTEM SHALL proceed to persist (unchanged
    branch (a)).
12. WHEN `GET /{wabaId}/phone_numbers` fails with a Graph error that means the
    object is not a WABA (e.g. unknown-path / unsupported-field / invalid-object
    class, distinguished by Graph error `code`/`type`), THE SYSTEM SHALL reject
    with HTTP 400 `{"error":"Invalid WhatsApp Business Account ID"}` and SHALL
    NOT write any `WhatsAppNumber` row.
13. WHEN `GET /{wabaId}/phone_numbers` fails with a transient error (rate limit,
    5xx, network) or a permission-scoped error that does not prove the id is not
    a WABA, THE SYSTEM SHALL treat the failure as non-fatal and proceed
    (preserve current defensive intent for valid-but-unlistable WABAs).
14. WHEN `GET /{wabaId}/phone_numbers` succeeds but the `phoneNumberId` is
    absent from the list, THE SYSTEM SHALL reject with HTTP 400
    "This phone number is not under the provided WhatsApp Business Account"
    (unchanged branch (b)).
15. THE SYSTEM SHALL NOT log the provided access token or its ciphertext in any
    branch of the manual-connect handler.

### Cleanup migration (`scripts/`)

16. WHEN the cleanup script runs, THE SYSTEM SHALL first perform a dry run that
    logs every `Template` row it would delete (id, userId, name,
    metaTemplateId) WITHOUT deleting anything, before any mutation.
17. THE SYSTEM SHALL delete a `Template` row only when it is under the Surshyam
    `userId` (`cmv321v6j0000hjwlr4cxp7w5`) AND its non-null `metaTemplateId`
    also exists on a `Template` row under a different `userId` (the Utkranti
    `userId cmn1cinmh0000jmdn4fs17kn1`).
18. THE SYSTEM SHALL NOT delete, modify, or reassign any `Template` row under
    the Utkranti `userId`.
19. THE SYSTEM SHALL NOT delete a Surshyam row that is a locally-authored draft
    sharing only a `name` (distinct or null `metaTemplateId`) unless it is
    provably a leaked import by matching `metaTemplateId` per AC17.
20. WHEN the cleanup script is run a second time after a successful first run,
    THE SYSTEM SHALL detect that no leaked rows remain and exit as a clean no-op
    (idempotent).
21. IF the script encounters an error, THE SYSTEM SHALL fail loudly
    (`process.exit(1)`) with a non-secret message and close the libSQL client in
    a `finally` block (mirrors `add-tenant-meta-app-table.mjs`).
22. THE SYSTEM SHALL connect using `@libsql/client` with `TURSO_DATABASE_URL`
    and `TURSO_AUTH_TOKEN` parsed from `.env`, and SHALL NOT depend on
    `prisma db push`.

### Surshyam bad-WABA number

23. THE SYSTEM SHALL, at minimum, document the Surshyam `WhatsAppNumber` row
    with `wabaId = 989050294147122` as holding an invalid WABA id; the design
    MAY additionally clear or flag that connection so the tenant reconnects with
    the correct WABA id.
24. THE SYSTEM SHALL NOT guess or auto-populate the correct WABA id for the
    Surshyam number (the number is Pending on Meta).

### Regression preservation

25. THE SYSTEM SHALL preserve the per-tenant WABA resolution used by
    `POST /api/templates/[id]/submit` and `DELETE /api/templates/[id]`
    (precedence: explicit `numberId` → template binding → sole number) with no
    behavioral change.
26. THE SYSTEM SHALL preserve existing credits accounting, the `#131008` send
    fix, and superadmin behavior (no changes introduced by this work).

## Out of Scope

- Redesigning the templates data model or adding a `wabaId` column to
  `Template` (the design step may propose stamping source WABA, but schema
  changes are a design decision, not a requirement here).
- Automated detection/cleanup of cross-tenant leaks for tenants other than the
  Surshyam/Utkranti pair (the script targets the two known `userId`s).
- Changing the Embedded Signup connection path or any non-template Meta
  integration.
- UI/layout work (sidebar/header/footer componentization, mobile
  responsiveness) raised elsewhere in the conversation.
- Determining or re-provisioning the correct Surshyam WABA id.
