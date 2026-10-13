# Requirements — Public server-to-server (M2M) API with per-tenant API keys

Last updated: 2026-10-13 (FR3.1.2/FR3.1.4 clarified: template resolved by exactly one of `templateName`/`templateId`)

## Summary

Today every route handler authenticates with the NextAuth **session cookie** (a human logged into the dashboard via `getServerSession(authOptions)`). A third-party **server** cannot present a cookie, so there is no way for an external application to send WhatsApp messages or read data through this platform programmatically.

This feature adds a **machine-to-machine (M2M) public API** under `/api/v1`, authenticated by **per-tenant API keys** (`Authorization: Bearer wa_live_xxx`). A tenant issues a key from the dashboard, binds it to exactly one of their connected `WhatsAppNumber` records, and pastes **only** that key plus the platform base URL into their third-party app. The platform resolves the tenant and number from the key, fills in the Meta `phoneNumberId` + decrypted access token **server-side** (reusing the existing per-tenant send logic), and calls the Meta Cloud API. The third party **never** handles a Meta Phone Number ID, WABA ID, access token, or any Facebook credential.

Scope of the public API is three operations only: send a **template** message, check a **message status** by id, and **list templates**. No free-text send, no conversations.

The dashboard gains an API-key management surface (list / create / revoke) guarded by the existing session auth, and the developer docs page gets an M2M section.

### Verified architecture this builds on

- **Session auth**: `getServerSession(authOptions)` from `@/lib/auth`; `session.user.id`, `session.user.role` (`"admin"` | `"superadmin"`).
- **DB client**: `prisma` default export from `@/lib/db` (Prisma 5.x + libSQL/Turso adapter).
- **Crypto**: `src/lib/crypto.ts` — AES-256-GCM via `ENCRYPTION_KEY` (32-byte base64), lazy key resolution, `encrypt`/`decrypt`, never logs inputs.
- **Send credential resolution**: `resolveSendCredentials(number)` in `src/lib/whatsapp.ts` returns `{ phoneNumberId, accessToken }` decrypted, or `{ null, null }` when the number has no stored creds; `serializeNumber` strips `accessToken`.
- **Existing template send**: `POST src/app/api/messages/send/route.ts` — the authoritative send path including the `#131008` auth-template handling, credit deduct/refund, and superadmin exemption.
- **Templates list**: `GET src/app/api/templates/route.ts` (session-scoped by `userId`).
- **Messages list**: `GET src/app/api/messages/route.ts`.
- **Webhook**: `src/app/api/webhooks/whatsapp/route.ts` updates message status by Meta message id.
- **Migration pattern**: `scripts/add-tenant-meta-app-table.mjs` — idempotent `@libsql/client` script, manual `.env` parse, `CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, `process.exit(1)` on error, `client.close()` in `finally`. (`prisma db push` cannot connect over `libsql://`.)
- **Models**: `User`, `WhatsAppNumber`, `Template`, `Message`, `UserCredits` as defined in `prisma/schema.prisma`.
- **Dashboard nav**: `src/components/dashboard/sidebar.tsx`; settings at `src/app/dashboard/settings/page.tsx`; docs at `src/app/docs/page.tsx`.
- **Stack**: Next.js 14 App Router, TypeScript, Prisma 5.x + libSQL/Turso, Tailwind, zod already a dependency. Prefer **zero new deps** — Node `crypto` suffices.

### Assumptions (flagged for the design review)

- **A1 — Key format**: keys are issued as `wa_live_<base64url-random>` where the random portion carries ≥256 bits of entropy (32 bytes) from `crypto.randomBytes`. The `wa_live_` prefix is a human-readable, non-secret label; the full string is the secret.
- **A2 — Lookup strategy**: because only the SHA-256 hash is stored (never plaintext) and SHA-256 is deterministic with no per-key salt, the server computes `sha256(presentedKey)` and looks the row up by that hash column directly (unique indexed). A short non-secret prefix (e.g. first 8 chars) is stored separately only for display/identification in the dashboard list. Hash comparison uses a constant-time compare as defense in depth.
- **A3 — Credit model**: a public template send consumes **1 credit** and refunds on failure, identical to the session send path; the superadmin exemption still applies if the key's owner is a superadmin.
- **A4 — Message status response**: `GET /api/v1/messages/{id}` returns the platform `Message.id`, `status`, `recipientPhone`, `metaMessageId`, and timestamps — never a Meta credential.
- **A5 — Number binding is immutable**: the bound number is fixed at key-creation time and cannot be changed; to retarget, revoke and create a new key.
- **A6 — No `/api/v1` under session auth**: public routes accept **only** API-key auth and never fall back to a session cookie; management routes under `/api/api-keys` accept **only** session auth.
- **A7 — Plaintext shown once**: the full key is returned exactly once in the create response and never retrievable again.

## Functional Requirements

### FR1 — ApiKey data model and migration

- FR1.1 Add an `ApiKey` Prisma model to `prisma/schema.prisma` with at least: `id`, `userId` (owner), `whatsappNumberId` (bound number), `name`/`label` (tenant-chosen display name), `keyHash` (SHA-256 hex of the full key, **unique**), `keyPrefix` (short non-secret display fragment), `lastUsedAt` (nullable), `revokedAt` (nullable), `createdAt`, `updatedAt`.
- FR1.2 The model relates to `User` (`onDelete: Cascade`) and `WhatsAppNumber`, consistent with existing relations. (No DB-level FK enforcement in libSQL; cascade is enforced by the Prisma client as elsewhere.)
- FR1.3 `keyHash` has a unique index. A non-unique index on `userId` supports the dashboard list query.
- FR1.4 Provide an idempotent `@libsql/client` migration script under `scripts/` (e.g. `scripts/add-api-key-table.mjs`) that mirrors `scripts/add-tenant-meta-app-table.mjs`: manual `.env` parse, `CREATE TABLE IF NOT EXISTS ApiKey (...)`, `CREATE UNIQUE INDEX IF NOT EXISTS` on `keyHash`, `process.exit(1)` on error, `client.close()` in `finally`, clean no-op on a second run. Timestamps are plain `TEXT` with no SQL default (Prisma supplies `@default(now())` / `@updatedAt`).
- FR1.5 The schema change is applied **only** via the migration script; `prisma db push` is not used against the live DB.
- FR1.6 The plaintext key is **never** stored in any column; only `keyHash` (and the non-secret `keyPrefix`) persist.

### FR2 — API-key auth helper

- FR2.1 Add `authenticateApiKey(request)` (e.g. in `src/lib/api-key.ts`) that extracts the bearer token from the `Authorization` header, computes its SHA-256 hash, looks up the matching non-revoked `ApiKey` row, and returns the resolved context: `{ apiKey, user, number }` (or an auth failure).
- FR2.2 The helper rejects (as an auth failure that callers turn into **401**) when: the header is absent/malformed, the token does not match the `wa_live_` shape, no row matches the hash, or the matched row has `revokedAt` set.
- FR2.3 Hash comparison between the computed hash and the stored hash uses a **constant-time** compare (`crypto.timingSafeEqual`), guarding against timing side channels even though lookup is by indexed hash.
- FR2.4 The helper (and all callers) **never** log the plaintext key or the hash. On success it resolves the owning `userId`, the bound `whatsappNumberId`, and the `WhatsAppNumber` record for downstream credential resolution.
- FR2.5 On success the helper updates `lastUsedAt` (best-effort; a failure to update must not block the request).
- FR2.6 Key generation lives alongside the helper (e.g. `generateApiKey()`): produce a high-entropy key via Node `crypto.randomBytes`, format it `wa_live_<...>`, and return `{ plaintext, hash, prefix }`.

### FR3 — Public `/api/v1` endpoints (API-key auth only)

- FR3.1 **`POST /api/v1/messages`** — send a template message.
  - FR3.1.1 Authenticated **only** by `authenticateApiKey`; no session fallback.
  - FR3.1.2 Request body: `recipient` (string, required), **exactly one of** `templateName` (string) or `templateId` (string) (sending both or neither is a 400), `variables` (string array, optional). The body **does not** accept `numberId`/`phoneNumberId`; the send always uses the key's **bound** number. (Updated 2026-10-13 per design-review finding 1 and the step task prompt, which mandates `{recipient, templateName|templateId, variables?}`: a third party integrating by human-readable template name should not have to look up the platform's internal template id first, so `templateName` is a first-class resolution key alongside `templateId`.)
  - FR3.1.3 Resolve the bound `WhatsAppNumber`, verify it is `verified` and owned by the key's `userId`.
  - FR3.1.4 Resolve the template by the supplied key — `templateId` **or** `templateName` (whichever was provided) — scoped to the key's `userId` and status `approved`.
  - FR3.1.5 Reuse the existing per-tenant send logic (same Meta payload build, `#131008` auth-template button handling, credit deduct/refund, superadmin exemption, message record lifecycle) as `POST /api/messages/send`. The shared behavior must be factored so both routes stay in lockstep (a shared send function or equivalent), without regressing the session route.
  - FR3.1.6 On success, respond with the created `Message.id` and `status` (shape consistent with the session send response). On Meta failure, refund the credit and return an error status.
- FR3.2 **`GET /api/v1/messages/{id}`** — message status.
  - FR3.2.1 Authenticated **only** by `authenticateApiKey`.
  - FR3.2.2 Look up the `Message` by `id` scoped to the key's `userId` **and** the key's bound `whatsappNumberId`. A message that exists but belongs to another user or another number is treated as not found (**404**).
  - FR3.2.3 Response contains the platform message id, `status`, `recipientPhone`, `metaMessageId`, and relevant timestamps (`sentAt`/`deliveredAt`/`readAt`/`createdAt`), `errorMessage` when failed. Never returns a Meta credential.
- FR3.3 **`GET /api/v1/templates`** — list templates.
  - FR3.3.1 Authenticated **only** by `authenticateApiKey`.
  - FR3.3.2 Returns templates scoped to the key's `userId`. Design review to decide whether to additionally filter to the bound number's templates or to `approved` only (default proposal: return the tenant's templates with their `status`, so the third party can see which are usable).
  - FR3.3.3 The response excludes anything credential-bearing (templates carry no credentials, but the response must not leak other tenants' data).

### FR4 — Dashboard key management (session auth only)

- FR4.1 **`GET /api/api-keys`** — list the current user's keys. Session-guarded; scoped to `session.user.id`. Returns non-secret fields only: `id`, `name`, `keyPrefix`, bound number (id + display), `lastUsedAt`, `revokedAt`, `createdAt`. **Never** returns `keyHash` or any plaintext.
- FR4.2 **`POST /api/api-keys`** — create a key. Session-guarded. Body: `name` (string, required) and `numberId` (string, required, must be a `verified` number owned by `session.user.id`). Generates the key, stores only the hash + prefix bound to that number, and returns the **plaintext key exactly once** in the response along with the stored metadata.
- FR4.3 **`DELETE /api/api-keys/{id}`** (or `POST .../revoke`) — revoke a key. Session-guarded; the key must belong to `session.user.id` (a key owned by another user is **404**/**403**, never revocable). Revocation sets `revokedAt`; the key immediately stops authenticating on `/api/v1`.
- FR4.4 A dashboard UI surface (a Settings tab/section or a dedicated page reachable from the sidebar) lists keys, creates a key (with a number selector limited to the user's verified numbers), shows the plaintext **once** with a copy affordance and a warning that it will not be shown again, and revokes a key. The UI is mobile-responsive consistent with the existing dashboard layout.

### FR5 — Developer documentation

- FR5.1 Update `src/app/docs/page.tsx` with an M2M / public API section describing: how to create a key in the dashboard, the `Authorization: Bearer wa_live_xxx` scheme, that the third party supplies **zero** Meta credentials and **zero** number info (the key is bound to a number), and that each key acts only for its owner's data.
- FR5.2 Document the three endpoints (method, path, auth, request body, success shape, and the real status codes the handlers return), with curl examples using the bearer header.
- FR5.3 Correct/augment the existing "no programmatic API-key scheme" note so it no longer claims cookies are the only option for programmatic access.

## Non-Functional Requirements

- NFR1 **Security — secret handling**: store only the SHA-256 hash of a key; never persist, return (after creation), or log the plaintext key or its hash. The `keyPrefix` stored for display is a non-secret fragment only.
- NFR2 **Security — constant-time compare**: hash equality uses `crypto.timingSafeEqual`.
- NFR3 **Security — entropy**: keys carry ≥256 bits of entropy from `crypto.randomBytes`.
- NFR4 **Multi-tenant isolation**: a key can read/act **only** on records owned by its `userId` and, for sends/status, only through/for its bound `whatsappNumberId`. No endpoint allows crossing tenant or number boundaries.
- NFR5 **No new dependencies** unless the design review justifies one; Node `crypto` and existing libraries (zod) are expected to suffice.
- NFR6 **No regression** of: the session send route (`POST /api/messages/send`), the `#131008` auth-template handling, credit deduct/refund, and the superadmin exemption.
- NFR7 **Migration discipline**: DB changes applied only via the idempotent `@libsql/client` script; safe to re-run.
- NFR8 **Input validation**: validate public request bodies (prefer zod, matching the project's manual-connect route style) and return 400 on malformed input before any side effect.

## Acceptance Criteria

1. Running the new migration script creates the `ApiKey` table and its unique `keyHash` index; running it a second time is a clean no-op and exits 0.
2. The `ApiKey` Prisma model exists with `keyHash` unique, a `userId` index, `whatsappNumberId` binding, `revokedAt`/`lastUsedAt` nullable, and timestamps; `prisma generate` (via `npm run build`) succeeds.
3. Creating a key via `POST /api/api-keys` (as a logged-in user) returns a `wa_live_...` plaintext **once**, and the database stores only its SHA-256 hash plus a non-secret prefix — no column contains the plaintext.
4. `GET /api/api-keys` returns the caller's keys with no `keyHash` and no plaintext, scoped to the caller's `userId`; it never lists another user's keys.
5. `POST /api/api-keys` rejects a `numberId` that is not a `verified` number owned by the caller (400/404), and the created key is bound to the supplied number.
6. `POST /api/v1/messages` with a valid key, a `recipient`, an `approved` template owned by the key's user, and sufficient credits sends via Meta using the **bound** number's server-side credentials and returns the created message id + status; the third party supplied no number/credential field.
7. `POST /api/v1/messages` for an `authentication`-category template without the OTP as `variables[0]` is rejected with **400** before any message row or credit change, and when the OTP is present the Meta payload includes the copy-code URL button (no `#131008`), matching the session route behavior.
8. A public send that fails at Meta marks the message `failed` and **refunds** the credit; a send by a superadmin-owned key deducts/refunds nothing (exemption preserved).
9. `POST /api/v1/messages` with **insufficient credits** (non-superadmin, balance ≤ 0) is rejected before contacting Meta with a credits error (**402 or 403** — final code chosen in design), and no message is sent.
10. `GET /api/v1/messages/{id}` with a valid key returns the status of a message owned by the key's user and bound number; a message id belonging to another user or another number returns **404**.
11. `GET /api/v1/templates` with a valid key returns only the key owner's templates and never another tenant's templates or any credential.
12. Any `/api/v1` request with a **missing/malformed** `Authorization` header, a key that does not match the `wa_live_` shape, an unknown key, or a **revoked** key returns **401** and performs no action.
13. Revoking a key via the management endpoint sets `revokedAt`; a subsequent `/api/v1` call with that key returns **401** immediately.
14. A key owned by user A cannot be revoked by user B (B's attempt returns 403/404), and user A's key cannot send from or read user B's number/messages/templates.
15. The session send route, templates list, and messages list continue to work for dashboard (cookie) users exactly as before (no regression).
16. Grepping the codebase and server logs shows no plaintext key or `keyHash` value is logged by the auth helper or any `/api/v1` or `/api/api-keys` route.
17. The docs page (`/docs`) renders an M2M section documenting the three endpoints, the bearer scheme, the zero-credential guarantee, and the number-binding behavior.
18. `npm run build` (`prisma generate && next build`) and `npm run lint` pass with the changes in place.

## Edge Cases

- Missing/empty `Authorization` header on `/api/v1` → 401.
- `Authorization` present but not `Bearer `-prefixed, or token not matching `wa_live_` shape → 401 (no DB lookup side effects beyond the hash compare).
- Valid-shaped but unknown key (no hash match) → 401.
- Revoked key (`revokedAt` set) → 401.
- Valid key but bound number was later unverified/disconnected (no stored creds) → send fails cleanly with a "not connected" error and the credit is refunded (mirrors the session route's null-credential branch); no plaintext/credential leaks.
- Public send body with **both** `templateName` and `templateId`, or **neither** → 400 (exactly one required) before any side effect.
- Template not found, not owned by the key's user, or not `approved` → 400 (not approved) / 404 (not found/owned), matching the session route's semantics.
- `recipient` missing or empty → 400 before any side effect.
- Insufficient credits (non-superadmin, balance ≤ 0) → credits error (402/403) before contacting Meta.
- `GET /api/v1/messages/{id}` for a non-existent id, or an id owned by another user/number → 404.
- Two keys for the same user bound to different numbers must each act only on their own bound number.
- `lastUsedAt` update failure must not fail the request.
- Second run of the migration script must not error or duplicate the table/index.
- `ENCRYPTION_KEY` missing/invalid at send time: credential resolution throws and is caught as "no creds" → failed send + refund (existing behavior preserved); the key auth itself does not depend on `ENCRYPTION_KEY`.

## Out of Scope

- Free-text / session-window (`/api/chat/...`) sends via the public API.
- Conversation read endpoints via the public API.
- Accepting a `phoneNumberId`/`numberId`/WABA/token from the third party on any `/api/v1` call.
- Changing a key's bound number after creation (retarget = revoke + recreate).
- Rate limiting, usage metering/analytics, scoped permissions/roles per key, key expiry/rotation schedules, and webhook forwarding to the third party (candidates for a later iteration).
- The separate "0 credits / manual credit crediting" and "superadmin tenant management" requests from the broader conversation — tracked elsewhere, not part of this feature.
- OAuth2 client-credentials or JWT-based M2M auth (API key is the decided scheme).
