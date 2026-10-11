# WhatsApp Business Messaging Platform — Technical Reference

Last updated: 2026-10-11

## Overview

- **Name:** `whatsapp` (WhatsApp Business messaging platform)
- **Purpose:** Multi-tenant SaaS for sending WhatsApp template messages via the Meta
  Cloud API. Users connect their own WhatsApp number (Meta Embedded Signup OAuth
  popup or manual credentials), manage approved templates, send template
  messages, chat with contacts, and buy message credits via Razorpay. Each
  tenant's Meta access token is encrypted at rest and used per-number for sending.
  Includes an admin/superadmin panel.
- **Status:** Active development.

## Tech stack

| Area        | Choice |
|-------------|--------|
| Framework   | Next.js 14 (App Router) |
| Language    | TypeScript 5 |
| Runtime     | Node.js (Next.js server) |
| Database    | Turso / libSQL (SQLite) via `@libsql/client` + `@prisma/adapter-libsql` |
| ORM         | Prisma 5 (`driverAdapters` preview feature) |
| Auth        | NextAuth v4 (`next-auth`, `@auth/prisma-adapter`), bcryptjs password hashing |
| Payments    | Razorpay |
| UI          | Tailwind CSS, Radix UI primitives, lucide-react icons, class-variance-authority |
| Validation  | zod |
| Crypto      | Node `crypto` — AES-256-GCM for per-tenant token encryption at rest |
| Onboarding  | Meta Embedded Signup (Facebook JS SDK OAuth popup) + manual credentials |
| Messaging   | Meta Graph API (WhatsApp Cloud API) `v19.0` |

## Architecture

- `src/app/` — App Router pages and API route handlers.
- `src/app/api/**/route.ts` — backend REST endpoints (see Backend info).
- `src/lib/db` — Prisma client wired to the Turso libSQL adapter.
- `src/lib/auth` — NextAuth `authOptions` (session, roles).
- `src/lib/crypto` — AES-256-GCM `encrypt`/`decrypt`; key from `ENCRYPTION_KEY`
  (32 raw bytes base64). Lazy key resolution — missing/short key throws at use
  time, not import time. Ciphertext format: `base64(iv).base64(tag).base64(ct)`.
- `src/lib/whatsapp` — shared onboarding/send helpers: `normalizePhone`
  (strip non-digits), `serializeNumber` (drop `accessToken` ciphertext from API
  responses), `resolveSendCredentials` (decrypt the number's own token, else env
  fallback), `NumberOwnedByOtherTenantError`, `upsertNumberForUser`
  (find-then-branch on the globally-unique `phoneNumber`; rejects cross-tenant
  collisions with 409 rather than overwriting — never a Prisma upsert).
- `scripts/test-crypto.mjs` — standalone AES-256-GCM round-trip / tamper /
  key-validation harness; inlines the same format, no import from TS, no compile.
- `prisma/schema.prisma` — data model (SQLite datasource via `TURSO_DATABASE_URL`).
- Layers: UI pages → API route handlers → Prisma → Turso DB; outbound messaging
  calls the Meta Graph API directly from the route handlers, using per-number
  decrypted credentials.

## Features

- Email/password auth with roles (`admin`, `superadmin`).
- WhatsApp number onboarding via two paths (see "Onboarding paths" below):
  Meta Embedded Signup OAuth popup, or manual credential entry. Per-tenant
  access tokens are validated against Meta and stored encrypted (AES-256-GCM).
- Template management (create, edit, duplicate, submit for Meta approval, sync).
- Template message sending through the Meta Cloud API.
- Two-way chat (conversations, inbound via webhook, outbound send).
- Credits system (balance, deduction per send, refund on failure).
- Razorpay payments to purchase credit packages.
- Admin panel: user management, package management, stats.
- Audit logging.

## Onboarding paths (connecting a WhatsApp number)

A number is only ever marked `verified` by connecting real Meta credentials.
There is no local "enter a code we generated" flow anymore. Both paths validate
against Meta BEFORE any DB write, store the per-tenant token encrypted, and
reject cross-tenant collisions with 409.

- **Path A — Meta Embedded Signup** (`POST /api/numbers/embedded-signup`):
  the dashboard opens Meta's OAuth popup via the Facebook JS SDK (using
  `NEXT_PUBLIC_META_APP_ID` + `NEXT_PUBLIC_META_CONFIG_ID`). The returned OAuth
  `code` is posted to the server, which exchanges it (with `META_APP_ID` +
  `META_APP_SECRET`, no redirect_uri) for a business token, resolves the WABA id
  (body value or `debug_token` granular scopes), discovers the `phoneNumberId`,
  fetches number health, subscribes the app to the WABA + registers the number
  (both non-fatal), then persists the encrypted token with
  `connectionType: "embedded_signup"` and `verificationStatus: "verified"`.
- **Path B — Manual credentials** (`POST /api/numbers/manual`): the user supplies
  `wabaId`, `phoneNumberId`, and an `accessToken`. The server validates the token
  against the number's health endpoint, does a three-way WABA tie-check
  (phone must appear under the WABA; a failed list call is non-fatal, the health
  check is authoritative), subscribes the app (non-fatal), then persists the
  encrypted token with `connectionType: "manual"` and `verificationStatus:
  "verified"`.

There is NO server-side `META_CONFIG_ID`: the Configuration ID is only read
client-side via `NEXT_PUBLIC_META_CONFIG_ID` (build-time inlined — changing it
requires a rebuild).

## Backend info (API endpoints)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register` | Register a new user |
| * | `/api/auth/[...nextauth]` | NextAuth handlers (login/session) |
| GET | `/api/numbers` | List WhatsApp numbers (`serializeNumber` — no `accessToken`) |
| POST | `/api/numbers` | **Deprecated** — bare phone registration returns 400 |
| POST | `/api/numbers/embedded-signup` | **Path A** — exchange OAuth code, store encrypted per-tenant token (201 / 400 / 409 / 500) |
| POST | `/api/numbers/manual` | **Path B** — validate + store manual credentials (201 / 400 / 409 / 500) |
| GET/PATCH/DELETE | `/api/numbers/[id]` | Manage a number (GET uses `serializeNumber`; DELETE kept) |
| POST | `/api/numbers/[id]/verify` | **Repurposed** — refresh live Meta health/status from the Graph API (no local code) |
| POST | `/api/numbers/[id]/confirm` | **Neutralized** — returns 410 Gone |
| GET/POST | `/api/templates` | List / create templates |
| GET/PATCH/DELETE | `/api/templates/[id]` | Manage a template |
| POST | `/api/templates/[id]/submit` | Submit template to Meta |
| POST | `/api/templates/[id]/duplicate` | Duplicate a template |
| POST | `/api/templates/sync` | Sync template statuses from Meta |
| GET/POST | `/api/messages` | List / query messages |
| POST | `/api/messages/send` | **Send a template message via Meta** |
| GET | `/api/chat/conversations` | List conversations |
| GET | `/api/chat/[contactPhone]/messages` | Messages for a contact |
| POST | `/api/chat/[contactPhone]/send` | Send a chat message |
| POST | `/api/chat/test-inject` | Test helper: inject an inbound message |
| GET | `/api/credits/balance` | Credit balance |
| POST | `/api/payments/create-order` | Create a Razorpay order |
| POST | `/api/payments/verify` | Verify a Razorpay payment |
| GET/PATCH | `/api/settings/profile` | Profile settings |
| PATCH | `/api/settings/password` | Change password |
| GET | `/api/admin/stats` | Admin dashboard stats |
| GET/POST | `/api/admin/users` + `/[id]` | Admin user management |
| GET/POST | `/api/admin/packages` + `/[id]` | Admin package management |
| GET/POST | `/api/webhooks/whatsapp` | Meta webhook — GET handshake; POST verifies `X-Hub-Signature-256` then routes inbound/status (see Webhook flow) |

### Message-send flow — `POST /api/messages/send`

1. **Auth:** require a NextAuth session (`session.user.id`), else 401.
2. **Validate body:** require `numberId`, `recipient`, `templateId`; optional
   `variables` (JSON array of strings).
3. **Validate number:** must belong to the user and be `verified`, else 400.
4. **Validate template:** must belong to the user and be `approved`, else 400.
5. **Auth-template OTP guard:** if `template.category === "authentication"` and
   `variables[0]` is missing/empty → return 400
   `{ error: "OTP code variable required for authentication template" }`
   **before** any message record or credit deduction (no dangling row, no credit churn).
6. **Credit check:** superadmins are exempt; others must have `totalCredits > 0`,
   else 400.
7. **Create message** record with `status: "queued"`.
8. **Deduct credit** (`totalCredits -1`, `usedCredits +1`) — skipped for superadmin.
9. **Resolve creds** via `resolveSendCredentials(number)`: if the number has a
   stored token, decrypt it (per-tenant) and use the number's `phoneNumberId`;
   otherwise fall back to `META_PHONE_NUMBER_ID` / `META_ACCESS_TOKEN`. A
   decrypt/config throw is caught and leaves both null → funnels into the
   missing-creds "failed + refund" branch (no plaintext token ever logged).
10. **Build Meta template components:**
    - `body` component from `variables` (when there are variables).
    - For `authentication` templates, also append a copy-code URL button:
      `{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: variables[0] }] }`.
11. **POST** to `https://graph.facebook.com/v19.0/{phoneNumberId}/messages`.
12. **Update message** record with `sent`/`failed`, `metaMessageId`, `errorMessage`.
13. **On failure:** refund the credit (non-superadmin) and return 500.
14. **On success:** return 200 `{ id, status: "sent" }`.

### Chat free-text send — `POST /api/chat/[contactPhone]/send`

Session-gated. No credit logic. Resolves credentials via
`resolveSendCredentials` for the selected (or first verified) number; a
decrypt/config throw is caught and leaves creds null. Missing creds → **500**
`{ error: "Meta API credentials not configured" }`. On a Meta API error the
message row is saved as `failed` and the route returns **422**. Only valid
inside WhatsApp's 24-hour customer-service window.

### Webhook — `POST /api/webhooks/whatsapp`

1. **Read the raw body first** so the HMAC is computed over the exact bytes Meta
   signed.
2. **Require `META_APP_SECRET`** — missing → **401** (so delivery-status updates
   never land without it).
3. **Verify `X-Hub-Signature-256`:** header must be `sha256=<hex>`; compute
   `HMAC-SHA256(META_APP_SECRET, raw)` and compare with `crypto.timingSafeEqual`.
   Missing/malformed/mismatch → **401**, no rows touched.
4. **Status updates:** `statuses[]` update the matching `Message` by
   `metaMessageId` (`updateMany`) — set `status`, plus `deliveredAt` / `readAt` /
   `errorMessage` as applicable.
5. **Inbound messages:** resolve the owning number STRICTLY by the inbound
   `metadata.phone_number_id` (no env fallback, no "any verified number"
   fallback — a payload for a tenant's `phone_number_id` may only write under
   that tenant). If no number matches, skip. Otherwise upsert the conversation
   and create an inbound `Message` (`direction: "inbound"`, `status: "received"`).
6. After processing (or on any parse error) return **200** so Meta does not
   retry; the 401 guard above is the only non-200 on POST.

The **GET** handshake echoes `hub.challenge` with 200 when `hub.mode ===
"subscribe"` and `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN`, else 403.

## Schema (Prisma / `prisma/schema.prisma`)

| Model | Key fields | Relationships |
|-------|-----------|---------------|
| `User` | email (unique), passwordHash, role (`admin`/`superadmin`), isActive | has many numbers, templates, messages, payments, conversations, auditLogs; one credits |
| `UserCredits` | userId (unique), totalCredits, usedCredits | belongs to User |
| `WhatsAppNumber` | phoneNumber (unique — the ONLY unique key, no compound), wabaId, phoneNumberId, verificationStatus; **accessToken** (AES-256-GCM ciphertext at rest — never plaintext, never logged, stripped from API responses), **tokenExpiresAt**, **displayPhoneNumber**, **verifiedName**, **qualityRating**, **codeVerificationStatus**, **platformType**, **connectionType** (`manual` default / `embedded_signup`) | belongs to User; has templates, messages, conversations |
| `Template` | name, **category** (marketing/utility/authentication), language, body, header/footer/buttons, status, metaTemplateId | belongs to User + optional WhatsAppNumber; has messages |
| `Message` | recipientPhone, templateVariables (JSON), status, direction, metaMessageId, errorMessage | belongs to User, WhatsAppNumber, optional Template + Conversation |
| `Conversation` | contactPhone, unreadCount, lastMessageAt (unique: numberId+contactPhone) | belongs to User + WhatsAppNumber; has messages |
| `Payment` | razorpayOrderId (unique), amount, creditsPurchased, status | belongs to User |
| `AuditLog` | action, entityType, entityId, old/newValues | optional User |
| `Package` | planId (unique), name, credits, price fields, isActive/isPopular | — |

- Datasource: SQLite provider pointed at Turso (`env("TURSO_DATABASE_URL")`),
  accessed through the libSQL driver adapter.

## Configuration / environment (key names only — no values)

| Key | Meaning |
|-----|---------|
| `TURSO_DATABASE_URL` | Turso/libSQL database URL (Prisma datasource) |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `META_APP_ID` | Meta app ID; used for the Embedded Signup OAuth code exchange |
| `META_APP_SECRET` | Meta app secret; OAuth code exchange + webhook `X-Hub-Signature-256` verification (MANDATORY for delivery status) |
| `META_ACCESS_TOKEN` | Legacy / global fallback token (used only when a number has no stored per-tenant token) |
| `META_PHONE_NUMBER_ID` | Legacy / global fallback phone number ID |
| `META_WABA_ID` | WhatsApp Business Account ID (global reference) |
| `META_WEBHOOK_VERIFY_TOKEN` | Verify token the webhook GET handshake must echo |
| `NEXT_PUBLIC_META_APP_ID` | Client-exposed Meta app ID for the Facebook JS SDK (build-time inlined) |
| `NEXT_PUBLIC_META_CONFIG_ID` | Client-exposed Embedded Signup Configuration ID (build-time inlined; no server-side `META_CONFIG_ID` exists) |
| `ENCRYPTION_KEY` | AES-256-GCM key, 32 raw bytes base64 (`openssl rand -base64 32`); encrypts per-tenant access tokens at rest |
| `NEXTAUTH_URL` | NextAuth base URL |
| `NEXTAUTH_SECRET` | NextAuth session secret |
| `NEXTAUTH_JWT_SECRET` | NextAuth JWT secret |
| `RAZORPAY_KEY_ID` | Razorpay public key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay secret key |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook signing secret |

## Build / test / scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server |
| `npm run build` | `prisma generate && next build` (regression gate) |
| `npm run start` | Production server |
| `npm run lint` | ESLint (next lint) |
| `npm run db:generate` | `prisma generate` |
| `npm run db:push` | `prisma db push` |
| `npm run db:studio` | Prisma Studio |
| `npx tsc --noEmit` | Type-check only (lighter than full build) |
| `ENCRYPTION_KEY=$(openssl rand -base64 32) node scripts/test-crypto.mjs` | AES-256-GCM round-trip / tamper / key-validation check |

**Regression gate:** `npm run build` (= `prisma generate && next build`) must
pass, and the crypto harness above must print "All crypto assertions passed."
There is no test runner installed; these two checks are the full gate.

## Security highlights

- Session-gated API routes via NextAuth; `superadmin` role bypasses credit limits.
- Passwords hashed with bcryptjs.
- Resource ownership enforced in queries (number/template scoped to `userId`).
- Secrets provided via env vars (never committed).
- **Per-tenant token encryption at rest:** access tokens are stored as
  AES-256-GCM ciphertext (`src/lib/crypto`, key `ENCRYPTION_KEY`). Plaintext
  tokens are never logged; `serializeNumber` strips the ciphertext from every
  API response.
- **Webhook authenticity:** inbound POSTs are rejected (401) unless
  `X-Hub-Signature-256` matches `HMAC-SHA256(META_APP_SECRET, rawBody)`
  (constant-time compare).
- **Tenant isolation on inbound:** webhook routing matches strictly on
  `phone_number_id` — no cross-tenant or env fallback.
- **Cross-tenant collision guard:** `upsertNumberForUser` rejects connecting a
  number already owned by another user with 409.

## Known context / gotchas

- `templateVariables` and template `buttons`/`mediaAttachments` are stored as JSON
  strings in SQLite.
- Authentication templates with a copy-code URL button require a matching
  `button` component carrying the OTP, or Meta returns `(#131008) Required
  parameter is missing`. The send route handles this (see message-send flow).
- Credit deduction and refund-on-failure must stay consistent — guard early
  returns before `message.create`/deduction to avoid dangling rows.
- `WhatsAppNumber.phoneNumber` is the ONLY unique key (no compound unique), so
  onboarding uses find-then-branch (`upsertNumberForUser`), NOT a Prisma upsert.
- `NEXT_PUBLIC_*` vars are inlined at build time; changing
  `NEXT_PUBLIC_META_APP_ID` / `NEXT_PUBLIC_META_CONFIG_ID` requires a rebuild.
- Live Meta OAuth / send / delivery paths need a Meta Config ID + App Review +
  a real token (all user-supplied) and cannot be exercised end-to-end from code
  alone; verify handler shape, zod rejects, and the 400/409/500 branches.
- `scripts/test-crypto.mjs` intentionally re-implements the crypto format inline
  (no import from `src/lib/crypto.ts`) so it runs under plain `node` with no
  compile step or new dependency.

## Change log

### 2026-10-11
- **Meta Embedded Signup + per-tenant onboarding (multi-tenant SaaS).** Added two
  real connect paths so each user links their own WhatsApp number and the app
  captures/stores the real IDs + token automatically:
  - New `POST /api/numbers/embedded-signup` (OAuth code exchange → WABA/phone
    discovery → health → subscribe/register → encrypted token save) and
    `POST /api/numbers/manual` (validate provided credentials → three-way WABA
    tie-check → encrypted token save). Both return 201/400/409/500 and reject
    cross-tenant collisions with 409.
  - Repurposed `POST /api/numbers/[id]/verify` to a live Meta health/status
    refresh (no local code); neutralized `POST /api/numbers/[id]/confirm` to
    410 Gone; bare `POST /api/numbers` now returns 400.
  - New `WhatsAppNumber` fields: `accessToken` (AES-256-GCM ciphertext),
    `tokenExpiresAt`, `displayPhoneNumber`, `verifiedName`, `qualityRating`,
    `codeVerificationStatus`, `platformType`, `connectionType`.
  - New `src/lib/crypto` (AES-256-GCM `encrypt`/`decrypt`, key `ENCRYPTION_KEY`)
    and `src/lib/whatsapp` (`normalizePhone`, `serializeNumber`,
    `resolveSendCredentials`, `upsertNumberForUser`,
    `NumberOwnedByOtherTenantError`); `scripts/test-crypto.mjs` harness.
  - Webhook `POST /api/webhooks/whatsapp` now verifies `X-Hub-Signature-256`
    (HMAC-SHA256 with `META_APP_SECRET`, constant-time) and routes inbound
    strictly by `phone_number_id`; missing/invalid signature → 401.
  - Rewired both send paths (`/api/messages/send`, `/api/chat/[contactPhone]/send`)
    to use `resolveSendCredentials` — per-number decrypted token with env
    fallback.
  - Docs: rewrote `.env.example` (removed Postgres `DATABASE_URL`; added Turso
    vars, the full Meta set, `NEXT_PUBLIC_META_APP_ID`,
    `NEXT_PUBLIC_META_CONFIG_ID`, `ENCRYPTION_KEY`, Razorpay keys, and a
    Meta-side prerequisites comment block). Secrets referenced by key name only.

### 2026-10-10
- Fixed `(#131008) Required parameter is missing` on authentication-template
  sends in `POST /api/messages/send`. Added the copy-code URL `button` component
  (`sub_type: "url"`, `index: "0"`, OTP = `variables[0]`) alongside the existing
  `body` component for templates where `category === "authentication"`. Added an
  early 400 guard (`OTP code variable required for authentication template`) that
  returns before any message record or credit deduction when the OTP variable is
  missing, preserving credit consistency. No schema change.
