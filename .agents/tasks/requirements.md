# Requirements — Per-Tenant Credentials for Template-Management Routes

Last updated: 2025-02-14

## Summary

Three WhatsApp template-management API routes currently read a single hardcoded
pair of env vars (`META_WABA_ID` + `META_ACCESS_TOKEN`) when they call the Meta
Graph API. In a multi-tenant SaaS this is wrong: every tenant's template submit,
sync, and delete hit the same shared WABA/token. This task migrates all three
routes to resolve **per-tenant** credentials from the signed-in user's own
connected, verified `WhatsAppNumber` row — mirroring the already-shipped send-route
migration (`resolveSendCredentials`) — and removes the env fallback entirely from
these routes.

The three routes:

| Route | Method | Meta call | What must be preserved |
|---|---|---|---|
| `src/app/api/templates/[id]/submit/route.ts` | POST | `POST /{wabaId}/message_templates` | `buildComponents`, name sanitization, 1024-char body guard, `META_TOKEN_EXPIRED` (code 190) handling, write-back of `status:'submitted'` + `metaTemplateId` + `submittedAt` |
| `src/app/api/templates/sync/route.ts` | POST | `GET /{wabaId}/message_templates?...` | status/category mapping, dedup, import of Meta-only templates for the user |
| `src/app/api/templates/[id]/route.ts` (DELETE) | DELETE | `DELETE /{wabaId}/message_templates?...` | best-effort / non-fatal `.catch` |

Only the **source of `wabaId` / `accessToken`** changes. All existing
business logic stays intact.

### Prior art to reuse (do not re-derive)

- `src/lib/whatsapp.ts` — `resolveSendCredentials(number)`, `serializeNumber`,
  `normalizePhone`, `NumberOwnedByOtherTenantError`, `upsertNumberForUser`. The
  SEND routes already use `resolveSendCredentials`; this task does the equivalent
  for templates. Add a shared WABA resolver (e.g. `resolveWabaCredentials`
  returning `{ wabaId, accessToken }` decrypted, or `null`) to this file rather
  than duplicating decrypt logic in routes.
- `src/lib/crypto.ts` — `encrypt` / `decrypt` (AES-256-GCM, key from
  `ENCRYPTION_KEY`). `decrypt()` may throw on bad key / tampered / malformed
  ciphertext.
- Schema (`prisma/schema.prisma`): `WhatsAppNumber` carries per-tenant `wabaId`,
  `phoneNumberId`, `accessToken` (ciphertext), `verificationStatus`
  (`"verified"` when connected). `Template` **already** has optional
  `whatsappNumberId String?` + `whatsappNumber` relation — the template routes
  currently ignore it.

## Functional Requirements

1. **Shared resolver.** Add a per-tenant WABA credential resolver to
   `src/lib/whatsapp.ts` that, given a `WhatsAppNumber`-shaped input, returns the
   plaintext `{ wabaId, accessToken }` (accessToken decrypted via `decrypt`) or a
   null/empty result when the row lacks stored credentials. Decrypt logic must
   live here, not in the route handlers. It must not log token or ciphertext.
2. **Submit route (POST).** Resolve `wabaId` + `accessToken` from a verified
   `WhatsAppNumber` owned by `session.user.id` instead of env. All other logic
   (`buildComponents`, Meta name sanitization, 1024-char body guard, request
   body shape, the `status:'submitted'` / `metaTemplateId` / `submittedAt`
   write-back, and the `META_TOKEN_EXPIRED` branch for code 190 /
   "Session has expired") is unchanged.
3. **Sync route (POST).** Resolve the WABA(s) to fetch from per-tenant. The route
   must still obtain a WABA even for templates not yet local (it fetches ALL
   templates for the WABA from Meta). All status mapping (`mapMetaStatus`),
   dedup-by-sanitized-name, and import of Meta-only templates into the local DB
   for `session.user.id` are unchanged.
4. **Delete route (DELETE path).** Resolve `wabaId` + `accessToken` per-tenant for
   the best-effort Meta `DELETE`. The Meta call stays non-fatal: a failure (or
   absence of credentials) is caught/logged and the local row is still deleted.
   The local `prisma.template.delete` must not be blocked by Meta-side problems.
5. **Ownership scoping.** Every DB query that selects the template and every
   `WhatsAppNumber` lookup is filtered by `userId: session.user.id`. Every Meta
   call uses only credentials belonging to that tenant. No route may act against a
   WABA owned by another tenant.
6. **No env fallback in these three routes.** `process.env.META_WABA_ID` and
   `process.env.META_ACCESS_TOKEN` must no longer be read by any of the three
   routes. (Env usage elsewhere in the app is out of scope.)
7. **"Not connected" handling.** A user with no connected number — or none with
   `verificationStatus === "verified"` and usable stored credentials — receives a
   clear client error ("Connect a WhatsApp number before managing templates"),
   never a 500 and never a silent env fallback.
8. **Decrypt-failure handling.** If `decrypt()` throws (bad key / tampered /
   malformed ciphertext), the route returns a clean error (e.g. 500 "credential
   error") with no token or ciphertext written to logs or the response.
9. **Token-expired detection.** Preserve the existing `META_TOKEN_EXPIRED`
   (code 190 / "Session has expired") handling in submit, and apply the same
   detection in sync (and delete where sensible, consistent with its best-effort
   nature).
10. **No regressions.** All currently working behavior — status mapping, dedup,
    import, 1024-char limit, name sanitization, token-expired handling, response
    shapes/status codes for the happy paths — remains intact.

## Non-Functional Requirements

- TypeScript, Next.js 14 App Router handlers returning `NextResponse`.
- Zero new dependencies preferred; if one is unavoidable, pin it to an exact
  version (no `^`/`~`).
- Secrets never logged: no access token or ciphertext in `console.*` or responses.
- Multi-tenant isolation is a security invariant, not best-effort.

## Open Design Questions (decide in design doc — DO NOT resolve here)

1. **Template → WABA mapping.** How do submit and delete pick which
   `WhatsAppNumber`/WABA to use?
   - Candidates: (a) the template's own `whatsappNumberId` relation when set;
     (b) the user's single connected verified number when they have exactly one;
     (c) an explicit request param (e.g. `numberId`).
   - Must error clearly when the user has **0** connected verified numbers, and
     when they have **>1** and none is specified/associated.
2. **Sync WABA selection.** How does sync choose which WABA(s) to pull from?
   - Candidates: (a) an explicit param; (b) iterate ALL of the user's connected
     verified WABAs; (c) a single selected number.
   - Decide how **imported** Meta-only templates get associated with their source
     number (i.e. whether `whatsappNumberId` is set on import, and to which number).
3. **Resolver shape.** Final signature/return of the shared resolver
   (`resolveWabaCredentials`) — e.g. `{ wabaId, accessToken } | null` vs throwing —
   and whether it accepts a `WhatsAppNumber` row or a `numberId` to look up.

## Schema Reality (constraint for design)

- `Template.whatsappNumberId` **already exists** in `prisma/schema.prisma`, so this
  task most likely needs **no new column**. Design should confirm and reuse it.
- **`prisma db push` does NOT work in this repo**: Prisma CLI 5.22 rejects
  `libsql://` URLs with error `P1012`. Any additive column change MUST be applied
  via an idempotent `@libsql/client` script under `scripts/` following the
  existing pattern (`scripts/add-media-attachments.mjs`,
  `scripts/add-meta-onboarding-columns.mjs`). Design should avoid schema changes if
  the existing column suffices.

## Acceptance Criteria

### AC-1: Shared resolver added to src/lib/whatsapp.ts
1. WHEN credential resolution for a WABA is needed THEN a single exported helper
   in `src/lib/whatsapp.ts` SHALL perform the decrypt and return the plaintext
   WABA creds (or a null/empty result), and route handlers SHALL NOT contain their
   own `decrypt` calls for this purpose.

### AC-2: Submit uses per-tenant credentials
2. WHEN an authenticated user submits a template THEN the route SHALL use
   `wabaId` + `accessToken` from a `verificationStatus === "verified"`
   `WhatsAppNumber` owned by `session.user.id`, and SHALL NOT read
   `process.env.META_WABA_ID` or `process.env.META_ACCESS_TOKEN`.
3. WHEN submit succeeds THEN the template SHALL be written back with
   `status: "submitted"`, `metaTemplateId` from Meta, and `submittedAt`, exactly as
   today.
4. WHEN the template body exceeds 1024 characters THEN submit SHALL return 400 with
   the existing character-limit message and SHALL NOT call Meta.
5. WHEN the Meta name is built THEN it SHALL use the existing lowercase /
   underscore sanitization unchanged.

### AC-3: Sync uses per-tenant credentials
6. WHEN an authenticated user syncs THEN the route SHALL fetch
   `GET /{wabaId}/message_templates` using per-tenant creds and SHALL NOT read the
   env vars.
7. WHEN Meta returns templates THEN existing status/category mapping, dedup, and
   import-of-Meta-only-templates-for-`session.user.id` behavior SHALL be unchanged.
8. WHEN sync completes THEN the response SHALL retain the existing shape
   (`synced`, `updated`, `imported`, `duplicatesRemoved`).

### AC-4: Delete uses per-tenant credentials and stays best-effort
9. WHEN a template with a `metaTemplateId` is deleted THEN the route SHALL call
   Meta `DELETE /{wabaId}/message_templates` using per-tenant creds and SHALL NOT
   read the env vars.
10. WHEN the Meta delete fails OR no per-tenant credentials exist THEN the error
    SHALL be caught/logged and the local `prisma.template.delete` SHALL still run
    (delete is non-fatal).

### AC-5: Multi-tenant isolation
11. WHEN any of the three routes selects the template or a WhatsApp number THEN
    the query SHALL filter by `userId: session.user.id`.
12. WHEN credentials are resolved THEN they SHALL belong only to a number owned by
    the signed-in tenant; no route SHALL act against another tenant's WABA.

### AC-6: No connected / unverified number
13. WHEN the user has no connected verified number with usable credentials for the
    requested operation THEN submit and sync SHALL return a clear 400/409 error
    ("Connect a WhatsApp number before managing templates") and SHALL NOT return
    500 or fall back to env.

### AC-7: Decrypt failure
14. WHEN `decrypt()` throws THEN the route SHALL return a clean error (e.g. 500
    "credential error") and SHALL NOT log or return the token or ciphertext.

### AC-8: Token-expired handling
15. WHEN Meta returns error code 190 / "Session has expired" on submit THEN the
    existing `META_TOKEN_EXPIRED` 401 response SHALL be preserved, and the same
    detection SHALL be applied in sync (and delete where sensible).

### AC-9: No new/floating dependencies
16. WHEN the change is implemented THEN no new dependency SHALL be added unless
    unavoidable, and any added dependency SHALL be pinned to an exact version.

### AC-10: No env reads remain in the three routes
17. WHEN the three route files are inspected after the change THEN `META_WABA_ID`
    and `META_ACCESS_TOKEN` SHALL NOT appear in any of them.

## Out of Scope

- Changing env usage in routes other than these three (e.g. webhook, send, connect).
- Embedded Signup / OAuth connect flow, token refresh, or billing/credits.
- UI changes beyond whatever error surfacing the "not connected" case requires.
- Resolving the open design questions above — those belong to the design phase.
- Removing the env vars from `.env` / `.env.example` (they may still be used elsewhere).

## Assumptions

- At least one of the open mapping strategies will be chosen in design; this
  document only requires that 0-connected and ambiguous-selection cases error
  clearly, not which strategy wins.
- The `WhatsAppNumber` "connected" state is `verificationStatus === "verified"`
  with a non-null stored `wabaId` and `accessToken`, consistent with the send route.
- Reusing the existing `Template.whatsappNumberId` column means no DB migration is
  needed; design will confirm.
