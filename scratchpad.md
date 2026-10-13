# WhatsApp Business Messaging Platform — Technical Reference

Last updated: 2026-10-17

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
- `src/lib/meta-app` — per-tenant Meta **app** resolver. `resolveMetaAppCredentials(userId)`
  returns `{ appId, appSecret, configId, source }`: a `TenantMetaApp` row (decrypted
  secret) takes precedence (`source: "tenant"`), else falls back to the platform
  env `META_APP_ID` / `META_APP_SECRET` (+ `NEXT_PUBLIC_META_CONFIG_ID`, read
  server-side) (`source: "platform"`). A bad decrypt or missing platform env throws
  `MetaAppConfigError` (generic message); the ciphertext never leaves the resolver
  and is never logged. This is the Model B (own app) / Model A (platform fallback)
  precedence used by embedded-signup and surfaced by `GET /api/meta-app`.
- `src/lib/whatsapp` — shared onboarding/send helpers: `normalizePhone`
  (strip non-digits), `serializeNumber` (drop `accessToken` ciphertext from API
  responses), `resolveSendCredentials` (decrypt the number's own token for the
  send path — `{ phoneNumberId, accessToken }`, no env fallback),
  `resolveWabaCredentials` (sibling resolver for the template routes — returns
  `{ wabaId, accessToken }` from the number's own decrypted token, no env
  fallback; the single owner of template-route decrypt logic),
  `NumberOwnedByOtherTenantError`, `upsertNumberForUser`
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
- Settings — bring-your-own Meta app (Model B): tenants connect their own Meta
  app (App ID, Config ID, write-only App Secret) at `/dashboard/settings`, or
  disconnect to fall back to the platform app (Model A).
- Audit logging.

### Dashboard layout composition (shell + independent components)

The dashboard chrome is split into independent, single-responsibility
components, orchestrated by a thin client shell so the server layout keeps the
auth boundary:

| Component | File | Type | Responsibility |
|---|---|---|---|
| `DashboardLayout` | `src/app/dashboard/layout.tsx` | Server | `getServerSession` → `redirect("/login")` if no session; renders `<DashboardShell>{children}</DashboardShell>`. Holds no presentation state. |
| `DashboardShell` | `src/components/dashboard/dashboard-shell.tsx` | Client | Owns the drawer `open` state and the three effects (close on `pathname` change; Escape-to-close + body-scroll-lock, both guarded to run only below `lg`; a `matchMedia("(min-width:1024px)")` `change` listener that force-closes on crossing into `lg+`). Lays out `Sidebar` + content column (`Header` → `main` → `Footer`). `main` is `flex min-w-0 flex-1 flex-col p-4 sm:p-6`. |
| `Header` | `src/components/dashboard/header.tsx` | Client | Top bar; receives `isOpen` + `onMenuClick`. Hamburger (`lg:hidden`, `aria-label` + `aria-expanded`), truncating welcome text, email `hidden md:inline`, avatar + logout (`signOut({ callbackUrl: "/login" })`). |
| `Sidebar` | `src/components/dashboard/sidebar.tsx` | Client | Nav + bottom links; receives `isOpen` + `onClose`. Backdrop (`fixed inset-0 z-30 bg-black/50 lg:hidden`) + panel (`fixed inset-y-0 left-0 z-40 w-64`, `-translate-x-full`/`translate-x-0`, `lg:static lg:translate-x-0`). Dark `bg-gray-900 text-white`. |
| `Footer` | `src/components/dashboard/footer.tsx` | Client | Product name + `© {year}` copyright + links to `/docs` and `/privacy-policy`. White bar, `text-gray-500`, stacks `flex-col` then `sm:flex-row`. Rests at viewport bottom on short pages (flex column + `flex-1` main). |

**Mobile-responsive strategy.** `lg` (1024px) is the single switch. At `lg+` the
sidebar is the fixed visible `w-64` dark column and no hamburger shows. Below
`lg` the sidebar is an off-canvas slide-in drawer opened by the Header
hamburger, with a dimming overlay that closes on overlay click, Escape, or route
change; body scroll is locked while open (and only below `lg`). Content pages
stack first and widen up (`flex-col`→`sm:flex-row`, `flex-wrap`, `grid-cols-1`→
`sm:grid-cols-*`): numbers/templates list cards and page header rows wrap, the
messages table scrolls inside its `overflow-x-auto` container (page kept from
widening via `min-w-0` on the content column + `main`), `messages/send` Compose +
Preview is `grid-cols-1 lg:grid-cols-2`, and the chat page shows one panel at a
time below `lg` (list when no `?contact=`, thread with an `ArrowLeft` back button
when one is selected) while keeping both side by side at `lg+`.

### UI pages (dashboard)

- `/dashboard/settings` — tabbed settings (client page) with three tabs:
  **Profile**, **Security**, and **Meta App**.
  - **Profile** tab: read-only Account Info (email + verified badge, join date)
    plus an Edit Profile form (full name, phone, company) → `GET`/`PUT
    /api/settings/profile`; on save it also calls `updateSession`.
  - **Security** tab: Change Password form (current + new + confirm, min 8 chars,
    client-side match check) → `PUT /api/settings/password`.
  - **Meta App** tab (described below). Loads
  `GET /api/meta-app`; shows a `Using your own app` / `Using platform app` badge
  from `source`; the App Secret input is `type="password"` and never pre-filled,
  with the helper **"Secret is stored"** when a tenant secret exists (storage
  fact — `GET` does not decrypt), else "No tenant secret stored (using platform
  app)". Save → `PUT /api/meta-app` (secret sent only when typed; `configId`
  null-to-clear / omit-to-keep). Disconnect → `DELETE /api/meta-app` then
  re-fetch. API errors (incl. 401) surface inline; the page never self-redirects
  (the `/dashboard` server layout is the auth boundary). The secret is never
  rendered back.
- `/dashboard/numbers/add` — connect page. Fetches the effective app/config at
  runtime from `GET /api/meta-app` and drives `FB.init` / `FB.login` from it (no
  build-time `NEXT_PUBLIC_*` reads). When either value is absent it shows the
  verbatim "Embedded Signup is not configured yet…" message. The manual-
  credentials form (→ `POST /api/numbers/manual`) is gated only on its own
  `showManual` toggle, so a null/failed config never hides the manual path.

### Public pages

- `/privacy-policy` — static server-rendered Privacy Policy page (real route;
  linked from the login/register pages and the dashboard Footer).
- `/docs` — **Developer Documentation** (server component, no client JS). Public
  integration guide at route `/docs`: Overview (Model A/B), prerequisites, how to
  get a WhatsApp access token (temporary / System User / Embedded Signup, with the
  "No permissions available" and "App can't be updated" pitfalls), connecting a
  number (manual + Embedded Signup), sending (template + chat free-text, OTP note,
  1-credit cost), receiving data via the Meta webhook, a full API reference built
  from the real route handlers (methods, paths, zod/destructured bodies, sample
  curl + JSON, status codes), an end-to-end walkthrough, an env-name-only table,
  and a troubleshooting table. Honest about auth: session-cookie guarded, no
  API-key scheme. Linked from the dashboard sidebar as "Developer Docs".

## Onboarding paths (connecting a WhatsApp number)

A number is only ever marked `verified` by connecting real Meta credentials.
There is no local "enter a code we generated" flow anymore. Both paths validate
against Meta BEFORE any DB write, store the per-tenant token encrypted, and
reject cross-tenant collisions with 409.

- **Path A — Meta Embedded Signup** (`POST /api/numbers/embedded-signup`):
  the dashboard opens Meta's OAuth popup via the Facebook JS SDK using the
  **effective** app id + config id, fetched at runtime from `GET /api/meta-app`
  (the tenant's own app if connected, else the platform fallback — see "Model
  A/B Meta app" below). The returned OAuth `code` is posted to the server, which
  resolves the app credentials via `resolveMetaAppCredentials(userId)` (tenant
  app or platform env), exchanges the code (with that `appId` + `appSecret`, no
  redirect_uri) for a business token, resolves the WABA id
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

### Model A/B Meta app (bring-your-own-app with platform fallback)

Each tenant may connect **their own** Meta app (**Model B**) via the Settings
page, overriding the platform app for OAuth code exchange and inbound-webhook
signature verification. A tenant with no `TenantMetaApp` row falls back to the
platform env app (**Model A**) — byte-for-byte today's behavior. Precedence
(per-tenant overrides platform) lives in `resolveMetaAppCredentials` (`src/lib/meta-app`).
No new env var was added — per-tenant app credentials live encrypted in the DB
(`TenantMetaApp`). The platform `NEXT_PUBLIC_META_CONFIG_ID` is read **both**
client-side (build-time inlined) **and** server-side (by `resolveMetaAppCredentials`
and `GET /api/meta-app`); the `NEXT_PUBLIC_` prefix only controls client-bundle
inlining, it does not block a server-side `process.env` read. The connect page
fetches the effective config id at runtime, so a tenant's own Config ID overrides
the platform one without a rebuild.

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
| POST | `/api/templates/[id]/submit` | Submit template to Meta (per-tenant WABA; optional `numberId` in body) |
| POST | `/api/templates/[id]/duplicate` | Duplicate a template |
| POST | `/api/templates/sync` | Sync template statuses from Meta (iterates ALL of the tenant's connected WABAs) |
| GET/POST | `/api/messages` | List / query messages |
| POST | `/api/messages/send` | **Send a template message via Meta** |
| GET | `/api/chat/conversations` | List conversations |
| GET | `/api/chat/[contactPhone]/messages` | Messages for a contact |
| POST | `/api/chat/[contactPhone]/send` | Send a chat message |
| POST | `/api/chat/test-inject` | Test helper: inject an inbound message |
| GET | `/api/credits/balance` | Credit balance |
| POST | `/api/payments/create-order` | Create a Razorpay order |
| POST | `/api/payments/verify` | Verify a Razorpay payment |
| GET | `/api/meta-app` | Effective Meta app config for the tenant (`{ appId, configId, source, hasSecret }`) — secret VALUE never returned |
| PUT | `/api/meta-app` | Create/update the tenant's own Meta app (atomic upsert; secret write-only + required-on-create; `configId` null clears / omit keeps) |
| DELETE | `/api/meta-app` | Disconnect the tenant's own app → revert to platform fallback (idempotent `{ ok: true }`) |
| GET/PATCH | `/api/settings/profile` | Profile settings |
| PATCH | `/api/settings/password` | Change password |
| GET | `/api/admin/stats` | Admin dashboard stats |
| GET/POST | `/api/admin/users` + `/[id]` | Admin user management |
| GET/POST | `/api/admin/packages` + `/[id]` | Admin package management |
| GET/POST | `/api/webhooks/whatsapp` | Meta webhook — GET handshake; POST verifies `X-Hub-Signature-256` then routes inbound/status (see Webhook flow) |
| POST | `/api/v1/messages` | **Public M2M** — send a template via the key's bound number. Auth: `Authorization: Bearer wa_live_...` only (no session, no client credential). Body `{ recipient, templateName \| templateId, variables? }` (exactly one template key). 200 `{ id, status, metaMessageId }` / 400 / 401 / 402 (credits) / 404 (template) / 500 |
| GET | `/api/v1/messages/[id]` | **Public M2M** — message status. API-key auth; scoped to owner + bound number. 200 projection (`id,status,recipientPhone,metaMessageId,errorMessage,sentAt,deliveredAt,readAt,createdAt`) / 401 / 404 (identical for unknown vs other-owner/number — no oracle) |
| GET | `/api/v1/templates` | **Public M2M** — owner's templates (`id,name,category,language,status`). API-key auth; optional `?status` validated against draft/pending/submitted/approved/rejected (400 on unknown). 200 list / 401 / 400 |

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

### Shared send core — `sendTemplateMessage` (`src/lib/send-template.ts`)

The entire send core (OTP guard → credit check → message create → deduct →
`resolveSendCredentials` → Meta fetch → status update → refund-on-failure) was
**extracted verbatim** out of `POST /api/messages/send` into
`sendTemplateMessage(input): Promise<SendTemplateResult>` so the session route and
the public `POST /api/v1/messages` route share one code path and can never drift.

- **Input:** `{ userId, number, template, recipient, variables?, isSuperAdmin }`.
  The caller resolves+scopes the `number` and `template` and computes
  `isSuperAdmin` **exactly once**, passing a single boolean through the credit
  check, deduct, and refund (symmetric credit math). The helper never reads a
  session, never re-derives superadmin, and never builds a `NextResponse`.
- **Result:** `{ ok:true, message:{ id, status:"sent", metaMessageId } }` or
  `{ ok:false, code, error }` where `code` ∈ `{400 (missing OTP), 402
  (insufficient credits), 500 (not-connected / Meta non-2xx, refund already
  applied)}`.
- **402 vs 400:** the helper returns **402** for insufficient credits. The
  **session wrapper remaps 402→400** to preserve its legacy dashboard code; the
  **public route surfaces 402 verbatim**. This is the one deliberate asymmetry.
- The `[Send]` / `[Meta]` console lines moved verbatim; no plaintext token is
  logged. `src/app/api/messages/send/route.ts` is now a thin session wrapper
  (session 401 → field 400 → number 400 → template 400 → `sendTemplateMessage` →
  402→400 remap → success body `{ id, status:"sent", message:"Message sent
  successfully" }`), observably identical to the pre-refactor route except that remap.

### Public M2M API (`/api/v1/*`) — API-key auth only

A machine-to-machine surface authenticated **only** by a per-tenant API key
(`Authorization: Bearer wa_live_...`), strictly separate from the session-cookie
world. A third party supplies **zero** Meta credentials and **zero** number info:
the key is bound server-side to one `WhatsAppNumber`, and the send always uses
that bound number (any client-supplied number/credential field is ignored).

- **Auth helper `authenticateApiKey(request)` (`src/lib/api-auth.ts`):** parses
  `Bearer <token>`, shape-gates via `looksLikeApiKey` (no DB hit on a bad shape),
  `sha256`-hashes the token, `prisma.apiKey.findUnique({ keyHash })`, rejects
  null/revoked, does a length-guarded `crypto.timingSafeEqual` on the hash,
  loads the bound `WhatsAppNumber` (null → reject), fires a best-effort
  (not awaited, `.catch`) `lastUsedAt` update, and returns
  `{ userId, apiKey, number }` or `null`. Every failure (missing/malformed
  header, wrong shape, unknown key, revoked key, vanished number) returns `null`
  → `unauthorized()` 401 `{ error: "Invalid or missing API key" }` with **no
  oracle**. The token and hash are never logged.
- **`POST /api/v1/messages`:** zod body `{ recipient, templateName?, templateId?,
  variables? }` with an XOR refine (both or neither template key → 400); resolves
  the template owner-scoped (not-found → 404, exists-but-not-approved → 400);
  computes `isSuperAdmin` once via `isSuperAdminUser(owner)` (email-driven, so a
  superadmin whose DB `role` is `"admin"` is not charged); calls the shared
  `sendTemplateMessage` with `ctx.number`; maps `ok:true` → 200 `{ id, status,
  metaMessageId }` and `ok:false` → the helper code verbatim (402/400/500).
- **`GET /api/v1/messages/[id]`:** `findFirst` scoped to `{ id, userId,
  whatsappNumberId }` — a non-matching id (unknown OR other-owner/other-number)
  returns the identical 404; the path id is never logged. Returns a
  non-credential `select` allow-list.
- **`GET /api/v1/templates`:** scoped to `ctx.userId`; optional `?status`
  validated against the known set (400 on unknown); returns an
  `id/name/category/language/status` allow-list, newest first.



Session-gated. No credit logic. Resolves credentials via
`resolveSendCredentials` for the selected (or first verified) number; a
decrypt/config throw is caught and leaves creds null. Missing creds → **500**
`{ error: "Meta API credentials not configured" }`. On a Meta API error the
message row is saved as `failed` and the route returns **422**. Only valid
inside WhatsApp's 24-hour customer-service window.

### Template-management flow — submit / sync / delete (per-tenant WABA)

All three routes resolve `{ wabaId, accessToken }` from the signed-in tenant's own
connected verified `WhatsAppNumber` via `resolveWabaCredentials` (in
`src/lib/whatsapp.ts`). There is **no** `META_WABA_ID` / `META_ACCESS_TOKEN` env
read in these routes. A "usable" number is `verificationStatus === "verified"`
with non-null stored `wabaId` + encrypted `accessToken`. Every DB query and every
Meta call is scoped by `session.user.id`; a user can only act on a WABA they own.

**Template → WABA mapping decision** (submit & delete pick a single number):
1. explicit `numberId` from the request body (submit only) — must be a usable
   number owned by the user; if not → 400 `NUMBER_NOT_CONNECTED`;
2. else the template's own `Template.whatsappNumberId` binding, if still usable
   (a stale binding falls through);
3. else the tenant's sole usable number;
4. else 0 usable → 409 "Connect a WhatsApp number before managing templates";
   >1 usable and none chosen/bound → 400 `AMBIGUOUS_NUMBER` (never silently pick).

- **Submit** (`POST /api/templates/[id]/submit`): keeps `buildComponents`, Meta
  name sanitization, the 1024-char body guard (before credential resolution), the
  `META_TOKEN_EXPIRED` (Meta code 190 / "Session has expired") → 401 branch, and
  the success write-back (`status: "submitted"`, `metaTemplateId`, `submittedAt`).
  **Additive:** on success it binds `whatsappNumberId` to the resolved number when
  the template was not already bound, so later sync/delete reuse the exact WABA.
  Accepts an optional `numberId` in the body (single-number tenants omit it and
  are auto-resolved — the existing frontend contract still works).
- **Sync** (`POST /api/templates/sync`): takes no params. Resolves all usable
  numbers, dedupes by `wabaId` (first number per WABA wins), fetches
  `GET /{wabaId}/message_templates` once per distinct WABA, and tags each fetched
  template with its source number (`__sourceNumberId`, transient). Meta-only
  imports are `create`d with `whatsappNumberId` = that source number. All
  downstream logic (status/category mapping, dedup-by-name, update loop, response
  shape `{ synced, updated, imported, duplicatesRemoved }`) is unchanged. A
  per-WABA Meta 190 → 401 `META_TOKEN_EXPIRED`; other non-ok → 400; sync aborts on
  the first failing WABA.
- **Delete** (`DELETE /api/templates/[id]`): best-effort / non-fatal Meta delete.
  Resolves the number from `whatsappNumberId` (if usable) else the sole usable
  number; 0 or ambiguous → **skip** the Meta call and still delete locally. A
  decrypt throw is caught (warn, no token logged) and the Meta step skipped — the
  local `prisma.template.delete` always runs; response unchanged.

**Credential errors (submit & sync):** `resolveWabaCredentials` wraps `decrypt()`,
which can throw on a bad key / tampered ciphertext. Submit and sync catch it and
return a clean **500 `{ error: "credential error" }`** — never logging the token or
ciphertext. Delete treats a decrypt throw as non-fatal (skip + warn). No connected
number is always a clean 4xx (400/409), never a 500, never a silent env fallback.

### Webhook — `POST /api/webhooks/whatsapp`

Signature verification is **per-app** (Model A/B): Meta signs each payload with
the app secret of the app subscribed to that WABA, so the route tries a bounded
candidate-secret set. Load-bearing step order:

1. **Read the raw body once** so the HMAC is computed over the exact bytes Meta
   signed.
2. **Signature-header gate FIRST (no parse, no DB):** require
   `x-hub-signature-256` of the form `sha256=<hex>`; missing/malformed → warn +
   **401** with zero DB work. (This replaces the old unconditional
   `META_APP_SECRET`-missing 401, which was removed.)
3. **Peek-parse for routing only (bounded, untrusted):** parse the raw body in a
   try/catch solely to collect candidate `phone_number_id`s into a Set capped at
   `MAX_CANDIDATE_PHONE_IDS = 10` (legit payloads carry one); unparseable → `[]`.
   This value grants no trust — it only selects which secrets to try.
4. **Build the candidate-secret set:** platform `META_APP_SECRET` (if set) plus,
   for the capped ids, `whatsAppNumber.findMany({ phoneNumberId: { in } })` →
   distinct `userId`s → `tenantMetaApp.findMany` → `decrypt(metaAppSecret)`
   (undecryptable candidate skipped silently — no log, no crash). Reads the
   ciphertext directly rather than via the resolver to keep skip-bad-candidate
   semantics.
5. **Fail closed:** `secrets.size === 0` → **401** (relocated "no usable secret").
6. **Constant-time compare:** for each candidate compute
   `HMAC-SHA256(secret, raw)` hex and compare with length-guarded
   `crypto.timingSafeEqual`; accept iff one matches, else warn + **401**. No
   secret/ciphertext is ever logged on any branch.
7. On verified, fall through to the UNCHANGED processing (status updates +
   inbound routing below). **Intended behavior change:** with `META_APP_SECRET`
   unset, a Model B tenant's event still verifies against their own secret
   (today's code blanket-401'd everything); Model A tenants still 401 with no
   platform secret.

Processing (after verify, unchanged):
- **Status updates:** `statuses[]` update the matching `Message` by
  `metaMessageId` (`updateMany`) — set `status`, plus `deliveredAt` / `readAt` /
  `errorMessage` as applicable.
- **Inbound messages:** resolve the owning number STRICTLY by the inbound
  `metadata.phone_number_id` (no env fallback, no "any verified number"
  fallback — a payload for a tenant's `phone_number_id` may only write under
  that tenant). If no number matches, skip. Otherwise upsert the conversation
  and create an inbound `Message` (`direction: "inbound"`, `status: "received"`).
- After processing (or on any parse error) return **200** so Meta does not
  retry; the signature-gate 401s are the only non-200 on POST.

The **GET** handshake echoes `hub.challenge` with 200 when `hub.mode ===
"subscribe"` and `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN`, else 403.

## Schema (Prisma / `prisma/schema.prisma`)

| Model | Key fields | Relationships |
|-------|-----------|---------------|
| `User` | email (unique), passwordHash, role (`admin`/`superadmin`), isActive | has many numbers, templates, messages, payments, conversations, auditLogs; one credits |
| `UserCredits` | userId (unique), totalCredits, usedCredits | belongs to User |
| `TenantMetaApp` | userId (unique — one app per tenant), **metaAppId** (plaintext), **metaAppSecret** (AES-256-GCM ciphertext at rest — never plaintext/logged/returned), configId (optional Embedded Signup Config ID), createdAt, updatedAt | belongs to User (`onDelete: Cascade`, enforced by Prisma; hand-written Turso table omits DB-level FK) |
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
| `META_APP_ID` | Platform (Model A) Meta app ID; used for the Embedded Signup OAuth code exchange when a tenant has no own app |
| `META_APP_SECRET` | Platform (Model A) Meta app secret; OAuth code exchange + webhook `X-Hub-Signature-256` verification for platform-app tenants. Model B tenants verify against their own secret; keep it set so platform-app delivery updates aren't 401'd |
| `META_ACCESS_TOKEN` | Legacy / unused by app code — send AND template routes are strict per-tenant now (kept only for ad-hoc read-only Graph checks) |
| `META_PHONE_NUMBER_ID` | Legacy / unused by app code (per-tenant now) |
| `META_WABA_ID` | Legacy / unused by app code — template routes resolve the WABA per-tenant now |
| `META_WEBHOOK_VERIFY_TOKEN` | Verify token the webhook GET handshake must echo |
| `NEXT_PUBLIC_META_APP_ID` | Platform (Model A) Meta app ID for the Facebook JS SDK (build-time inlined; connect page uses the effective value from `GET /api/meta-app` at runtime) |
| `NEXT_PUBLIC_META_CONFIG_ID` | Platform (Model A) Embedded Signup Configuration ID. Inlined into the client bundle at build time AND read server-side by `resolveMetaAppCredentials` / `GET /api/meta-app` (the `NEXT_PUBLIC_` prefix does not block server reads); the connect page fetches the effective (tenant-or-platform) value at runtime |
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
- `NEXT_PUBLIC_*` vars are inlined into the client bundle at build time, so any
  code that reads the inlined constant directly needs a rebuild to pick up a new
  value. The connect page no longer reads `NEXT_PUBLIC_META_APP_ID` /
  `NEXT_PUBLIC_META_CONFIG_ID` directly — it fetches the effective app/config at
  runtime from `GET /api/meta-app` — so a tenant's own app (Model B) takes effect
  without a rebuild. Both NEXT_PUBLIC_ Meta vars are also read server-side as
  plain env vars (the prefix only controls client-bundle inlining).
- Live Meta OAuth / send / delivery paths need a Meta Config ID + App Review +
  a real token (all user-supplied) and cannot be exercised end-to-end from code
  alone; verify handler shape, zod rejects, and the 400/409/500 branches.
- The template routes (submit/sync/delete) are **no longer single-WABA**: they
  resolve the WABA per-tenant from the signed-in user's connected verified number
  (`resolveWabaCredentials`), not from `META_WABA_ID` / `META_ACCESS_TOKEN`. A
  tenant with 2+ connected numbers must pass `numberId` to submit (the UI shows a
  selector), or Meta submission returns 400 `AMBIGUOUS_NUMBER`; a tenant with none
  connected gets 409, never a 500 and never a silent env fallback. No schema
  change was needed — `Template.whatsappNumberId` already existed and now records
  which WABA a template was submitted to / imported from.
- `request.json()` can be read only once; the submit route reads both
  `sampleValues` and `numberId` from a single `reqBody` object — adding a second
  `await request.json()` throws "body already read".
- `scripts/test-crypto.mjs` intentionally re-implements the crypto format inline
  (no import from `src/lib/crypto.ts`) so it runs under plain `node` with no
  compile step or new dependency.

## Change log

### 2026-10-17 (public API / M2M — FEAT-002: public /api/v1 surface + send refactor)

- **New `src/lib/api-auth.ts`** — `authenticateApiKey(request)` (Bearer parse →
  `looksLikeApiKey` shape gate, no DB on bad shape → `sha256` → `apiKey.findUnique`
  by `keyHash` → reject null/revoked → length-guarded `timingSafeEqual` →
  load bound `WhatsAppNumber` → best-effort fire-and-forget `lastUsedAt` →
  `{ userId, apiKey, number }` | `null`) and `unauthorized()` (401 `{ error:
  "Invalid or missing API key" }`). Token/hash never logged; all failures 401
  with no oracle.
- **New `src/lib/send-template.ts`** — `sendTemplateMessage(input)`, the send core
  extracted **verbatim** from the old `POST /api/messages/send` body (OTP guard →
  credit check → message create → deduct → `resolveSendCredentials` → Meta fetch →
  status update → refund-on-failure). Returns a plain `{ ok:true, message } |
  { ok:false, code, error }`, never a `NextResponse`, never reads a session.
  `isSuperAdmin` is supplied once by the caller and threaded through check/deduct/
  refund (symmetric credit math). Insufficient credits → **402**.
- **Rewrote `src/app/api/messages/send/route.ts`** as a thin session wrapper over
  `sendTemplateMessage`. Observable behavior is byte-for-byte identical to the
  pre-refactor route (confirmed by git diff + a code/string/body trace) **except**
  the internal **402→400 remap** so the dashboard keeps its legacy
  insufficient-credits code. OTP-before-credits-before-side-effect ordering
  preserved (OTP guard runs first inside the helper, still before any mutation).
- **New public `/api/v1` routes (API-key auth only, no session):**
  - `POST /api/v1/messages` — zod `{ recipient, templateName|templateId (XOR),
    variables? }`; ignores any client number/credential and always uses
    `ctx.number`; template resolved owner-scoped (404 not-found / 400 not-approved);
    `isSuperAdmin` via `isSuperAdminUser(owner)` computed once; maps the helper
    result (200 `{ id, status, metaMessageId }` / 402 / 400 / 500 verbatim).
  - `GET /api/v1/messages/[id]` — `findFirst` scoped to owner + bound number;
    identical 404 for unknown vs other-owner/number; path id never logged;
    non-credential `select` allow-list.
  - `GET /api/v1/templates` — scoped to `ctx.userId`; optional `?status` validated
    (400 on unknown); `id/name/category/language/status` allow-list.
- **Verification:** `npm run build` (`prisma generate && next build`) → exit 0;
  all three `/api/v1` routes compile. `grep -rn "wa_live_|keyHash" src` shows only
  the `PREFIX` constant and `keyHash` used as a Prisma `where`/compare field — no
  secret is logged. Static trace confirmed: no client number/credential accepted,
  `isSuperAdminUser` computed once, symmetric credit math. `npm run lint` could
  not complete in this environment (pre-existing: `next lint` drops into an
  interactive config prompt because the project ships no ESLint config); the lint
  pass inside `next build` succeeded.

### 2026-10-16 (public API / M2M — FEAT-001: data layer + key helpers)

- **New `ApiKey` Prisma model** in `prisma/schema.prisma` for machine-to-machine
  public API auth. Fields: `id` (cuid), `userId` + cascade `user` relation,
  `whatsappNumberId` + cascade `whatsappNumber` relation (immutable binding),
  `name String?`, `keyPrefix` (non-secret display fragment), `keyHash String @unique`
  (SHA-256 hex, never plaintext), `lastUsedAt?`, `revokedAt?`, `createdAt`,
  `updatedAt`, `@@index([userId])`. Added inverse `apiKeys ApiKey[]` to `User` and
  `WhatsAppNumber`. No standalone `@@index([keyHash])` (the `@unique` already
  creates the lookup index).
- **New `scripts/add-api-key-table.mjs`** — idempotent live-Turso migration cloned
  from `add-tenant-meta-app-table.mjs` (manual `.env` parse, `@libsql/client`,
  single `PRAGMA table_info` probe for the log line, three unconditional
  `IF NOT EXISTS` DDL statements, `process.exit(1)` on error, `client.close()` in
  `finally`). Creates the `ApiKey` table plus `ApiKey_keyHash_key` (unique) and
  `ApiKey_userId_idx`. No FOREIGN KEY, no SQL timestamp defaults. Run against live
  Turso; second run is a clean no-op. `prisma db push` is never used (libsql://).
- **New `src/lib/api-key.ts`** — pure, DB-free helpers: `generateApiKey()`
  (`wa_live_` + 32 random bytes base64url; returns `{plaintext, hash, prefix}`),
  `hashKey()` (deterministic SHA-256 hex), `looksLikeApiKey()` (shape gate:
  prefix + length ≥ 51), and `isSuperAdminUser({email, role})` (email override via
  `SUPERADMIN_EMAIL` default `neanvtech@gmail.com`, OR `role === "superadmin"`).
  Never logs plaintext/hash/random bytes. Foundation for FEAT-002/003.

### 2026-10-15 (dashboard layout refactor + mobile responsiveness)

- **Refactored the dashboard shell into independent components and made every
  dashboard screen mobile-responsive (presentation-only; no API/route/logic
  change).**
  - **New `src/components/dashboard/dashboard-shell.tsx`** (`"use client"`) — the
    client shell that owns the drawer `open` state and the pathname-close,
    Escape+scroll-lock (guarded below `lg`), and `matchMedia` resize-close
    effects; composes `Sidebar` + (`Header` → `main` → `Footer`) with `main` as a
    `flex min-w-0 flex-1 flex-col p-4 sm:p-6` column.
  - **New `src/components/dashboard/footer.tsx`** (`"use client"`) — product name,
    `© {year}` copyright, and links to `/docs` and `/privacy-policy` (both are
    real routes). White bar, gray palette, `flex-col`→`sm:flex-row`.
  - **`src/app/dashboard/layout.tsx`** — reduced to the server-side session gate
    plus `return <DashboardShell>{children}</DashboardShell>`.
  - **`header.tsx`** — added `isOpen`/`onMenuClick` props, a `lg:hidden` hamburger
    with `aria-label` + `aria-expanded`, truncating welcome text, `hidden
    md:inline` email, `aria-label="Log out"`.
  - **`sidebar.tsx`** — now a backdrop + off-canvas panel keyed off `isOpen`
    (`-translate-x-full`/`translate-x-0`, `lg:static lg:translate-x-0`); nav
    items, active-highlight logic, and the two bottom links (`/docs`,
    `/dashboard/settings`) preserved verbatim; dark palette unchanged.
  - **`chat/page.tsx`** — root `flex min-h-0 flex-1` (dropped fixed `100vh`); list
    wrapper `w-full lg:w-[340px]` with `contactParam ? "hidden lg:flex" :
    "flex"`; placeholder branch `hidden lg:flex`; added a `lg:hidden` `ArrowLeft`
    back button (`router.push("/dashboard/chat")`). Polling/send/search/new-chat
    logic unchanged.
  - **Content pages** — `numbers`, `templates`, `messages` header rows and card
    action clusters now stack/wrap (`flex-col sm:flex-row`, `flex-wrap gap-2`);
    `numbers/[id]` detail grid `grid-cols-1 sm:grid-cols-2`; `templates/new` and
    `templates/[id]` inner grids `grid-cols-1 sm:grid-cols-*` and category/submit
    rows `flex-wrap`; `settings` tab bar `flex-wrap`; `payments` balance row
    `flex-col sm:flex-row`. `dashboard` home, `numbers/add`,
    `numbers/[id]/verify`, `messages/send` were already responsive (verify-only).
  - **Responsive behavior:** at ≥1024px the sidebar is a visible fixed `w-64`
    column with no hamburger; below 1024px it is hidden and the Header hamburger
    opens a left slide-in drawer with a dimming overlay that closes on nav click,
    Escape, and overlay click, with body-scroll lock while open. Footer renders
    on every dashboard route and sticks to the bottom on short pages.
  - **Note:** the design doc assumed `/privacy-policy` was a dead route; it is in
    fact a real page (`src/app/privacy-policy/page.tsx`), so the Footer links to
    it as the authoritative task instruction required.
  - **Verification:** `npm run build` (`prisma generate && next build`) → exit 0,
    "✓ Compiled successfully" + "Linting and checking validity of types" passed.
    No browser available; behavior cited from the exact Tailwind breakpoint
    classes per component. The pre-existing "Dynamic server usage" messages from
    API routes are unrelated to this change. `npm run lint` could not complete in
    this environment (hangs on an interactive `next lint` config prompt,
    pre-existing); the lint pass that runs inside `next build` succeeded.

### 2026-03-22

- **Add developer documentation page at `/docs`.** New server component
  `src/app/docs/page.tsx` (no client JS, matches the `privacy-policy` page
  conventions: header bar, in-page table of contents, white rounded cards,
  `pre/code` samples). Documents the two connection models (A: platform app, B:
  bring-your-own via Settings → Meta App), prerequisites, how to obtain a
  WhatsApp access token (temporary / System User / Embedded Signup incl. the "No
  permissions available" and "App can't be updated" pitfalls), connecting a
  number (manual + Embedded Signup), sending (template `POST /api/messages/send`
  with the auth-template OTP note + 1-credit cost, and chat free-text within the
  24h window), the Meta webhook (GET handshake vs signed POST,
  X-Hub-Signature-256, status + inbound routing) and how to read data back out,
  a full API reference grounded in the real route handlers (methods, paths,
  zod/destructured bodies, curl + JSON samples, 401/400/404/409/422/500 status
  codes as the code returns them), an end-to-end walkthrough, an env-name-only
  table, and a troubleshooting table. Honestly states that endpoints are
  session-cookie guarded (`getServerSession`) with no programmatic API-key
  scheme. Added a "Developer Docs" link to the dashboard sidebar
  (`src/components/dashboard/sidebar.tsx`). **Verification:** `npm run build`.

### 2026-10-15

- **Fix regression — restore Profile/Security settings alongside Meta App.** The
  FEAT-003 Settings page had replaced the pre-existing Profile + Security
  (password) settings UI wholesale, orphaning `/api/settings/profile` and
  `/api/settings/password` (no UI references). Reworked
  `src/app/dashboard/settings/page.tsx` into a 3-tab page (**Profile**,
  **Security**, **Meta App**): restored the original profile-edit and
  change-password forms (wired to `GET/PUT /api/settings/profile` and `PUT
  /api/settings/password`) and kept the Meta App Save/Clear/write-only-secret
  behavior as its own tab. No API shapes or the connect-page message changed.
  **Verification:** `npm run build` → exit 0; settings page compiles.

### 2026-10-14
- **FEAT-003 — Bring-Your-Own Meta App: user surfaces + docs (Model B + Model A
  fallback).** Final slice wiring the UI and docs onto the FEAT-001/002 resolver,
  CRUD route, and per-app webhook.
  - **New Settings page** `src/app/dashboard/settings/page.tsx` (`"use client"`):
    loads `GET /api/meta-app`, shows `source` badge + a write-only App Secret
    input (never pre-filled, helper "Secret is stored" when a tenant secret
    exists, not "valid"). Save → `PUT` (secret sent only when typed; `configId`
    null-to-clear / omit-to-keep); Disconnect → `DELETE` then re-fetch. Errors
    (incl. 401) inline; no self-redirect (the `/dashboard` server layout is the
    auth boundary). Secret never rendered back.
  - **Connect page** `src/app/dashboard/numbers/add/page.tsx`: removed the
    build-time `NEXT_PUBLIC_META_APP_ID` / `NEXT_PUBLIC_META_CONFIG_ID` module
    reads; now fetches the effective app/config at runtime from `GET /api/meta-app`
    into `cfg` state and drives `FB.init` / `FB.login` from it (SDK init effect
    gated on `cfg?.appId`). A failed/500 fetch leaves `cfg` null (treated as not
    configured) and does not crash. The "Embedded Signup is not configured yet…"
    message is kept VERBATIM (AC-7). The manual form (`/api/numbers/manual`) stays
    untouched and gated only on `showManual`, so a null `cfg` never hides it.
  - **`.env.example`:** reframed `META_APP_ID` / `META_APP_SECRET` as the
    platform (Model A) fallback used only when a tenant has no `TenantMetaApp`
    row; `META_WEBHOOK_VERIFY_TOKEN` noted platform-level/shared; replaced the
    stale "only ever read client-side" `NEXT_PUBLIC_META_CONFIG_ID` claim with
    the build-time-inlined-AND-server-side wording + runtime effective-fetch
    note; softened the "requires a REBUILD" caveat to the inlined client constant
    only; corrected the footer Configuration-ID bullet and `META_APP_SECRET` line
    (per-app verification). **No new env var introduced**; placeholders only.
  - **scratchpad.md:** documented the Model A/B app model, `src/lib/meta-app`
    resolver, `GET/PUT/DELETE /api/meta-app`, per-app bounded-candidate-secret
    webhook verification, the connect-page runtime effective-config fetch, and
    the new Settings page; corrected the "NO server-side META_CONFIG_ID" note.
  - **Verification:** `npm run build` (`prisma generate && next build`) → exit 0;
    settings + connect pages compile with no server-only imports in the client
    components.

### 2026-10-13
- **FEAT-001 — Bring-Your-Own Meta App foundation (Model B + Model A fallback).**
  First slice of per-tenant Meta app support. No route or UI changes yet
  (FEAT-002/003).
  - **Schema:** added `TenantMetaApp` model (`userId @unique`, `metaAppId`
    plaintext, `metaAppSecret` AES-256-GCM ciphertext, optional `configId`,
    `createdAt`/`updatedAt`, `onDelete: Cascade`) and `User.tenantMetaApp`
    back-relation in `prisma/schema.prisma`.
  - **Migration:** new idempotent `scripts/add-tenant-meta-app-table.mjs`
    (`CREATE TABLE/INDEX IF NOT EXISTS`; no DB-level FK, no
    `DEFAULT CURRENT_TIMESTAMP` — Prisma supplies all values). Applied live to
    Turso: run 1 created the table, run 2 was a clean no-op; `TenantMetaApp_userId_key`
    unique index confirmed.
  - **Resolver:** new `src/lib/meta-app.ts` exporting `ResolvedMetaApp`,
    `MetaAppConfigError`, and `resolveMetaAppCredentials(userId)` — per-tenant row
    (decrypted secret) takes precedence; falls back to platform
    `META_APP_ID`/`META_APP_SECRET` env (+ `NEXT_PUBLIC_META_CONFIG_ID`). Bad
    decrypt or missing platform env → `MetaAppConfigError`; never logs; ciphertext
    stays local.
  - Verified with `npm run build` (prisma generate exposes `prisma.tenantMetaApp`).

### 2026-10-12
- **Per-tenant migration of the three template-management routes.** Removed all
  `META_WABA_ID` / `META_ACCESS_TOKEN` env reads from
  `api/templates/[id]/submit`, `api/templates/sync`, and
  `api/templates/[id]` (DELETE). They now resolve `{ wabaId, accessToken }` from
  the signed-in tenant's own connected verified `WhatsAppNumber`.
  - Added `resolveWabaCredentials(number)` to `src/lib/whatsapp.ts` — a sibling to
    `resolveSendCredentials` (decrypts the row's own token; no env fallback;
    `decrypt` may throw → caller treats it as a credential error; never logs
    token/ciphertext). It is the single owner of template-route decrypt logic.
  - **Mapping decision:** explicit `numberId` → `Template.whatsappNumberId`
    binding → sole usable number → else 409 (none) / 400 `AMBIGUOUS_NUMBER` (>1).
    Submit now accepts an optional `numberId` and binds the template to the chosen
    number on success (additive write to the existing nullable column — no schema
    change). Sync iterates ALL of the tenant's usable WABAs (deduped by `wabaId`),
    binds Meta-only imports to their source number, and preserves the
    status/category mapping, dedup, update loop, and response shape. Delete stays
    best-effort/non-fatal (skip Meta on 0/ambiguous/decrypt-throw, always delete
    locally).
  - Preserved: `buildComponents`, Meta name sanitization, the 1024-char body
    guard, and `META_TOKEN_EXPIRED` (Meta code 190) → 401 (now also applied in
    sync). No connected number → clean 400/409 (never 500, never env fallback);
    decrypt throw in submit/sync → clean 500 `{ error: "credential error" }`.
  - **Frontend:** `dashboard/templates/new` and `dashboard/templates/[id]` load
    the user's connected verified numbers and show a number selector only when the
    tenant has 2+, passing `numberId` in the submit POST. Single-number tenants
    are unchanged (auto-resolved server-side).
  - **Env:** `META_WABA_ID` / `META_ACCESS_TOKEN` / `META_PHONE_NUMBER_ID` are now
    legacy / unused by app code.
  - **Verification:** `npm run build` (`prisma generate && next build`) → exit 0;
    grep of the three routes shows zero `META_WABA_ID` / `META_ACCESS_TOKEN`
    reads. No schema/column change (so no migration script was run).

### 2026-10-11 (b)
- **Removed the env credential fallback from the send path (strict per-tenant).**
  `resolveSendCredentials` (`src/lib/whatsapp.ts`) no longer falls back to
  `META_ACCESS_TOKEN` / `META_PHONE_NUMBER_ID`: it returns the number row's own
  decrypted token + phone number id, or nulls. A number with no stored
  credentials now fails to send with a clear "number not connected" error
  (`messages/send` → failed + credit refund; `chat/.../send` → 400) instead of
  silently sending from the shared/hardcoded env number.
- **`.env.example`:** dropped the per-tenant vars `META_ACCESS_TOKEN`,
  `META_PHONE_NUMBER_ID`, `META_WABA_ID` (these live encrypted per
  `WhatsAppNumber` row now). Remaining Meta vars are app-level only:
  `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` (one app, one
  webhook, shared by all tenants).
- **Known gotcha / follow-up:** the template routes `api/templates/sync`,
  `api/templates/[id]/submit`, and `api/templates/[id]` (delete) still read
  `META_WABA_ID` / `META_ACCESS_TOKEN` from env — they are NOT yet per-tenant and
  will only operate against the single env WABA. Making template management
  multi-tenant is a separate pending task.

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
