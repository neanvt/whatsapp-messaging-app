# Per-tenant Meta WABA credentials for template submit / sync / delete

The three template-management routes (`submit`, `sync`, delete in `[id]/route.ts`) no longer read the shared `META_WABA_ID` / `META_ACCESS_TOKEN` env pair. They now resolve `{ wabaId, accessToken }` from the signed-in tenant's own connected, verified `WhatsAppNumber` through a new sibling resolver `resolveWabaCredentials` in `src/lib/whatsapp.ts`, matching the `resolveSendCredentials` pattern already used by the send paths. The change implements the approved design revision 2 almost verbatim: the resolver shape, the submit precedence (`numberId` → template binding → sole usable number), the sync "iterate all deduped WABAs" strategy with source-number tagging, and the best-effort delete all land as specified. No schema change was made (reusing the existing `Template.whatsappNumberId` column), and the scratchpad is updated with the mapping decision, migrated endpoints, resolver, gotchas, env-var reclassification, and a dated change-log entry.

Watch for: the commit also tightened `resolveSendCredentials` to drop its env fallback (confirmed) — this is in scope for the broader SaaS migration (user message #9) but is outside the three template routes named in this task; it is a correct and intended change, flagged only for awareness. No blocking issues found.

**Verdict**: APPROVED

## High-level view

The resolver is a pure, synchronous WABA-level sibling to `resolveSendCredentials`: given a row with `wabaId`/`accessToken`, it returns the decrypted pair or nulls, with no env fallback and no logging. The DB lookup and ownership filter stay in each route where the session is available, so the resolver never needs Prisma or the session — the established pattern.

Multi-tenant isolation holds across all three routes. Every `whatsAppNumber` lookup is scoped by `userId: session.user.id` plus the `verified` + non-null `wabaId`/`accessToken` filter, and every Meta call uses only credentials decrypted from a row that passed that filter. There is no path by which a tenant can resolve another tenant's WABA.

The no-connected-number case returns a clean 4xx everywhere: submit returns 409 for zero usable numbers and 400 `AMBIGUOUS_NUMBER` for 2+ with none chosen; sync returns 409; delete silently skips the Meta call and still deletes locally. None of these is a 500, and none falls back to env.

A `decrypt()` throw is caught in submit and sync and converted to a 500 `{ error: "credential error" }` with only a generic `console.error` string logged — no token, no ciphertext. Delete treats the same throw as non-fatal (warn, skip Meta, delete locally), consistent with its best-effort contract.

The `META_TOKEN_EXPIRED` (code 190 / "Session has expired") branch is preserved verbatim in submit and newly applied per-WABA in sync; delete deliberately stays silent, which the design's "where sensible" qualifier covers. All preserved business logic — `buildComponents`, name sanitization, the 1024-char guard, the `status`/`metaTemplateId`/`submittedAt` write-back, status/category mapping, dedup, and Meta-only import — is byte-for-byte intact, with the only additive write being the `whatsappNumberId` binding on submit success and on import.

<details>
<summary>Issues (1)</summary>

1. **`resolveSendCredentials` env fallback removed (informational)** — the commit also strips the env fallback from the send resolver; this is correct for the SaaS migration and matches user decision #9, but it is outside the three routes this task scoped. No action required; noted so the planner is aware the send path's behavior changed in the same commit.

</details>

<details>
<summary>Details</summary>

### Resolver: a focused WABA-level sibling, single owner of template decrypt

`resolveWabaCredentials` accepts a row-shaped `{ wabaId, accessToken }` and returns the decrypted pair when both are non-null, else nulls (confirmed, `src/lib/whatsapp.ts`). This mirrors `resolveSendCredentials` exactly and keeps the resolver pure and synchronous. The decrypt call lives only here — none of the three route files contains its own `decrypt` (confirmed by reading all three diffs), satisfying AC-1. The function performs no `console.*`, so neither token nor ciphertext is logged at the resolver layer.

### Submit precedence and the additive binding

Submit reads both `sampleValues` and `numberId` from a single `request.json()` inside the existing try/catch (confirmed) — the design's warning about a second body read is heeded. Precedence is exactly as designed: explicit `numberId` (bad → 400 `NUMBER_NOT_CONNECTED`), then `template.whatsappNumberId` if still usable (stale binding falls through), then the sole usable number; 0 → 409, >1 → 400 `AMBIGUOUS_NUMBER` (confirmed). The 1024-char guard runs before credential resolution, so an over-long body still short-circuits as before (confirmed, AC-2 #4). On success the write-back binds `whatsappNumberId` to the resolved number only when the template was previously unbound — an additive write to an existing nullable column (confirmed). Name sanitization, `buildComponents`, the 190→401 branch, and the `status`/`metaTemplateId`/`submittedAt` write-back are unchanged (confirmed by reading the route body). The post-resolver null guard (null → 409) is unreachable given the query filter but kept for an explicit contract.

### Sync: iterate deduped WABAs, tag imports with source number

Sync queries all usable numbers for the tenant, returns 409 if none, then builds a `Map<wabaId, { numberId, accessToken }>` with first-number-wins-per-WABA (confirmed). A `decrypt()` throw while building the map aborts the whole sync with a 500 `credential error` and a generic log line — no partial state, no token logged (confirmed, AC-7). The null-creds branch is a defensive `continue`, with a trailing `wabaMap.size === 0 → 409` guard covering the all-skipped case.

The accumulator type was widened to `MetaTemplate[]` including the transient `__sourceNumberId` and initialized to `[]`, replacing the old inline-typed `= metaData.data ?? []` — this is the exact fix the design called out (confirmed). Each distinct WABA is fetched once; per-fetch errors surface a 190→401 `META_TOKEN_EXPIRED` or a 400 with the Meta message, aborting on the first failing WABA. Meta-only imports are `create`d with `whatsappNumberId: meta.__sourceNumberId` (confirmed), associating each imported template with its source number. The downstream status/category mapping, dedup, update loop, and `{ synced, updated, imported, duplicatesRemoved }` response shape are untouched.

### Delete: best-effort stays best-effort

Delete attempts the Meta call only when `metaTemplateId` is set, resolving the number from `whatsappNumberId` (if usable) else the sole usable number; 0 or ambiguous logs an info line and skips Meta (confirmed). A `decrypt()` throw is caught, warned (no token), and the Meta step skipped. The local `prisma.template.delete` always runs afterward, and the response is unchanged (confirmed, AC-4). The design explicitly scoped the pre-existing unencoded `template.name` interpolation in the DELETE query string as out of scope and instructed the implementer to leave it verbatim; the diff only changed the `wabaId`/`accessToken` source on that line, so that instruction was followed. 190 handling is intentionally silent here, which the design's "where sensible" qualifier permits.

### Schema and migration

No column was added — `Template.whatsappNumberId` already existed, so the task correctly ran no migration script and no `db push` (confirmed by the commit message and the absence of any `scripts/` change in the file list). This matches design §8 and the requirements' schema-reality constraint.

### Verification evidence

The commit message records `npm run build` (prisma generate && next build) exit 0 with a clean type-check, a grep showing 0 `META_WABA_ID`/`META_ACCESS_TOKEN` matches across the template routes, and a read-only Graph GET returning HTTP 200 (no template submitted or deleted). I independently re-ran only the env-read grep as a narrow spot-check — 0 matches, confirming AC-10. I did not re-run the build or any suite, per the coder-owns-verification rule.

</details>

<details>
<summary>File map</summary>

- `src/lib/whatsapp.ts` — adds `resolveWabaCredentials`; also drops the env fallback from `resolveSendCredentials` (in scope for the SaaS migration, outside the three routes).
- `src/app/api/templates/[id]/submit/route.ts` — per-tenant resolution with `numberId`/binding/sole-number precedence, 409/400 errors, decrypt→500, additive `whatsappNumberId` write-back.
- `src/app/api/templates/sync/route.ts` — per-tenant, iterates deduped WABAs, tags imports with source number, 190→401, decrypt→500.
- `src/app/api/templates/[id]/route.ts` — best-effort per-tenant Meta delete; always deletes locally.
- `src/app/dashboard/templates/new/page.tsx`, `src/app/dashboard/templates/[id]/page.tsx` — load connected verified numbers, show a selector for 2+, pass `numberId`.
- `scratchpad.md` — mapping decision, migrated endpoints, resolver, gotchas, env reclassification, dated change-log entry.

Full diff: `git -C /Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp show b00e2fce`

</details>
