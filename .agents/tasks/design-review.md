# Design Review — Per-Tenant Credentials for Template-Management Routes (revision 2)

Reviewed: `.agents/tasks/design.md` (revision 2)
Against: `.agents/tasks/requirements.md`
Repo root: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp`
Review date: 2025-02-14

This review was done fresh, reading the live code to verify every assumption the
design makes about existing files. The design is a revision that claims to resolve
a prior review's 1 HIGH / 2 MEDIUM / 3 NIT findings. I re-verified those claims
against the current code and checked for new gaps.

---

## Verdict basis

Count of HIGH + MEDIUM findings below determines the verdict. See the JSON for the
mechanical result.

---

## Verified Assumptions

These design claims were checked against live source and are **correct**:

1. **`resolveSendCredentials` shape and semantics** (`src/lib/whatsapp.ts`): takes a
   row-shaped `{ phoneNumberId, accessToken }`, returns nulls when either is null,
   else `{ phoneNumberId, accessToken: decrypt(accessToken) }`, no env fallback, no
   logging. The design's `resolveWabaCredentials` is a faithful WABA-level sibling.
   ✔
2. **`decrypt()` behavior** (`src/lib/crypto.ts`): throws `"Invalid ciphertext
   format"` on malformed input (segments ≠ 3) and throws via `decipher.final()` on
   tampered ciphertext / bad key; `getKey()` throws when `ENCRYPTION_KEY` is
   missing/not 32-byte base64. Neither `encrypt` nor `decrypt` logs its inputs. The
   design's "decrypt may throw → caller catches → 500 credential error, no secret
   logged" is accurate. ✔
3. **Schema reality** (`prisma/schema.prisma`): `Template.whatsappNumberId String?`
   plus `whatsappNumber WhatsAppNumber?` relation already exist; `WhatsAppNumber`
   carries `wabaId String?`, `phoneNumberId String?`, `accessToken String?`
   (ciphertext), `verificationStatus String @default("pending")`. No new column is
   needed. ✔ (design §8 correct)
4. **`db push` constraint**: the design correctly states no schema change and no
   migration script are required, and the `@libsql/client` fallback pattern exists
   (`scripts/add-meta-onboarding-columns.mjs` is present). ✔
5. **Submit route current state** (`src/app/api/templates/[id]/submit/route.ts`):
   reads `process.env.META_WABA_ID` + `META_ACCESS_TOKEN`; has the 1024-char guard
   *before* the Meta call; builds `metaTemplateName` with the exact
   lowercase/underscore sanitization quoted in the design; the `META_TOKEN_EXPIRED`
   branch keys on `metaData.error?.code === 190 || message.includes("Session has
   expired")` → 401; success write-back sets `status/metaTemplateId/submittedAt`.
   The status gate allows `draft` **or** `rejected`. All match the design. ✔
6. **Submit body is read with a single `await request.json()`** inside a
   `try/catch` that currently reads only `sampleValues`. The design's finding-2 fix
   (read `numberId` from the *same* `reqBody`, never a second `request.json()`) is
   correct and necessary. ✔
7. **Sync route current state** (`src/app/api/templates/sync/route.ts`): zero-param
   `POST()`, reads the env pair, `metaTemplates` is declared with a fixed inline
   element type and initialized `= metaData.data ?? []`, `byId`/`byName` lookups,
   dedup-by-sanitized-name, update loop, Meta-only import `create` with
   `satisfies Prisma.TemplateUncheckedCreateInput` and `userId: session.user.id`,
   response `{ synced, updated, imported, duplicatesRemoved }`. The design's
   finding-1 fix (widen to `MetaTemplate[]` with `__sourceNumberId`, init `= []`,
   push per-WABA) is correct, and adding `whatsappNumberId` to the import `create`
   keeps `satisfies Prisma.TemplateUncheckedCreateInput` valid because the column is
   real. ✔
8. **Delete route current state** (`src/app/api/templates/[id]/route.ts`): guard is
   `template.metaTemplateId && env.META_WABA_ID && env.META_ACCESS_TOKEN`, the Meta
   `DELETE` uses `?hsm_id=...&name=${template.name}` (unencoded `name`) with
   `.catch(...)`, never awaits/inspects the response, then always runs
   `prisma.template.delete`. The design's best-effort rewire and the finding-6
   scope note (unencoded `name` is pre-existing, leave as-is) match reality. ✔
9. **Frontend call shapes**: `src/app/dashboard/templates/new/page.tsx` and
   `.../[id]/page.tsx` POST submit with `JSON.stringify({ sampleValues })` and no
   `numberId`; `src/app/dashboard/templates/page.tsx` calls
   `fetch("/api/templates/sync", { method: "POST" })` with no body. The design's
   "single-number tenant needs no frontend change; multi-number needs optional
   `numberId`" is grounded in the real contract. ✔
10. **Send route divergence claim**: `src/app/api/messages/send/route.ts` requires
    an explicit `numberId` and never auto-picks. The design's finding-5 correction
    (template auto-resolution does *not* mirror the send route) is accurate. ✔

## Unverified / Wrong Assumptions

None. Every claim the design makes about existing code was checkable and checked
out. The resolver, crypto, schema, three route bodies, migration-script pattern,
and frontend call shapes are all as the design describes.

---

## Findings

### 1. NIT — Delete decrypt-throw log level is `console.warn` but §10 says "the only log is a fixed string"; cross-check wording, not a defect

In §7 step 2 the delete decrypt-throw path logs
`console.warn("[Template delete] credential error — skipping Meta delete")`, which
is fine (fixed string, no secret). §10 ("Decrypt throw … the only log is a fixed
string with no secret") is consistent. No actual conflict; the wording is coherent.
Recorded as a NIT only to note that the delete log uses `warn` while submit/sync
use `error` — intentional and acceptable given delete is non-fatal.

**Fix (optional):** none required. If uniformity is wanted, keep `warn` for delete
(non-fatal) and `error` for submit/sync (fatal) as currently specified — the
distinction is meaningful.

### 2. NIT — Submit §4.3 precedence vs §4.1 resolution order: explicit-binding ordering differs between the two sections

§4.1 (general "submit & delete" order) lists: (1) template's `whatsappNumberId`,
(2) user's connected numbers (0/1/>1). §4.3 (submit-specific) lists: (1) body
`numberId`, (2) `template.whatsappNumberId`, (3) single usable number, (4)
0→409 / >1→400. §5 step 6 follows the §4.3 order. The two orderings are reconcilable
(§4.3 simply prepends the body `numberId` for submit), but a reader could briefly
read §4.1 as authoritative for submit.

**Fix:** add one sentence to §4.1 noting "submit additionally accepts a body
`numberId` that takes precedence over the template binding — see §4.3", so the
precedence has a single authoritative statement.

### 3. NIT — Sync token-expired "abort on first failing WABA" leaves earlier WABAs' templates un-reconciled, but no partial-write risk is called out explicitly

§6.2 step 3 aborts sync on the first non-ok WABA (401 for 190, 400 otherwise). The
design correctly notes this is "consistent with current single-WABA behavior" and
no DB writes happen before the fetch loop completes (dedup/update/import all run
*after* `metaTemplates` is fully populated). So an abort mid-loop performs no
partial reconciliation — good. This is only a NIT because the design asserts
"Sync aborts … rather than silently importing a partial set" without explicitly
stating that **no DB mutation has occurred yet** at abort time, which is the actual
guarantee that makes the abort safe.

**Fix:** add a half-sentence to §6.2 step 3: "No local writes have occurred at this
point (dedup/update/import run only after the fetch loop), so an abort leaves the DB
untouched." This verifies against the live code: in the current route all mutations
(`deleteMany`, update loop, import loop) occur strictly after the Meta fetch, and
the redesigned loop keeps that ordering.

---

## Notes on the prior review's HIGH/MEDIUM findings (re-verification)

- **Prior HIGH #1 (sync `metaTemplates` type/initializer):** the redesign's
  §6.2/§6.3 widen the element type to `MetaTemplate` (with `__sourceNumberId:
  string`) and initialize `= []`, pushing per-WABA. Verified this is required by the
  live code (which uses the fixed inline type + `= metaData.data ?? []`) and that
  the fix is type-correct. **Resolved.**
- **Prior MEDIUM #2 (submit single-body-read):** verified the live submit reads the
  body once; the redesign reads both `sampleValues` and `numberId` from that one
  `reqBody`. **Resolved.**
- **Prior MEDIUM #3 (sync `wabaMap` shape / decrypt-throw vs null):** the redesign
  specifies `Map<string, { numberId, accessToken }>`, first-wins, decrypt-throw →
  500, null → defensive `continue`, trailing `size === 0 → 409`. Complete and
  internally consistent. **Resolved.**
- **Prior NITs #4/#5/#6:** all addressed in the body (distinct
  `NUMBER_NOT_CONNECTED`, corrected send-route wording, unencoded-`name` scope note).

All previously blocking findings are genuinely resolved in code-verifiable ways.

---

## Requirement coverage check

- FR-1 / AC-1 (shared resolver, no decrypt in routes): §3 — met.
- FR-2 / AC-2 (submit per-tenant, logic preserved): §5 — met, ordering of 1024
  guard before resolution preserved.
- FR-3 / AC-3 (sync per-tenant, fetch-all-WABAs, mapping/dedup/import unchanged,
  response shape): §6 — met.
- FR-4 / AC-4 (delete best-effort, local delete always runs): §7 — met.
- FR-5 / AC-5 (ownership scoping on every query + Meta call): §9 — met; every
  `WhatsAppNumber` candidate lookup carries `userId` filter.
- FR-6 / AC-10 (no env reads in the three routes): §13 + §9 — met.
- FR-7 / AC-6 (not-connected → clear 4xx, never 500/env): §4.2, §6.2, §4.3 — met
  (submit 409, sync 409, delete skips).
- FR-8 / AC-7 (decrypt-throw clean error, no secret logged): §7-note, §6.2, §5.1 —
  met.
- FR-9 / AC-8 (190 preserved in submit, applied in sync, sensible in delete): §5
  step 10, §6.2 step 3, §7.1 — met.
- FR-10 (no regressions): preserved logic enumerated per route — met.
- NFR / AC-9 (no new deps): §2 — met.

No requirement is left unaddressed, and no scope creep beyond requirements was found
(the optional frontend `numberId` selector is explicitly marked additive/optional
and traces to the ambiguity requirement, not new scope).

---

## Summary

The revision is concrete, internally consistent, and every assumption about existing
code is verified correct. The mapping decision (explicit `numberId` → template
binding → sole number → 409/400), multi-tenant isolation, the 4xx not-connected
paths, the decrypt-throw handling (no secret logged), the 190 preservation, and the
resolver signature/return/behavior are all fully specified. Schema reality is
correct and no migration is needed.

Only three NIT-level clarity items remain; none blocks implementation. Zero HIGH and
zero MEDIUM findings.
