# Public server-to-server (M2M) API with per-tenant API keys

A new `/api/v1` surface lets a third-party server send template messages, read message
status, and list templates using only a per-tenant API key (`Authorization: Bearer wa_live_...`),
never a Meta credential or number id. The key is bound to one verified `WhatsAppNumber` at
creation; the platform resolves the owner, the bound number, and the server-side Meta credentials
from the key. The risk center — the session send route — was refactored by extracting its body
verbatim into a shared `sendTemplateMessage`, so the dashboard path and the public path cannot
drift. Everything else (ApiKey model + migration, auth helper, management routes, dashboard page,
docs) is additive beside the existing session world.

Watch for: nothing blocking. Secret handling, tenant/number isolation, the no-oracle 404, the
402→400 session remap, and the credit-symmetry contract all verified in code. `npm run build` and
`npm run lint` both pass (re-run during this review). (confirmed)

**Verdict**: APPROVED

## High-level view

The ApiKey model and its libSQL migration match the design one-to-one: `keyHash @unique`,
`@@index([userId])`, nullable `name`/`lastUsedAt`/`revokedAt`, cascade relations, and three
`IF NOT EXISTS` DDL statements run unconditionally so a re-run is a clean no-op. The live run was
recorded in FEAT-001 and the index names follow Prisma convention.

Secret handling is correct at every layer: only the SHA-256 `keyHash` and a non-secret `keyPrefix`
persist, the plaintext is returned exactly once from `POST /api/api-keys` and never stored or
re-read, and no route or helper logs the token or hash. The auth helper rejects every failure mode
(missing/malformed header, wrong shape with no DB hit, unknown key, revoked key, vanished bound
number) as a uniform 401, uses a constant-time hash compare as defense in depth, and updates
`lastUsedAt` fire-and-forget.

The shared send core was lifted byte-for-byte from the old session route — same OTP guard,
credit check/deduct, null-credential branch with the identical "not connected" string, `#131008`
auth-template URL button, Meta fetch, and refund-on-failure. The one deliberate asymmetry is the
helper returning 402 for insufficient credits, which the session wrapper remaps to its legacy 400;
the public route surfaces 402 verbatim. `isSuperAdmin` is computed once by each caller and threaded
through check/deduct/refund, and the public route derives it via the email-driven `isSuperAdminUser`
predicate rather than the raw DB role (which is never `superadmin`).

The three public routes are API-key-only, accept no client number or credential (the send always
uses `ctx.number`), split template not-found (404) from not-approved (400), scope message status to
both owner and bound number with an identical 404 that is no existence oracle, and validate the
optional `?status` filter. The management routes are session-only, scope every query to
`session.user.id`, return a cross-user 404 on revoke, and are idempotent. The dashboard page, sidebar
link, docs M2M section, and the corrected "no API-key scheme" note are all present.

<details>
<summary>Issues (0)</summary>

No blocking or actionable issues. Two non-blocking notes are recorded in the details below
(pre-existing lint warnings outside this task's scope; verbatim-inherited Meta payload logging).

</details>

<details>
<summary>Details</summary>

### ApiKey model + migration

The Prisma model declares `keyHash @unique` and `@@index([userId])` with no redundant
`@@index([keyHash])`, matching the migration which creates exactly `ApiKey_keyHash_key` (unique)
and `ApiKey_userId_idx`. Nullable columns (`name`, `lastUsedAt`, `revokedAt`) are `TEXT` without
`NOT NULL`; timestamps carry no SQL default (Prisma supplies them). The script runs a single
`PRAGMA table_info(ApiKey)` only to pick the log line, then runs all three `IF NOT EXISTS` DDL
statements unconditionally, so a second run is a clean no-op regardless of partial prior state —
AC1 holds. FEAT-001 recorded a live double-run (created, then "already exists") and a PRAGMA check
confirming the 10 columns and both indexes.

### Secret handling — SHA-256 only, one-time reveal

`generateApiKey` produces `wa_live_` + base64url(32 random bytes) and returns `{ plaintext, hash,
prefix }`; only `hash` and `prefix` are persisted. The create route's `select` allow-list omits
`keyHash`, and the 201 body is the projection plus `key: plaintext` — the only place the plaintext
appears. Every later `GET` returns the same projection without `key` or `keyHash`. A codebase grep
shows `keyHash` only as a Prisma where/compare field and in comments; the token and hash are never
logged in the auth helper, the send helper, or any `/api/v1` / `/api/api-keys` route. NFR1 / AC3 /
AC16 confirmed.

### Auth helper — uniform 401, constant-time compare

`authenticateApiKey` returns `null` for every failure (missing/malformed `Bearer`, non-`wa_live_`
shape with no DB hit, unknown hash, `revokedAt` set, vanished bound number), and each route maps
`null` to the shared `unauthorized()` 401 — no oracle distinguishes the causes. It computes
`sha256(token)`, looks the row up by the unique `keyHash`, then does an equal-length
`timingSafeEqual` as defense in depth, and dispatches a fire-and-forget `lastUsedAt` update whose
failure cannot fail the request. AC12 / AC13 / FR2.* confirmed.

### Shared send core — parity with the session route

`sendTemplateMessage` is the former `POST /api/messages/send` body verbatim: OTP guard before any
row/credit mutation; credits check (now 402); message create (`queued`); deduct; `resolveSendCredentials`
in try/catch → nulls; null-credential branch setting `failed` with the identical "WhatsApp number
is not connected. Reconnect it to send messages." string; `#131008` auth-template copy-code URL
button keyed on `variables?.[0]`; Meta fetch to the v19.0 Graph endpoint; refund-on-failure gated on
the same `isSuperAdmin` boolean. The session wrapper reproduces every observable detail (the four
input 400s, number/template 400s, OTP 400 still first, insufficient-credits 400 via the 402→400
remap, 500-with-refund on failure, and the `{ id, status:"sent", message:"Message sent successfully" }`
success body). The 402→400 remap is the only behavioral delta. NFR6 / AC15 confirmed by diffing the
base-branch route against the extracted helper.

`isSuperAdmin` is computed once per caller and passed in; the helper never re-derives it, keeping
deduct and refund symmetric. The public route computes it via `isSuperAdminUser({ email, role })`,
which mirrors the email-driven JWT rule (`SUPERADMIN_EMAIL || "neanvtech@gmail.com"` OR
`role === "superadmin"`) — necessary because the DB `role` column is never `superadmin`, so a raw
role check would wrongly charge the superadmin. AC8 confirmed.

### Public /api/v1 routes — isolation and no client credentials

`POST /api/v1/messages` authenticates by key only, validates the body with a zod XOR refine (both or
neither of `templateName`/`templateId` → 400), accepts no number/credential field, and always sends
through `ctx.number`. Template resolution is owner-scoped: no matching owner row → 404, a matching
row with `status !== "approved"` → 400. The owner lookup feeds `isSuperAdminUser` once, and the
helper's code is surfaced verbatim (402 credits, 500 not-connected/Meta, 400 missing OTP).
`GET /api/v1/messages/[id]` scopes to both `userId` and the bound `whatsappNumberId` with a single
`findFirst`, so a non-matching id returns the identical `404 {"error":"Not found"}` whether it does
not exist or belongs to another tenant/number — no existence oracle, and the path id is never
logged. `GET /api/v1/templates` is scoped to `ctx.userId`, validates the optional `?status` against
the known set (400 on unknown), and uses a non-credential `select` allow-list. AC6 / AC7 / AC9 /
AC10 / AC11 confirmed.

### Management routes + UI + docs

`GET/POST /api/api-keys` and `DELETE /api/api-keys/[id]` are session-only, scoped to
`session.user.id`. Create verifies the number is verified+owned (400 otherwise) and returns the
one-time plaintext; list uses an allow-list without `keyHash`; revoke returns 404 for an absent or
other-user key (never cross-user revocable) and is idempotent on an already-revoked key. The
dashboard page (`/dashboard/api-keys`) renders the key list, a create form with a verified-number
selector, the one-time reveal callout with a copy button and the "shown once" warning, and a revoke
confirm; it is mobile-responsive (`grid-cols-1 sm:grid-cols-2`). The sidebar gains the "API Keys"
`KeyRound` link, and the docs page adds the "Connect a third-party application" section (bearer
scheme, zero-credential guarantee, the three endpoints with curl + real status codes) and corrects
the stale "no programmatic API-key scheme" callout to point at `/api/v1`. AC4 / AC5 / AC13 / AC14 /
AC17 / FR5.3 confirmed.

### Build and lint gate

`npm run build` (`prisma generate && next build`) exits 0 with all three `/api/v1` routes, both
management routes, and `/dashboard/api-keys` compiled. `npm run lint` exits 0 (an `.eslintrc.json`
was added so the gate is runnable), with two pre-existing `react-hooks/exhaustive-deps` **warnings**
in `dashboard/numbers/[id]/page.tsx` and `dashboard/templates/[id]/page.tsx` — non-blocking and not
introduced by this task's logic. AC18 confirmed.

### Non-blocking notes

The shared send helper logs the full Meta payload (`[Meta] Sending message:` with the normalized
recipient and template variables, which for auth templates include the OTP) — but not the access
token, which lives in the fetch headers, not the payload. This logging is inherited verbatim from
the pre-existing session route and is out of scope for this task; flagged only for awareness, not as
a regression. (confirmed)

</details>

<details>
<summary>File map</summary>

- `prisma/schema.prisma` — ApiKey model + inverse relations on User/WhatsAppNumber.
- `scripts/add-api-key-table.mjs` — idempotent libSQL migration (table + two indexes).
- `src/lib/api-key.ts` — pure key gen/hash/shape + `isSuperAdminUser` predicate.
- `src/lib/api-auth.ts` — `authenticateApiKey` + `unauthorized()`.
- `src/lib/send-template.ts` — shared `sendTemplateMessage` send core.
- `src/app/api/messages/send/route.ts` — session route rewritten as a thin wrapper (402→400 remap).
- `src/app/api/v1/messages/route.ts` — public POST template send.
- `src/app/api/v1/messages/[id]/route.ts` — public GET message status (no oracle).
- `src/app/api/v1/templates/route.ts` — public GET template list.
- `src/app/api/api-keys/route.ts` — session GET list + POST create (one-time reveal).
- `src/app/api/api-keys/[id]/route.ts` — session DELETE revoke (cross-user 404, idempotent).
- `src/app/dashboard/api-keys/page.tsx` — management UI.
- `src/components/dashboard/sidebar.tsx` — "API Keys" nav link.
- `src/app/docs/page.tsx` — M2M section + corrected note.
- `.eslintrc.json` — adds the lint config so the gate is runnable.

Full diff: `git diff aa334f9 HEAD`.

</details>
