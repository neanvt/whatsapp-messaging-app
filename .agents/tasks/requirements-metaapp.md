# Requirements — Bring-Your-Own Meta App (Model B) with shared-app fallback (Model A)

## Summary

This multi-tenant WhatsApp Business SaaS (Next.js 14 App Router, TypeScript, Prisma 5.x + libSQL/Turso, next-auth v4) already lets each tenant connect their own WhatsApp number with per-tenant WABA ID, Phone Number ID, and an encrypted access token stored per `WhatsAppNumber` row. Today, every tenant connects *through the platform's single shared Meta app* — identified by the app-level env vars `META_APP_ID`, `META_APP_SECRET`, `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_CONFIG_ID`, and verified by `META_WEBHOOK_VERIFY_TOKEN`.

This change adds **per-tenant Meta App credentials** (App ID, App Secret, Embedded Signup Config ID). When a tenant supplies their own Meta app ("Model B"), the platform uses *their* app for that tenant's OAuth code exchange, Embedded Signup popup, and inbound webhook signature verification. When a tenant does not supply their own app, the platform falls back to its shared env-level app ("Model A", current behavior). **Per-tenant overrides platform; platform env is the default.** A tenant with no per-tenant app row must behave *exactly* as today — no regression.

The business decision (each tenant uses their own WhatsApp number and, now optionally, their own Meta app) is final and is not re-litigated here.

### Confirmed architecture (verified by reading the code)

- Session: `getServerSession(authOptions)` from `@/lib/auth`; `session.user.id`, `session.user.role` (`admin` | `superadmin`). Confirmed in `src/lib/auth.ts`.
- DB: Prisma 5.x with `@prisma/adapter-libsql`; default export `prisma` from `@/lib/db`. Confirmed in `src/lib/db.ts`.
- Crypto: `src/lib/crypto.ts` — `encrypt(plaintext)` → `base64(iv).base64(tag).base64(ciphertext)`; `decrypt(payload)` throws `"Invalid ciphertext format"` on malformed input and throws (via GCM auth tag) on tampering/bad key; key is `ENCRYPTION_KEY` (base64, 32 bytes), resolved lazily; never logs.
- WhatsApp lib: `src/lib/whatsapp.ts` — `resolveSendCredentials`, `resolveWabaCredentials` (per-tenant decrypted creds, NO env fallback for token/WABA), `serializeNumber` (strips `accessToken`), `normalizePhone`, `upsertNumberForUser`, `NumberOwnedByOtherTenantError`.
- Graph API base: `https://graph.facebook.com/v19.0`.
- Build: `prisma generate && next build`.
- `prisma/schema.prisma` has model `WhatsAppNumber` (per-tenant `wabaId`, `phoneNumberId`, `accessToken` ciphertext, `tokenExpiresAt`, health fields, `connectionType`, `verificationStatus`) and model `User` (relations use `onDelete: Cascade`).
- Endpoints verified: `POST /api/numbers/embedded-signup` (reads `META_APP_ID`/`META_APP_SECRET`, exchanges code at `GET /v19.0/oauth/access_token`, discovers WABA via `debug_token`, lists phone numbers, reads health, subscribes app to WABA, registers number, encrypts+stores). `POST /api/numbers/manual` (validates WABA/phone/token live via `Authorization: Bearer`, encrypts+stores). Webhook `src/app/api/webhooks/whatsapp/route.ts` (GET handshake vs `META_WEBHOOK_VERIFY_TOKEN`; POST verifies `X-Hub-Signature-256` as `HMAC-SHA256(rawBody, META_APP_SECRET)` with `timingSafeEqual`, fails closed 401 when secret missing/signature invalid, routes by `phone_number_id` → `WhatsAppNumber`).
- Connect page: `src/app/dashboard/numbers/add/page.tsx` — reads `NEXT_PUBLIC_META_APP_ID`/`NEXT_PUBLIC_META_CONFIG_ID` *at build time* (inlined), loads FB JS SDK, `FB.login` with `config_id`, has a manual-credentials form, shows "Embedded Signup is not configured yet. Set NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_META_CONFIG_ID, or enter credentials manually." when those are unset.
- Migration constraint verified: `prisma db push` cannot connect over `libsql://` (P1012). Schema changes apply via an idempotent `@libsql/client` script under `scripts/`, following `scripts/add-meta-onboarding-columns.mjs` (reads `.env` manually, uses `PRAGMA table_info`, additive/idempotent). `package.json` has no script to run these; they are run with `node scripts/<name>.mjs`.
- No existing `meta-app` route or file (searched — none found). All API/UI surfaces in this change are new except where noted.

## Functional Requirements

### FR-1 — Per-tenant Meta App credential storage (schema)

A new Prisma model `TenantMetaApp` stores, per tenant, the tenant's own Meta app credentials. It is keyed one-per-tenant by `userId` and relates to `User` with `onDelete: Cascade`.

- Fields (verified against existing model conventions — cuid ids app-generated, `createdAt`/`updatedAt`):
  - `id String @id @default(cuid())`
  - `userId String @unique` (one app per tenant)
  - `user User @relation(fields: [userId], references: [id], onDelete: Cascade)`
  - `metaAppId String` (plaintext — not a secret)
  - `metaAppSecret String` (AES-256-GCM **ciphertext** at rest — never plaintext, never logged, never returned)
  - `configId String?` (optional Embedded Signup Configuration ID; not a secret)
  - `createdAt DateTime @default(now())`
  - `updatedAt DateTime @updatedAt`
- `User` model gains the back-relation (e.g. `tenantMetaApp TenantMetaApp?`).
- The table is created on live Turso by a new idempotent `@libsql/client` script under `scripts/` (because `prisma db push` is rejected over `libsql://`). The script creates the table with `CREATE TABLE IF NOT EXISTS` whose columns match the Prisma model exactly, including the `userId` unique constraint and `createdAt`/`updatedAt`. The script follows the pattern of `scripts/add-meta-onboarding-columns.mjs` (manual `.env` parse, guarded/idempotent, no column ever dropped).

### FR-2 — Shared credential resolver `resolveMetaAppCredentials(userId)`

A single reusable resolver determines which Meta app a given tenant's operations run under.

- Signature returns `{ appId: string; appSecret: string; configId: string | null; source: 'tenant' | 'platform' }`.
- If a `TenantMetaApp` row exists for `userId`: decrypt `metaAppSecret` and return `{ appId: row.metaAppId, appSecret: <decrypted>, configId: row.configId ?? null, source: 'tenant' }`.
- Else fall back to platform env: `{ appId: META_APP_ID, appSecret: META_APP_SECRET, configId: NEXT_PUBLIC_META_CONFIG_ID ?? null, source: 'platform' }`.
- Credential errors are surfaced cleanly:
  - A `decrypt()` throw (bad key / tampered ciphertext) surfaces as a clean credential error, **never leaking the secret or ciphertext** into messages or logs.
  - If `source` would be `'platform'` but the required platform env (`META_APP_ID` / `META_APP_SECRET`) is missing, that is a clean "Meta app not configured" credential error (same class as today's missing-env behavior), not an unhandled throw.
- The resolver lives in a shared module (e.g. `src/lib/meta-app.ts`) so embedded-signup, the webhook path, and the settings API all use the identical logic. It never logs secrets.

### FR-3 — Embedded Signup OAuth code exchange uses resolved app creds

`POST /api/numbers/embedded-signup` resolves the Meta app via `resolveMetaAppCredentials(session.user.id)` and uses the returned `appId`/`appSecret` for the OAuth code exchange at `GET /v19.0/oauth/access_token` (replacing the direct `process.env.META_APP_ID` / `process.env.META_APP_SECRET` reads).

- All downstream Graph calls in this route (debug_token, phone discovery, health, subscribe, register) continue to use the exchanged *business token*, unchanged.
- A tenant with a `TenantMetaApp` row exchanges the code against *their* app; a tenant without one exchanges against the platform app exactly as today.
- A credential error from the resolver (missing platform env, or decrypt failure) returns the existing-style 500 "Server is not configured for Embedded Signup" (or an equivalent clean error) without leaking secrets. All other behavior (status codes 201/400/409/401/500, `serializeNumber`, `upsertNumberForUser`, `NumberOwnedByOtherTenantError`) is preserved.

### FR-4 — Per-app webhook signature verification (fail-closed)

`POST /api/webhooks/whatsapp` must verify `X-Hub-Signature-256` against the **correct app secret for the tenant that owns the inbound event**, resolved via `phone_number_id → WhatsAppNumber → userId → resolveMetaAppCredentials`.

- The chicken-and-egg (the body must be parsed to find `phone_number_id`, but the body must be verified before it is trusted) is resolved by a **bounded candidate-secret set**:
  1. Read the raw body **exactly once** (`await request.text()`), as today.
  2. Parse `phone_number_id`(s) from the raw body *for routing only*, treating the parsed value as untrusted until a signature matches.
  3. Build a bounded set of candidate secrets: the platform `META_APP_SECRET` plus the decrypted `metaAppSecret` of each `TenantMetaApp` belonging to the owning tenant(s) of the referenced `phone_number_id`(s). The set is deduplicated and bounded (per request, at most the platform secret plus the owning tenant's app secret — not "every tenant in the DB").
  4. Compute `HMAC-SHA256(rawBody, candidate)` for each candidate and compare to the header using **constant-time compare** (`crypto.timingSafeEqual` on equal-length buffers, as today). Accept if any candidate matches.
- Fail closed: if no candidate secret is available (none configured) or no candidate matches, return **401** and do not process the payload. A missing/malformed `X-Hub-Signature-256` header returns 401 as today.
- No secret value (plaintext or ciphertext) is ever logged. A `decrypt()` failure on a candidate is treated as "that candidate unavailable" (skipped), not a crash, and is not logged with secret material.
- The GET handshake continues to compare against `META_WEBHOOK_VERIFY_TOKEN` (platform-level, unchanged). Routing of statuses/messages to the owning tenant by `phone_number_id`, and the "return 200 so Meta doesn't retry" behavior on processing errors, are preserved.
- Tenants on the platform app (`source: 'platform'`) continue to verify against `META_APP_SECRET` exactly as today.

### FR-5 — Tenant Meta App settings API + UI, and dynamic connect page

**API** — new session-guarded, `userId`-scoped route `src/app/api/meta-app/route.ts` returning `NextResponse`:

- `GET /api/meta-app` — returns the current tenant's effective Meta app config for the UI and the connect page: `{ appId, configId, source: 'tenant' | 'platform', hasSecret: boolean }`. **The app secret value is never returned** (only `hasSecret` indicating whether a tenant secret is stored). `appId`/`configId` returned are the *effective* values (tenant row if present, else platform env), so the connect page can init the FB SDK at runtime.
- `PUT /api/meta-app` — body: `{ metaAppId, metaAppSecret?, configId? }`. Validates with `zod` (see NFR validation). Encrypts `metaAppSecret` with `encrypt()` before storing. Upserts the tenant's `TenantMetaApp` row (keyed by `userId`). The secret is **write-only**: when `metaAppSecret` is omitted/empty on an update of an existing row, the stored secret is left unchanged; it is required when creating a new row.
- `DELETE /api/meta-app` — clears the tenant's `TenantMetaApp` row, reverting the tenant to the platform fallback (Model A). Idempotent (no-op if absent).
- All three require a valid session (`401` otherwise) and operate strictly on `session.user.id` (never a client-supplied userId). Secrets are never logged.

**UI** — tenant settings surface (new page/section, e.g. under `src/app/dashboard/settings/`) to save/update/clear the tenant's own Meta App ID, write-only App Secret (never pre-filled; a stored secret is shown only as "set"/masked via `hasSecret`), and Config ID. It calls `GET`/`PUT`/`DELETE /api/meta-app`.

**Connect page** (`src/app/dashboard/numbers/add/page.tsx`) — instead of reading the build-time-inlined `NEXT_PUBLIC_*` vars directly for the SDK init, it fetches the **effective** `appId`+`configId` at runtime from `GET /api/meta-app` and initializes the FB JS SDK (`FB.init`) and `FB.login` (`config_id`) with those values. When the effective `appId` or `configId` is absent, it keeps the existing "Embedded Signup is not configured yet…" message and the manual-credentials path. The manual connect path (`/api/numbers/manual`) is **untouched**.

### FR-6 — `.env.example` documentation

`.env.example` is updated so the platform Meta vars (`META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_CONFIG_ID`) are documented as the **Model A fallback** used only when a tenant has no `TenantMetaApp` row, and that per-tenant apps (Model B) override them. It documents the Meta-side prerequisites per path (platform app vs. a tenant's own app: Embedded Signup Configuration ID, App Review approval for `whatsapp_business_management` + `whatsapp_business_messaging`). No new env var is introduced by this change (the per-tenant app credentials live in the DB, encrypted). `ENCRYPTION_KEY` continues to be documented as it already is.

## Non-Functional Requirements

### NFR-1 — Multi-tenant isolation

Every DB query and every Meta API call introduced or modified in this change is scoped to the acting tenant's `userId` (from the session), never a client-supplied id. The webhook, which has no session, scopes by resolving `phone_number_id → WhatsAppNumber.userId` and only ever accepts/stores an event under the tenant that owns that `phone_number_id` (preserving existing strict routing).

### NFR-2 — Secret handling

- `TenantMetaApp.metaAppSecret` is stored only as AES-256-GCM ciphertext via `src/lib/crypto.ts`. It is never returned by any API, never rendered in the UI, and never written to logs (including error logs and the webhook candidate loop).
- `GET /api/meta-app` exposes only `hasSecret: boolean`, never the value.
- A `decrypt()` throw is caught and converted to a clean credential error; the message contains no secret or ciphertext.

### NFR-3 — Input validation (external inputs)

- `PUT /api/meta-app` validates with `zod`: `metaAppId` required, string, trimmed, length 1–100; `metaAppSecret` optional (required only when creating a new row), string, length 10–500, write-only; `configId` optional, string, length 1–100. On failure → `400` with `zod` flattened details (matching the existing routes' style). Missing/invalid session → `401`.
- Webhook: the `phone_number_id` parsed from the body is treated as untrusted and used only to select candidate secrets; it grants no trust until a signature matches.

### NFR-4 — No new dependencies

Use only Node `crypto` and `fetch` (already in use) plus existing deps (`zod`, Prisma, next-auth). No new runtime dependency is added.

### NFR-5 — No regression / preserve existing behavior

A tenant with no `TenantMetaApp` row behaves **exactly as today**. All of the following are preserved unchanged: existing send paths (including the `#131008` auth-template button + OTP guard + credit deduct/refund + superadmin handling), template routes' per-tenant WABA resolution (`resolveWabaCredentials`), webhook per-tenant routing and fail-closed semantics, the manual connect path, and `serializeNumber` secret stripping. The project must still build with `prisma generate && next build`.

## Acceptance Criteria

1. `prisma/schema.prisma` contains a `TenantMetaApp` model with `id` (cuid), `userId @unique`, `metaAppId`, `metaAppSecret`, `configId?`, `createdAt`, `updatedAt`, and `user` relation with `onDelete: Cascade`; `User` has the matching back-relation. `prisma generate` succeeds and the generated client exposes `prisma.tenantMetaApp`.
2. A new idempotent script under `scripts/` creates the `TenantMetaApp` table on Turso via `@libsql/client` with `CREATE TABLE IF NOT EXISTS`, columns matching the model exactly (including the `userId` unique constraint), running cleanly a second time with no error and no change. (`prisma db push` is NOT used.)
3. `resolveMetaAppCredentials(userId)` returns `source: 'tenant'` with the tenant's `appId`/decrypted `appSecret`/`configId` when a `TenantMetaApp` row exists, and `source: 'platform'` with the env values when it does not. A tampered/undecryptable tenant secret produces a clean credential error containing no secret/ciphertext; a missing platform `META_APP_ID`/`META_APP_SECRET` on the platform branch produces a clean "not configured" error.
4. With a tenant that has a `TenantMetaApp` row, `POST /api/numbers/embedded-signup` performs the OAuth code exchange using that tenant's `appId`/`appSecret`; with a tenant that has none, it uses the platform env values. In both cases a successful connect returns `201` with a `serializeNumber`'d record (no `accessToken` field), and the 400/409/401/500 paths behave as before.
5. `POST /api/webhooks/whatsapp` reads the raw body once, selects a bounded candidate-secret set (platform secret + the owning tenant's app secret for the event's `phone_number_id`), accepts the payload iff some candidate yields a `timingSafeEqual` match, and returns `401` (processing nothing) when no candidate matches, when no candidate secret is available, or when the signature header is missing/malformed. A tenant on the platform app still verifies against `META_APP_SECRET`. No secret or ciphertext is logged.
6. `GET /api/meta-app` returns `{ appId, configId, source, hasSecret }` for the session tenant and never returns the secret value; `PUT /api/meta-app` upserts the tenant row (encrypting the secret, leaving an existing secret unchanged when omitted) and validates per NFR-3; `DELETE /api/meta-app` clears the row and is idempotent. All three return `401` without a valid session and operate only on `session.user.id`.
7. The connect page (`.../numbers/add`) fetches effective `appId`+`configId` from `GET /api/meta-app` at runtime, initializes the FB SDK / `FB.login` with those values, shows the existing "Embedded Signup is not configured yet…" message when either is absent, and leaves the manual-credentials path (`/api/numbers/manual`) unchanged.
8. The tenant settings UI can save, update (write-only secret, never pre-filled), and clear the tenant's own Meta app, reflecting `hasSecret` state, and reverting to the platform fallback after clear.
9. `.env.example` documents the platform Meta vars as the Model A fallback (used only when a tenant has no own app) and the Meta-side prerequisites; no new env var is introduced.
10. `prisma generate && next build` succeeds. A tenant with no `TenantMetaApp` row exhibits identical behavior to pre-change for embedded signup, webhook verification, sends, template routes, and manual connect (no regression).

## Out of Scope

- Changing the `META_WEBHOOK_VERIFY_TOKEN` GET-handshake model to per-tenant (one shared webhook endpoint and shared verify token remain; only POST signature verification becomes per-app).
- Per-tenant webhook *endpoint URLs* or per-tenant verify tokens.
- Any change to send paths, template routes, credits/billing, OTP/auth-template logic, or `serializeNumber` beyond leaving them working as-is.
- Automated Meta App Review submission or Meta-side app configuration (manual, on the Meta side, per existing `.env.example` notes).
- Rotation/expiry automation for tenant app secrets beyond store/update/clear.
- Multiple Meta apps per tenant (model is one-per-tenant via `userId @unique`).

## Assumptions

- "Model B with fallback Model A" (per user message #12) means: use the tenant's own app when configured, otherwise the platform's shared app — encoded as per-tenant-overrides-platform in `resolveMetaAppCredentials`.
- The connect page must move from build-time `NEXT_PUBLIC_*` inlining to a runtime `GET /api/meta-app` fetch so a tenant's own `appId`/`configId` can drive the FB SDK without a rebuild (the current `NEXT_PUBLIC_*` values are frozen at build time, which cannot express per-tenant values).
- `TenantMetaApp` is one row per tenant (`userId @unique`); a tenant connecting multiple numbers still uses a single own-app config.
- The webhook candidate-secret set is bounded to the platform secret plus the owning tenant's app secret for the referenced `phone_number_id`(s) in that request — it does not iterate all tenants.
- The settings UI lives under `src/app/dashboard/settings/` (new); exact placement is a design concern, not a requirement.

---

Requirements file path: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/.agents/tasks/requirements-metaapp.md`
