# Requirements — Meta WhatsApp Cloud API Number Onboarding (Multi-Tenant SaaS)

Last updated: 2025-02-14
Status: Draft for design review

## Summary

The app currently fakes WhatsApp number onboarding. Adding a number only stores a
phone-number string with `verificationStatus: "pending"`; the "verify" endpoint
generates a random 6-digit code and the "confirm" endpoint just flips the local
status to `verified`. None of this touches Meta. Because real numbers never get a
`phoneNumberId` or a per-tenant access token, every send falls back to the single
global `process.env.META_PHONE_NUMBER_ID` / `process.env.META_ACCESS_TOKEN`. This
is why a message shows "sent" locally but is never received by the recipient, and
why no real delivery status is visible.

This feature replaces the fake flow with real Meta WhatsApp Cloud API onboarding
for a multi-tenant SaaS, giving each tenant their own connected WhatsApp Business
number(s). It provides **two connection paths**:

1. **Embedded Signup (primary)** — the WABA owner connects their own number through
   Meta's OAuth popup; the app receives and stores the real `wabaId`,
   `phoneNumberId`, and a per-tenant access token automatically.
2. **Manual credential entry (fallback)** — a developer/IT consultant who is logged
   in but does not have the FB account owner present (so cannot complete interactive
   OAuth/MFA) enters the IDs and token directly; the app validates them against Meta
   before saving.

Per-tenant access tokens are encrypted at rest (AES-256-GCM, key from an
`ENCRYPTION_KEY` env var). The send path is rewired to use each number's own
credentials. Delivery status becomes real via the Meta webhook (handshake exists;
signature verification must be added). The code is built fully; the user supplies
the Meta-side configuration (Config ID, App Review approvals) afterward.

### Important corrections to the task brief's stated "current state"

Two items in the handoff were found to be inaccurate during investigation. The
design must build on the *actual* code below, not the brief:

- **A webhook route already exists** at `src/app/api/webhooks/whatsapp/route.ts`.
  It already does the GET handshake (`hub.mode`/`hub.verify_token`/`hub.challenge`
  → echoes challenge on match, 403 otherwise) and a POST handler that maps status
  updates (sent/delivered/read/failed → `deliveredAt`/`readAt`/`errorMessage`) and
  stores inbound messages + upserts conversations. **It does NOT verify the
  `X-Hub-Signature-256` request signature** — that is the real gap.
- **There is a second send path**: `src/app/api/chat/[contactPhone]/send/route.ts`
  (free-text replies inside the 24h window). It has the same env-fallback bug as
  `messages/send`. The rewire must cover both send routes, not just one.

## Actors / Roles

- **Tenant admin** (`role: "admin"`) — owns WhatsApp numbers, templates, messages,
  credits. All data is scoped to their `userId`.
- **Superadmin** (`role: "superadmin"`) — exempt from credit checks (existing
  behavior); otherwise same onboarding flow.
- **WABA owner** — the Meta/Facebook Business account owner who authenticates the
  Embedded Signup OAuth popup. May or may not be the logged-in app user.
- **Developer / IT consultant** — a logged-in app user acting on the tenant's behalf
  when the WABA owner is unavailable for interactive login; uses the manual path.

## User Stories

### Path A — Embedded Signup (OAuth popup)

- **US-A1** As a tenant admin, I click "Connect WhatsApp" and a Meta-hosted popup
  opens where the WABA owner logs in and selects/creates the WABA and phone number,
  so that I don't have to copy any IDs by hand.
- **US-A2** As a tenant admin, when the popup completes, the app automatically
  exchanges the returned authorization code for a token and reads the real
  `wabaId` and `phoneNumberId` from Meta, so the number is connected without manual
  entry.
- **US-A3** As a tenant admin, the connected number appears in my numbers list with
  a status that reflects Meta's real state, not a cosmetic local flag.
- **US-A4** As a tenant admin, if the popup is cancelled or fails, I see a clear
  error and no half-connected number is left in my account.

### Path B — Manual credential entry (owner unavailable)

- **US-B1** As a developer/IT consultant logged into the tenant, I open "Connect
  manually" and enter the WABA ID, Phone Number ID, and a Meta access token, so a
  number can be connected without the owner completing OAuth/MFA.
- **US-B2** As a developer/IT consultant, when I submit, the app validates the
  credentials against Meta (confirms the phone number ID is reachable and belongs
  to the WABA) before saving, so I find out immediately if the token or IDs are
  wrong.
- **US-B3** As a developer/IT consultant, if validation fails, the request is
  rejected with a 400 and a descriptive message and **nothing is saved** (no
  dangling number row, no stored token).
- **US-B4** As a developer/IT consultant, on success the token is stored encrypted
  and the number is immediately usable for sending.

### Delivery status visibility

- **US-C1** As a tenant admin, after I send a message I see its real lifecycle
  status (queued → sent → delivered → read, or failed with Meta's reason), driven
  by Meta webhook callbacks, so "sent" no longer lies.
- **US-C2** As a tenant admin, I can see Meta's error reason on a failed message so
  I can act on it.

### Credits / balance visibility (from "check for the credits / amount in facebook account")

- **US-D1** As a tenant admin, I can see my connected WABA's messaging/credit status
  as reported by Meta (e.g., account review status / messaging limits), so I know
  whether Meta will actually deliver my messages. *(Scope note below — exact Meta
  field to surface is an open question for design.)*

### Status visibility (from "code_verification_status is not visible anywhere")

- **US-E1** As a tenant admin, I can see the phone number's real Meta
  `code_verification_status` and `name_status` / quality rating on the number
  detail page, so I understand why a number can or cannot send.

## Functional Requirements

### FR-1 Schema / data model
- **FR-1.1** Add an encrypted per-tenant access-token field to `WhatsAppNumber`
  (e.g. `accessTokenEnc String?`). Store ciphertext only; never plaintext.
- **FR-1.2** Add fields to capture real Meta onboarding data as needed:
  `businessId`/`wabaId` already present (`wabaId`), `phoneNumberId` already present.
  Add `codeVerificationStatus String?`, `nameStatus String?`, `qualityRating
  String?`, and a `connectionType String?` (`embedded` | `manual`) to distinguish
  the two paths. *(Final field list is a design decision; see open questions.)*
- **FR-1.3** DB changes are applied via `npm run db:push` (Prisma `db push`), NOT
  migrations, consistent with the existing workflow.
- **FR-1.4** Keep `verificationStatus` meaning real now: it must reflect whether the
  number has usable Meta credentials, not a cosmetic flag.

### FR-2 Encryption at rest
- **FR-2.1** Add an `ENCRYPTION_KEY` env var (referenced by name only; the user
  generates the key value). Use AES-256-GCM.
- **FR-2.2** Provide a single reusable crypto helper (encrypt/decrypt) that produces
  authenticated ciphertext (IV + auth tag + ciphertext, encoded). Note: existing
  code already imports Node's `crypto` in `payments/verify`, so Node `crypto` is the
  established choice.
- **FR-2.3** Tokens are decrypted only server-side at the moment of a Meta call and
  are never returned to the client in any API response.
- **FR-2.4** Fail safely if `ENCRYPTION_KEY` is missing/invalid: onboarding and
  sends that need a per-tenant token return a clear server error rather than storing
  or using plaintext.

### FR-3 Embedded Signup path
- **FR-3.1** Add a backend endpoint that completes Embedded Signup: receives the
  authorization code (and/or the WABA/phone IDs returned by the Meta JS SDK session),
  exchanges the code for an access token via Graph API, reads the real `wabaId` and
  `phoneNumberId`, encrypts and stores the token, and creates/updates the
  `WhatsAppNumber` scoped to `session.user.id`.
- **FR-3.2** The frontend loads Meta's SDK and launches the popup using
  `process.env` config read via a public config value (`META_APP_ID`,
  `META_CONFIG_ID`). The `META_CONFIG_ID` is read from env and left blank for the
  user to fill after Meta setup + App Review.
- **FR-3.3** Subscribe the newly connected WABA to the app's webhook (Graph
  `subscribed_apps`) so status/inbound callbacks flow, if not already subscribed.
- **FR-3.4** On any failure during the exchange, no number row and no token are
  persisted (atomic: validate first, then write).

### FR-4 Manual credential path
- **FR-4.1** Add a backend endpoint (or extend `POST /api/numbers`) that accepts
  `wabaId`, `phoneNumberId`, and `accessToken`.
- **FR-4.2** Validate inputs with zod (all three required, string, length limits).
- **FR-4.3** Validate against Meta before persisting: call Graph to confirm the
  phone number ID is retrievable with the given token and (where feasible) tied to
  the given WABA. On failure, return 400 with Meta's message and persist nothing.
- **FR-4.4** On success, encrypt the token, store the real IDs and Meta-reported
  statuses, set `connectionType = "manual"`, scope to `session.user.id`.
- **FR-4.5** Enforce the existing unique constraint on `phoneNumber`; a number
  already connected (to this or another tenant) returns a clear 400.

### FR-5 Replace the fake flow
- **FR-5.1** Remove/repurpose the fake code generation in
  `src/app/api/numbers/[id]/verify/route.ts` and the local-only confirm in
  `src/app/api/numbers/[id]/confirm/route.ts`. Either delete them or replace their
  bodies with real Meta phone-number status checks / registration calls.
- **FR-5.2** Update `POST /api/numbers` so a bare `phoneNumber`-only registration is
  no longer the path to a "verified" number. Design decides whether to keep it as a
  draft placeholder or remove it in favor of the two real paths.
- **FR-5.3** Update the frontend: `src/app/dashboard/numbers/add/page.tsx` and
  `src/app/dashboard/numbers/[id]/verify/page.tsx` must offer the two real paths
  (Embedded Signup button + manual form) instead of the fake code UI. The numbers
  list (`src/app/dashboard/numbers/page.tsx`) and detail
  (`src/app/dashboard/numbers/[id]/page.tsx`) show real Meta statuses.

### FR-6 Send-path rewire (must preserve existing behavior)
- **FR-6.1** `src/app/api/messages/send/route.ts` must resolve the per-tenant
  `phoneNumberId` and decrypted access token **from the number record**, not from
  the global env fallback, when the number was connected via either new path.
- **FR-6.2** The following existing behaviors MUST NOT regress:
  - authentication-template OTP guard (400 if `category === "authentication"` and no
    first variable) **before** any message row or credit deduction;
  - the `#131008` fix: authentication templates append the `button` / `sub_type: url`
    component carrying the OTP code;
  - credit deduction on send and refund on failure; superadmin credit exemption;
  - message status transitions and `metaMessageId` capture;
  - Graph API version `v19.0`.
- **FR-6.3** `src/app/api/chat/[contactPhone]/send/route.ts` (free-text replies) is
  rewired the same way to use per-tenant credentials.
- **FR-6.4** Behavior when a number has no usable per-tenant token must be explicit:
  design decides whether to keep the global env fallback for the single legacy
  number, or to fail the send with a clear error. (Open question.)

### FR-7 Webhook — add signature verification
- **FR-7.1** Keep the existing GET handshake behavior (echo `hub.challenge` on
  verify-token match; 403 on mismatch/wrong mode).
- **FR-7.2** Add `X-Hub-Signature-256` verification on POST: compute
  `HMAC-SHA256(appSecret, rawBody)` and compare (constant-time) to the header. On
  mismatch, reject (401/403) and do not process the payload. This requires reading
  the **raw** request body before JSON parsing.
- **FR-7.3** Preserve existing status mapping and inbound-message/conversation
  handling; preserve returning HTTP 200 on processing errors so Meta does not retry
  indefinitely (but reject on signature failure).
- **FR-7.4** Inbound/status handling must resolve the owning `WhatsAppNumber` by
  `phoneNumberId` (already done) so multi-tenant routing is correct; review the
  env/`verified`-number fallbacks so one tenant's webhook can't be attributed to
  another tenant. (Design to confirm fallback is safe or remove it.)

### FR-8 Multi-tenant isolation
- **FR-8.1** Every number/message/conversation query in authenticated routes is
  scoped by `userId: session.user.id` (existing pattern). New endpoints follow it.
- **FR-8.2** Access tokens and `phoneNumberId`s are strictly per-tenant; one
  tenant's send must never use another tenant's credentials.
- **FR-8.3** Webhook routing maps incoming `phone_number_id` to the owning number's
  `userId` so inbound messages land in the correct tenant.

### FR-9 Config / docs
- **FR-9.1** Add `ENCRYPTION_KEY` and `META_CONFIG_ID` to `.env.example`.
- **FR-9.2** Fix `.env.example`: it currently lists a Postgres `DATABASE_URL` and
  omits Turso. Replace with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and the full
  Meta set (`META_WABA_ID`, `META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`,
  `META_WEBHOOK_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID`, `META_CONFIG_ID`,
  `ENCRYPTION_KEY`) by name only — never real values.
- **FR-9.3** Update `scratchpad.md` (repo-root living reference) in the same change:
  new/changed endpoints, schema fields, env vars, the two onboarding paths, webhook
  signature verification, and a dated change-log entry.

## Non-Functional Requirements

- **NFR-1 Security** — tokens AES-256-GCM encrypted at rest; never logged, never
  returned to clients; webhook authenticated via signature; secret-bearing fields
  referenced by key name in docs.
- **NFR-2 Isolation** — strict per-tenant scoping (see FR-8).
- **NFR-3 Compatibility** — Graph API `v19.0`; Next.js 14 App Router route handlers;
  Prisma + libSQL/Turso adapter; `prisma generate && next build` must pass;
  `npm run db:push` applies schema.
- **NFR-4 Consistency** — reuse existing patterns: `getServerSession(authOptions)`,
  `prisma` default import from `@/lib/db`, zod validation, `fetch` to Graph (no new
  Meta SDK dependency on the server).
- **NFR-5 Reliability** — onboarding writes are atomic (validate-before-persist);
  webhook POST stays resilient (200 on internal processing errors, except signature
  rejection).

## Acceptance Criteria (testable, numbered)

1. `npm run build` (`prisma generate && next build`) completes with no type or build
   errors.
2. `npm run db:push` applies the new `WhatsAppNumber` fields (encrypted token +
   status fields + `connectionType`) with no data loss on the existing Turso DB.
3. Webhook GET with `hub.mode=subscribe` and a matching
   `hub.verify_token=$META_WEBHOOK_VERIFY_TOKEN` returns the exact `hub.challenge`
   value with status 200.
4. Webhook GET with a wrong verify token returns 403 and does not echo the challenge.
5. Webhook POST with a missing/invalid `X-Hub-Signature-256` is rejected (401/403)
   and no message/conversation rows are created from that payload.
6. Webhook POST with a valid signature and a status payload updates the matching
   message by `metaMessageId` (delivered sets `deliveredAt`, read sets `readAt`,
   failed sets `errorMessage` and `status`).
7. Manual path: submitting invalid credentials (bad token or unreachable
   `phoneNumberId`) returns HTTP 400 with a descriptive message and creates **no**
   `WhatsAppNumber` row and stores **no** token.
8. Manual path: submitting valid credentials stores the number with an encrypted
   token and the real `wabaId`/`phoneNumberId`; the API response does not contain the
   plaintext token or ciphertext.
9. Encryption round-trip: a unit test encrypts a known string and decrypts it back
   to the original using `ENCRYPTION_KEY`; tampering with the ciphertext/auth tag
   causes decryption to throw.
10. Send path: a message sent from a number connected via either new path calls
    Graph with that number's own `phoneNumberId` and decrypted token (verified by
    the resolved values / mock), not the global env fallback.
11. Send-path regression: authentication template without the OTP variable returns
    400 before any message row or credit deduction; with the OTP variable the
    `button`/`sub_type: url` component is included (the #131008 fix); credit is
    deducted on send and refunded on failure; superadmin is not charged.
12. Chat free-text send (`/api/chat/[contactPhone]/send`) uses per-tenant
    credentials with the same resolution rules as `messages/send`.
13. Multi-tenant isolation: a user cannot connect, send from, or read a number owned
    by another `userId` (queries scoped by `session.user.id`); an inbound webhook for
    tenant A's `phone_number_id` creates rows under tenant A's `userId` only.
14. The fake 6-digit code flow is gone: `verify`/`confirm` no longer generate or
    accept an arbitrary local code to mark a number `verified`.
15. `.env.example` lists Turso + full Meta set + `ENCRYPTION_KEY` + `META_CONFIG_ID`
    by name, with no Postgres `DATABASE_URL`.
16. `scratchpad.md` is updated with the new endpoints, schema, env vars, and a dated
    change-log entry.
17. Number detail UI surfaces the real `code_verification_status` (and related Meta
    status fields) for a connected number.

## Out of Scope

- Submitting the Meta app for App Review or configuring the Embedded Signup
  Configuration ID (Meta-side, user-performed — see prerequisites).
- Paying Meta / topping up a WABA balance directly from the platform. Surfacing
  Meta-reported credit/limit status is in scope (US-D1); initiating payment to Meta
  is **not** (the platform's Razorpay billing is for app credits, a separate concern).
- Migrating the existing single global `META_*` number into a per-tenant record
  (design may note a path, but data migration is not required).
- Template creation/sync/submit flows (`/api/templates/*`) beyond ensuring they keep
  working; they already use `META_WABA_ID`/`META_ACCESS_TOKEN` globally.
- Switching off `db push` to adopt Prisma migrations.
- Rotating/refreshing long-lived tokens automatically (may be noted as future work).

## Meta-side manual prerequisites (user performs outside code)

1. In the Meta App dashboard, add and configure the **WhatsApp** product and set up
   **Embedded Signup** with a **Configuration ID** → put it in `META_CONFIG_ID`.
2. Submit the app for **App Review** and obtain approval for
   `whatsapp_business_management` and `whatsapp_business_messaging`.
3. Ensure `META_APP_ID` and `META_APP_SECRET` are set (app secret is needed for
   webhook signature verification and token exchange).
4. Configure the webhook callback URL (`/api/webhooks/whatsapp`) and
   `META_WEBHOOK_VERIFY_TOKEN` in the app, and subscribe to the `messages` field.
5. Generate the `ENCRYPTION_KEY` value (32 bytes for AES-256, e.g. base64/hex) and
   set it in the environment. Store it securely; losing it makes stored tokens
   undecryptable.
6. Make the app Live (not Development mode) for real tenants to connect.

## Open questions / ambiguities for the design step

1. **Embedded Signup return shape** — does the design use the Meta JS SDK session
   response (which can return `waba_id` / `phone_number_id` directly) plus a code
   exchange, or a pure OAuth code exchange? Confirm the exact token type stored
   (user access token vs. system-user token) and its lifetime/refresh story.
2. **Token scope per number vs. per WABA** — a single token can cover multiple
   phone numbers under one WABA. Store the token on each `WhatsAppNumber`, or
   introduce a `WabaConnection` parent record keyed by `wabaId`? (Affects schema.)
3. **Env-fallback on send** — keep `?? process.env.META_PHONE_NUMBER_ID` /
   `META_ACCESS_TOKEN` for the legacy global number, or remove it and require every
   number to carry its own creds? (FR-6.4.)
4. **Webhook inbound fallback** — the current POST falls back to the env phone-number
   ID and then "any verified number" when it can't match `phone_number_id`. In
   multi-tenant mode that can misattribute messages. Keep, restrict, or remove?
   (FR-7.4.)
5. **"Credits / amount in facebook account"** — which Meta field satisfies US-D1?
   Options: WABA `account_review_status`, phone number `messaging_limit_tier`,
   business balance (not exposed via standard Graph for most apps). Design must pick
   what is actually fetchable and how often to poll/cache it.
6. **Exact new schema fields** and whether to reuse `verificationStatus` or add a
   distinct `connectionStatus`.
7. **Signature verification raw-body handling** — in Next.js App Router, confirm the
   method for reading the raw request body (`await request.text()`) before JSON
   parsing so the HMAC matches Meta's bytes exactly.
8. **Manual-path validation call** — which Graph endpoint best proves a token+IDs
   are valid without side effects (e.g. `GET /{phone_number_id}` for fields, or
   `GET /{waba_id}/phone_numbers`)?
9. **Should `POST /api/numbers` (bare phone string) survive at all**, and if so in
   what reduced role? (FR-5.2.)
