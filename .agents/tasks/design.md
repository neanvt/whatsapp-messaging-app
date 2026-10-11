# Technical Design — Meta WhatsApp Cloud API Multi-Tenant Onboarding

Last updated: 2026-10-11
Status: Design (revision 2 — resolves all 12 findings in `.agents/tasks/design-review.json`)
Requirements: `.agents/tasks/requirements.md`
Review addressed: `.agents/tasks/design-review.md` / `.agents/tasks/design-review.json` (see §17 "Review responses")

## 1. Overview

The app currently fakes WhatsApp number onboarding: `POST /api/numbers` stores a
bare phone string, `/api/numbers/[id]/verify` mints a random 6-digit code, and
`/api/numbers/[id]/confirm` flips a local flag to `verified`. Nothing touches Meta,
so numbers never carry a real `phoneNumberId` or a per-tenant token, every send
falls back to the single global `META_*` env pair, and "sent" never reflects real
delivery.

This design replaces the fake flow with real Meta WhatsApp Cloud API onboarding for
a multi-tenant SaaS. Each tenant connects their own WhatsApp Business number through
one of two paths and the app stores the real `wabaId`, `phoneNumberId`, and a
per-tenant access token (encrypted at rest). The send paths are rewired to use each
number's own credentials, and the existing Meta webhook gains request-signature
verification so delivery status becomes trustworthy.

The two paths are:

- **Path A — Embedded Signup (primary):** the WABA owner authenticates in Meta's
  OAuth popup (Facebook JS SDK); the app exchanges the returned code for a business
  token, discovers/validates IDs, subscribes the WABA to webhooks, registers the
  number, and stores everything.
- **Path B — Manual credential entry (fallback):** a developer/IT consultant who is
  logged in but cannot complete interactive OAuth/MFA (owner absent) enters the WABA
  ID, Phone Number ID, and an access token (recommended: a long-lived System User
  token); the app validates them live against Meta before saving.

### Resolution of the brief-vs-code discrepancies

The task brief and the requirements disagree on two points. The requirements are
authoritative because they are grounded in the actual code; this design follows the
code:

1. **Webhook location.** The brief says "create `src/app/api/webhooks/meta/route.ts`
   (new)". A webhook already exists at **`src/app/api/webhooks/whatsapp/route.ts`**
   with a working GET handshake and POST status/inbound handling. The Meta-side
   prerequisite docs already point the callback URL at `/api/webhooks/whatsapp`.
   **Decision:** enhance the existing `src/app/api/webhooks/whatsapp/route.ts`
   in place (add signature verification, tighten multi-tenant routing) rather than
   create a parallel `meta/route.ts`. Creating a second route would split webhook
   logic, require re-pointing the Meta callback URL, and leave dead code. The brief's
   intent — "the webhook verifies signatures and fixes the sent-but-never-delivered
   gap" — is fully met at the existing path.
2. **Second send path.** The brief only names `messages/send`. There is also
   `src/app/api/chat/[contactPhone]/send/route.ts` (free-text replies) with the same
   env-fallback bug. **Decision:** rewire both; a shared credential-resolution helper
   keeps them consistent.

### Technology stack (locked once approved)

| Area | Choice |
|------|--------|
| Framework | Next.js 14 App Router, route handlers returning `NextResponse` |
| Language | TypeScript 5 (strict, as configured) |
| ORM / DB | Prisma 5 (`driverAdapters`) + `@prisma/adapter-libsql` → Turso/libSQL (SQLite) |
| Auth | NextAuth v4 `getServerSession(authOptions)`, JWT sessions |
| Crypto | Node built-in `crypto` (`createCipheriv`/`createDecipheriv`, `createHmac`) — already used in `payments/verify` |
| Validation | zod (already a dependency) |
| Meta client | `fetch` to Graph API `v19.0` (no server SDK) |
| Frontend SDK | Facebook JS SDK loaded via a client `<script>` tag (no npm dep) |
| Schema apply | `npm run db:push` (Prisma `db push`), NOT migrations |

**New dependencies: zero.** Node `crypto` is built in; the FB SDK is a browser
script tag; zod and Prisma are already present. If, during implementation, a dep
proves unavoidable, it must be justified and pinned to an exact version — but the
design does not require one.

---

## 2. Schema changes (`prisma/schema.prisma`)

Extend `WhatsAppNumber` with the fields below. All new fields are **nullable** (or
have a default), no existing field or column is dropped, and the change is applied
with `npm run db:push` (safe additive change on SQLite — new nullable columns do not
touch existing rows).

```prisma
model WhatsAppNumber {
  id                     String    @id @default(cuid())
  userId                 String
  user                   User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  phoneNumber            String    @unique
  wabaId                 String?
  phoneNumberId          String?
  verificationStatus     String    @default("pending") // pending, in_progress, verified, failed
  verificationCode       String?
  verifiedAt             DateTime?

  // --- NEW: real Meta onboarding data ---
  accessToken            String?   // AES-256-GCM CIPHERTEXT at rest — never plaintext, never logged
  tokenExpiresAt         DateTime? // null = long-lived / System User token (no expiry)
  displayPhoneNumber     String?   // Meta display_phone_number
  verifiedName           String?   // Meta verified_name
  qualityRating          String?   // Meta quality_rating (GREEN/YELLOW/RED/UNKNOWN)
  codeVerificationStatus String?   // Meta code_verification_status (fixes US-E1 "not visible")
  platformType           String?   // Meta platform_type (CLOUD_API / ON_PREMISE)
  connectionType         String    @default("manual") // 'embedded_signup' | 'manual'

  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  templates     Template[]
  messages      Message[]
  conversations Conversation[]
}
```

Field-name reconciliation with the requirements: the requirements sketched
`accessTokenEnc` / `nameStatus`. The task brief fixes the exact names
(`accessToken`, `verifiedName`, `codeVerificationStatus`, `platformType`,
`connectionType default "manual"`). **The brief's names win** — they are listed as
the concrete contract. The ciphertext-only invariant is enforced in code and
documented inline, not via the column name.

**Token-scope decision (requirements open question #2):** store the token on each
`WhatsAppNumber` row (not a separate `WabaConnection` parent). Rationale: the
existing model, send paths, and webhook routing all key off the number row; a
per-WABA parent would be a larger refactor for a benefit (dedup of a token across
numbers of one WABA) that the current single-number-per-tenant usage does not need.
When Embedded Signup returns multiple phone numbers under one WABA, the same
decrypted business token is simply encrypted and stored on each number row. This is
noted as future-work consolidation, not required now.

`verificationCode` is retained in the schema (dropping a column is out of scope and
db:push-unsafe for data) but is no longer written by any real flow.

---

## 3. Encryption utility (`src/lib/crypto.ts`, new)

A single reusable helper providing authenticated encryption for per-tenant tokens.

**Algorithm & encoding (decisions):**
- **Cipher:** AES-256-GCM.
- **Key:** read from `process.env.ENCRYPTION_KEY`. **Encoding = base64 of 32 raw
  bytes** (i.e. a 44-char base64 string decoding to exactly 32 bytes). Base64 chosen
  over hex because it is shorter in env files and matches the base64 convention used
  for the stored ciphertext segments below. This is documented in `.env.example` and
  `scratchpad.md`. The user generates it with e.g. `openssl rand -base64 32`.
- **IV:** random 12 bytes per encryption (`crypto.randomBytes(12)`), the standard
  GCM nonce size.
- **Stored format:** three base64 segments joined by a dot:
  `base64(iv).base64(authTag).base64(ciphertext)`. Self-describing, no separate
  columns needed, and the dot separator never appears in base64.

**API:**

```ts
export function encrypt(plaintext: string): string   // returns "iv.tag.ciphertext" (base64 segments)
export function decrypt(payload: string): string      // throws on tamper / bad format / missing key
```

**Key loading & failure behavior (fail loudly):**
- A private `getKey()` reads `ENCRYPTION_KEY`, base64-decodes it, and asserts the
  result is exactly 32 bytes. If the var is missing/empty or not 32 bytes, it throws
  `Error("ENCRYPTION_KEY is missing or not a 32-byte base64 key")`.
- `getKey()` is called lazily inside `encrypt`/`decrypt` (not at module load) so an
  unrelated route importing the module does not crash the process at boot; the error
  surfaces only when a token operation is actually attempted.
- `decrypt` splits on `.`; if it does not get exactly 3 segments it throws
  `Error("Invalid ciphertext format")`. GCM auth-tag verification in
  `decipher.final()` throws automatically if the ciphertext or tag was tampered with
  — this satisfies acceptance criterion #9.

**Logging discipline:** this module never logs. Callers must never log the return of
`decrypt` nor the plaintext argument of `encrypt`. Grep guard documented in the
verification plan.

**Error propagation:** callers treat any throw from `crypto.ts` as a fatal 500-class
condition for the specific operation (onboarding write or a single send), with a
generic client message ("Server encryption not configured" / "Failed to send") and a
server log that names the condition **without** the token value.

**Testability:** pure function, unit-testable with a fixed key — round-trip equality
and a tamper-throws case (criterion #9). A lightweight test harness is added under
`scripts/` (see §9) rather than introducing a test-runner dependency.

---

## 4. Path A — Embedded Signup (OAuth popup)

### 4.1 Frontend

The Connect UI (see §7 for page wiring) renders a **Connect WhatsApp** button that:

1. Loads the Facebook JS SDK once via a client `<script src="https://connect.facebook.net/en_US/sdk.js">`
   (injected on mount; guarded so it loads a single time). On SDK `init`, call
   `FB.init({ appId: process.env.NEXT_PUBLIC_META_APP_ID, autoLogAppEvents: true,
   xfbml: false, version: 'v19.0' })`.
2. Registers a `window` `message` listener **before** launching login, to capture
   the `WA_EMBEDDED_SIGNUP` event. Handler parses `event.data` (guard: only accept
   `event.origin` === `https://www.facebook.com` or `https://web.facebook.com`),
   and when `data.type === 'WA_EMBEDDED_SIGNUP'` extracts `data.data.phone_number_id`
   and `data.data.waba_id` into component state.
3. On button click calls:

```js
FB.login(callback, {
  config_id: process.env.NEXT_PUBLIC_META_CONFIG_ID,
  response_type: 'code',
  override_default_response_type: true,
  extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
});
```

4. In the `FB.login` callback, read `response.authResponse.code` (the auth code).
   Combine it with the `phone_number_id` / `waba_id` captured from the message event
   (both may be absent; backend rediscovers them) and `POST` to
   `/api/numbers/embedded-signup`.
5. UX: on success, refresh the numbers list and show the connected number. On
   cancel/failure (`response.authResponse` missing, or user closed popup), show a
   clear inline error and leave nothing behind (US-A4 — the backend is validate-first
   so a cancelled popup never created a row).

`NEXT_PUBLIC_*` vars are compile-time-inlined by Next.js and are **public** (app id
and config id are not secrets). The app secret is **never** exposed client-side.

### 4.2 Backend — `POST /api/numbers/embedded-signup` (new)

Auth-guarded with `getServerSession(authOptions)`; 401 if no `session.user.id`. All
writes scoped to `session.user.id`.

Request body (zod): `{ code: string; phoneNumberId?: string; wabaId?: string }`.
`code` required; the two IDs optional (frontend may or may not have captured them).

Steps (validate-first, atomic — nothing persisted until all remote checks pass):

1. **Config check.** Require `META_APP_ID` and `META_APP_SECRET`. Missing → 500
   `{ error: "Embedded Signup not configured" }` (logged by key name only).
2. **Exchange code for a business token:**
   `GET https://graph.facebook.com/v19.0/oauth/access_token?client_id={META_APP_ID}&client_secret={META_APP_SECRET}&code={code}`
   — **no `redirect_uri`** (Embedded Signup code exchange omits it). On non-OK →
   400 with Meta's error message; nothing saved. Capture `access_token` and
   `expires_in` (if present → compute `tokenExpiresAt = now + expires_in*1000`;
   absent/long-lived → `tokenExpiresAt = null`).
3. **Resolve `wabaId`.** Primary source: the `waba_id` the client captured from the
   `WA_EMBEDDED_SIGNUP` message event and sent in the request body — trust it when
   present and skip discovery. Fallback discovery (body omitted it): call
   `GET https://graph.facebook.com/v19.0/debug_token?input_token={businessToken}&access_token={META_APP_ID}|{META_APP_SECRET}`
   and read the response **defensively**:
   `const scopes = data?.data?.granular_scopes ?? [];` then find the entry whose
   `scope === "whatsapp_business_management"` and read `entry?.target_ids?.[0]`.
   (Chosen over `me/businesses`, which returns Business Manager objects, not WABAs;
   `debug_token` directly reports the WABA the token was granted against.)
   **This fallback is best-effort and has no secondary recovery:** `target_ids` is not
   guaranteed to be populated for every grant (it depends on how the user scoped the
   permission). If the client did not capture `waba_id` AND the `debug_token` response
   yields no `target_ids` entry, 400 is the terminal state — "Could not determine the
   WhatsApp Business Account; re-run Connect and grant management permission"; nothing
   saved. The design does **not** assume `target_ids` is always present; it requires
   the management scope to carry it or falls to the 400. (Resolves review finding #4.)
4. **Discover `phoneNumberId`** if not supplied: `GET /v19.0/{waba_id}/phone_numbers`
   and take the first (or the one matching a supplied display number). If none → 400
   "No phone number found on the WABA".
5. **Fetch health:** `GET /v19.0/{phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status`
   with the business token. Non-OK → 400 with Meta's message; nothing saved.
6. **Subscribe app to WABA webhooks:** `POST /v19.0/{waba_id}/subscribed_apps` with
   the token. Non-OK is **logged but non-fatal** (the app may already be subscribed,
   or subscription can be retried); do not abort onboarding over it. Log outcome.
7. **Register the number (advisory only — never blocks onboarding):**
   `POST /v19.0/{phoneNumberId}/register` body `{ messaging_product: "whatsapp",
   pin: "<6-digit>" }`. Generate a random 6-digit PIN. **Registration outcome is
   advisory only and never fails onboarding on ANY result** (resolves review finding
   #7). Classify the response:
   - **Success** or **already-registered** → treat as fine. Detect already-registered
     by `metaData.error?.code === 133016` (the numeric Meta error code) — **never** by
     matching a substring of the error message, which breaks under localization. If
     Meta later changes/adds a subcode, `error.error_subcode` may also be checked, but
     the match is always on the numeric code, never on message text.
   - **Any other failure** (including two-step-verification already enabled with a PIN
     the app does not know) → logged (outcome recorded) and **still non-fatal**; the
     number is stored anyway.
   The PIN is not persisted (two-step verification management is out of scope).
8. **Encrypt & persist via find-then-branch.** First derive the unique key:
   `const phoneNumber = normalizePhone(health.display_phone_number)`. **Guard
   (resolves review finding #6b):** if `health.display_phone_number` is absent/empty
   so `phoneNumber === ""` → **400** "Could not read the number's display phone from
   Meta"; nothing saved (an empty/null key would violate the non-null `@unique`
   column). Then `encrypt(businessToken)` → ciphertext and call
   `upsertNumberForUser({ userId: session.user.id, phoneNumber, data })` from §6.2
   with `data` = `{ connectionType: 'embedded_signup', wabaId, phoneNumberId,
   accessToken: <ciphertext>, tokenExpiresAt, displayPhoneNumber, verifiedName,
   qualityRating, codeVerificationStatus, platformType, verificationStatus:
   'verified', verifiedAt: new Date() }`.
   - `upsertNumberForUser` performs the find-then-branch (NOT a Prisma `upsert`): a
     row owned by **another** user, or a create-race `P2002`, surfaces as
     `NumberOwnedByOtherTenantError` → the route returns **409** "This number is
     connected to another account" (multi-tenant isolation). A row owned by the **same**
     user is updated in place by its `id`.
9. **Response:** return the number record **with the `accessToken` field stripped**
   (never return ciphertext or plaintext). A small `serializeNumber()` helper (shared,
   §6) omits `accessToken`.

**Edge cases:** popup cancelled (no code reaches backend — nothing happens); code
already used/expired (step 2 → 400); WABA shared but no phone added (step 4 → 400);
token lacks management scope (discovery empty → 400 asking the owner to grant
permissions). Each returns a descriptive 400 and persists nothing.

---

## 5. Path B — Manual credential entry

For a developer/IT consultant onboarding when the FB account owner is **not**
available for interactive OAuth/MFA.

### 5.1 Frontend

On the same Connect UI, an **"Enter credentials manually"** toggle reveals a form:
- **WABA ID** (required)
- **Phone Number ID** (required)
- **Access Token** (required) — helper text: *"Recommended: a long-lived Meta System
  User token (generated once by the account owner in Business Settings → System
  Users) so the owner need not be present each time. A temporary user token also
  works but expires."*
- **Display label** (optional) — cosmetic.

Submits to `POST /api/numbers/manual`. Shows Meta's exact error message on 400.

### 5.2 Backend — `POST /api/numbers/manual` (new)

Auth-guarded (`getServerSession`), scoped to `session.user.id`.

Body (zod): `{ wabaId: string (1..100), phoneNumberId: string (1..100),
accessToken: string (10..5000), label?: string (0..100) }`. All three core fields
required and length-bounded. Invalid shape → 400 (zod message), nothing saved.

Steps (validate-live-first):

1. **Validate against Meta with the provided token:**
   `GET https://graph.facebook.com/v19.0/{phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status`
   `Authorization: Bearer {providedToken}`.
   - Non-OK (bad token, unreachable ID, wrong permissions) → **400** with Meta's
     `error.message` verbatim; **DO NOT save** (no row, no token). Satisfies US-B3 /
     criterion #7.
2. **Tie to WABA — three-way outcome (resolves review finding #5).** Call
   `GET /v19.0/{wabaId}/phone_numbers?limit=...` with the provided token and branch on
   exactly three outcomes:
   - **(a) Call succeeds AND `phoneNumberId` IS in the returned list** → the phone is
     provably under the submitted WABA. Proceed.
   - **(b) Call succeeds AND `phoneNumberId` is NOT in the list** → the phone provably
     belongs to a *different* WABA than the one submitted. This is **fatal: 400**
     "This phone number is not under the provided WhatsApp Business Account", nothing
     saved. (A token-scoped `GET /{phoneNumberId}` in step 1 can read a phone that is
     not under the claimed WABA; without this check a wrong `wabaId` would be saved and
     later used for `subscribed_apps`, a data-integrity hole.)
   - **(c) Call fails entirely** (permission denied, token cannot list the WABA,
     network/Graph error) → the list could not be retrieved, so ownership is
     *unknown*, not *disproven*. Log a warning and treat as **non-fatal**; step 1
     remains the authoritative reachability check.
   Only (b) — a successful list that does not contain the phone — is fatal. "Could not
   retrieve the list" (c) is never treated as a mismatch.
3. **Subscribe WABA to webhooks:** `POST /v19.0/{wabaId}/subscribed_apps` with the
   provided token. Non-OK logged, non-fatal (same reasoning as Path A step 6).
4. **Encrypt & persist via find-then-branch.** Derive
   `const phoneNumber = normalizePhone(health.display_phone_number)`; if empty → 400
   "Could not read the number's display phone from Meta" (same guard as Path A step 8,
   finding #6b). `encrypt(providedToken)` → ciphertext, then
   `upsertNumberForUser({ userId: session.user.id, phoneNumber, data })` (§6.2) with
   `data` = `{ connectionType: 'manual', wabaId, phoneNumberId,
   accessToken: <ciphertext>, tokenExpiresAt: null` (manual tokens are treated as
   long-lived; we do not introspect expiry here)`, displayPhoneNumber, verifiedName,
   qualityRating, codeVerificationStatus, platformType, verificationStatus:
   'verified', verifiedAt: new Date() }`. The same find-then-branch and 409
   cross-tenant handling as Path A (NOT a Prisma `upsert`).
5. **Response:** serialized number **without** `accessToken`.

**Edge cases:** expired/invalid token → step 1 400; valid token but the phone is
provably under a different WABA → step 2 outcome (b) 400, nothing saved; token can
read the phone but cannot list the submitted WABA → step 2 outcome (c), non-fatal warn,
step 1 remains authoritative; number already owned by another tenant → 409 from
`upsertNumberForUser`; `display_phone_number` missing from Meta's response → 400 guard.

---

## 6. Shared helper — credential resolution & serialization

Add `src/lib/whatsapp.ts` (new) with small shared helpers so both send paths and the
onboarding routes behave identically:

```ts
// Resolve the Graph creds for a given WhatsAppNumber row.
// Returns decrypted token + phoneNumberId, or env fallback for a legacy row.
export function resolveSendCredentials(number: {
  phoneNumberId: string | null;
  accessToken: string | null;
}): { phoneNumberId: string | null; accessToken: string | null }
```

Logic (resolves requirements open question #3): **prefer the row's own creds; fall
back to env only when the row has neither.**
- If `number.accessToken` is non-null → `accessToken = decrypt(number.accessToken)`
  (may throw → caller treats as fatal for that send), `phoneNumberId =
  number.phoneNumberId`.
- Else (legacy row with no stored token) → `accessToken =
  process.env.META_ACCESS_TOKEN`, `phoneNumberId = number.phoneNumberId ??
  process.env.META_PHONE_NUMBER_ID`.

Keeping the env fallback (rather than removing it) preserves the one existing global
number so current users do not break (requirements say data migration is out of
scope). New per-path numbers always carry their own creds and never touch env.

`serializeNumber(number)` returns the row with `accessToken` removed — used by every
response that returns a number (`GET /api/numbers`, `GET /api/numbers/[id]`, both new
POSTs) so ciphertext never leaves the server.

### 6.1 `normalizePhone` — the single phone-number normalization rule

```ts
export function normalizePhone(s: string): string {
  return s.replace(/\D/g, ""); // strip every non-digit, keep digits only
}
```

This is the **one** normalization used everywhere a `phoneNumber` unique key is
derived: both onboarding routes (from Meta's `display_phone_number`), the repurposed
`add` flow, and any legacy comparison. Using an identical rule in every call site is
what makes the find-then-branch below (and the legacy-row reconciliation in §6.3)
behave predictably. Resolves review finding #6.

### 6.2 `upsertNumberForUser` — find-then-branch, NOT a Prisma `upsert`

The only `@unique` field on `WhatsAppNumber` is `phoneNumber` (verified in
`prisma/schema.prisma`); there is **no compound `@@unique([phoneNumber, userId])`**.
A Prisma `upsert`'s `where` must be a unique selector, so it is impossible to express
"upsert scoped to `session.user.id`" — upserting purely on `phoneNumber` would
silently overwrite a row owned by another tenant, which is both an isolation hole and
a direct contradiction of the cross-tenant 409 contract. **Decision (resolves review
finding #1): both onboarding routes use an explicit find-then-branch, never a Prisma
`upsert`.** The exact flow, shared by Path A and Path B:

```ts
// data = the per-path fields (connectionType, wabaId, phoneNumberId,
//        accessToken ciphertext, tokenExpiresAt, health fields,
//        verificationStatus: "verified", verifiedAt: new Date())
export async function upsertNumberForUser(args: {
  userId: string;
  phoneNumber: string;        // already normalizePhone()-d, guaranteed non-empty
  data: Prisma.WhatsAppNumberUpdateInput & Prisma.WhatsAppNumberCreateInput;
}) {
  const existing = await prisma.whatsAppNumber.findUnique({
    where: { phoneNumber: args.phoneNumber },
  });

  if (existing && existing.userId !== args.userId) {
    // owned by another tenant — isolation boundary
    throw new NumberOwnedByOtherTenantError();
  }

  if (existing) {
    return prisma.whatsAppNumber.update({
      where: { id: existing.id },          // id is unique and ties to the same user
      data: args.data,
    });
  }

  try {
    return await prisma.whatsAppNumber.create({
      data: { userId: args.userId, phoneNumber: args.phoneNumber, ...args.data },
    });
  } catch (e) {
    // Create race: another request created the same phoneNumber between the
    // findUnique and the create. Prisma unique-constraint violation = P2002.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new NumberOwnedByOtherTenantError();
    }
    throw e;
  }
}
```

Each onboarding route maps `NumberOwnedByOtherTenantError` to **HTTP 409**
`{ error: "This number is connected to another account" }`. The `update` branch is
keyed by the row's own `id` (unique) **after** confirming `existing.userId` matches
the session user, so a same-user reconnect updates in place and a cross-tenant
collision (including the create race) is a 409 with nothing overwritten. This is the
concrete replacement for every earlier phrase that said "scoped upsert on
`phoneNumber`."

### 6.3 Legacy-row reconciliation (resolves review finding #6a)

The old fake flow stored `phoneNumber` as the user-typed `cleanedNumber`
(`phoneNumber.replace(/\D/g, "")` in `add/page.tsx` — verified). Because both the
legacy write and the new onboarding routes run the **same** `normalizePhone` rule,
a tenant reconnecting their own number lands on the same key and takes the `update`
branch (same-user update in place) — not a 409. The one residual case: if the legacy
row's digits differ from Meta's `display_phone_number` digits (e.g. the user typed a
local number without the country code that Meta reports with it), the keys will not
match and the connect creates a **new** row rather than updating the stale one. This
is documented as a known gotcha: the stale legacy row is harmless (no token, not used
by sends once a real number exists) and the tenant may delete it via the existing
`DELETE`. We do not attempt fuzzy matching across differing digit strings — that
would risk mis-merging two genuinely different numbers.

---

## 7. Replace the fake flow (frontend + fake endpoints)

### 7.1 Fake endpoints

- **`POST /api/numbers/[id]/verify`** — repurpose into a **real health refresh**:
  with the session user's number, if it has a stored token, call
  `GET /v19.0/{phoneNumberId}?fields=...` and update the health fields
  (`displayPhoneNumber`, `verifiedName`, `qualityRating`, `codeVerificationStatus`,
  `platformType`). Remove the random-code generation entirely. If the number has no
  stored token (legacy), return 400 "Reconnect this number via Connect WhatsApp".
- **`POST /api/numbers/[id]/confirm`** — neutralize: it no longer accepts a local code
  to mark `verified`. Return 410 Gone `{ error: "Manual code confirmation is no
  longer supported. Connect via Embedded Signup or manual credentials." }`. (Kept as
  a stub so any stale client call fails loudly rather than 404-crashing; satisfies
  criterion #14 — no arbitrary local code can mark a number verified.)
- **`POST /api/numbers` (bare phone)** — resolves open question #9: keep `GET`
  unchanged; **remove the create path's ability to mint a usable number.** Replace the
  `POST` body so a bare `phoneNumber` is rejected with 400 directing the user to the
  two real paths. (We keep the handler returning a clear 400 rather than deleting the
  method, so the existing `add` page's old call fails loudly during transition; the
  page is rewired below so this is belt-and-suspenders.)

### 7.2 Frontend pages

- **`src/app/dashboard/numbers/add/page.tsx`** — becomes the **Connect** page:
  a "Connect WhatsApp" button (Path A) and an "Enter credentials manually" toggle
  revealing the Path B form (§5.1). Remove the phone-string registration form.
- **`src/app/dashboard/numbers/[id]/verify/page.tsx`** — remove the OTP/dev-code UI.
  **Decision (resolves review finding #11 — single owner for "Refresh status"):** this
  page does NOT host any action. It becomes a pure client redirect to
  `/dashboard/numbers/[id]` (so stale links / the detail page's old "Continue
  Verification" link, which no longer renders for `verified` numbers, land somewhere
  sane). The **detail page is the sole owner** of the "Refresh status" button (below).
  The dev-code UI is deleted.
- **`src/app/dashboard/numbers/page.tsx`** (list) — keep list + DELETE working;
  render `connectionType` and real statuses in the badge where available.
- **`src/app/dashboard/numbers/[id]/page.tsx`** (detail) — surface the real Meta
  fields: `displayPhoneNumber`, `verifiedName`, `qualityRating`,
  **`codeVerificationStatus`** (fixes US-E1 / criterion #17), `platformType`,
  `connectionType`, and the **single** "Refresh status" button (calls the repurposed
  `POST /api/numbers/[id]/verify` health-refresh endpoint from §7.1 and re-renders).
  No other page hosts this action (see finding #11 reconciliation above). The
  `WhatsAppNumber` TS interface in these client files gains the new optional fields.

Existing rows (no new fields) must not break: all new fields are optional in the UI
types and rendered conditionally.

---

## 8. Webhook — add signature verification (`src/app/api/webhooks/whatsapp/route.ts`)

Enhance the existing route in place (per §1 decision).

**GET (unchanged behavior):** compare `hub.verify_token` to
`process.env.META_WEBHOOK_VERIFY_TOKEN`; on `hub.mode === "subscribe"` and match,
echo `hub.challenge` as plain-text 200; else 403. (Already implemented — keep.)

**POST (add signature verification):**

1. **Read the RAW body first.** In an App Router handler, read
   `const raw = await request.text();` **before** any JSON parse. This yields the
   exact bytes Meta signed. Then `JSON.parse(raw)` for processing. (Resolves open
   question #7 — `request.json()` is replaced by `request.text()` + manual parse so
   the HMAC input matches Meta's bytes.)
2. **Verify `X-Hub-Signature-256` (resolves review finding #3).** Steps, in order,
   each returning **401** (not 200) and processing nothing on failure:
   1. **App secret present?** If `process.env.META_APP_SECRET` is unset/empty →
      return 401 **and** `console.error("META_APP_SECRET not configured — rejecting
      webhook; delivery status will not update")`. This is deliberate: the GET
      handshake keys off `META_WEBHOOK_VERIFY_TOKEN`, so without this log an operator
      who set the verify token but not the app secret would get a passing handshake
      and a POST that silently 401s every event — the exact "handshake works, nothing
      delivered" trap this feature exists to kill. The error log names the missing key
      so the cause is visible. (`META_APP_SECRET` is therefore a **hard prerequisite**
      for delivery status — documented in §10.2.)
   2. **Header present and well-formed?** Read `X-Hub-Signature-256`. If missing, or it
      does not start with the literal prefix `"sha256="`, → 401 (do not attempt a
      buffer compare on a malformed header). Split off the hex:
      `const theirHex = header.slice("sha256=".length);`.
   3. **Compute expected:**
      `const ourHex = crypto.createHmac("sha256", META_APP_SECRET).update(raw, "utf8").digest("hex");`.
   4. **Length guard before `timingSafeEqual`.** `crypto.timingSafeEqual` **throws** if
      the two buffers differ in length, so build `const a = Buffer.from(theirHex,
      "hex"); const b = Buffer.from(ourHex, "hex");` and if `a.length !== b.length` →
      401 (covers a short/garbage hex that survived the prefix check). Only when
      lengths are equal call `crypto.timingSafeEqual(a, b)`; `false` → 401.
   On any of the above → **401, payload not processed** (criterion #5). This is the one
   case that does NOT return 200.
3. **Process (unchanged logic, tightened routing):** iterate `entry[].changes[]`.
   - **Statuses:** map `sent/delivered/read/failed` to the `Message` by
     `metaMessageId` (`updateMany where metaMessageId = wamid`): set `status`,
     `deliveredAt` (delivered), `readAt` (read), `errorMessage` (failed). This is the
     fix for "shows sent but never delivered/failed."
   - **Inbound messages:** resolve the owning `WhatsAppNumber` **strictly by**
     `value.metadata.phone_number_id` (`findFirst where phoneNumberId = <incoming>`).
     **Tighten FR-7.4:** remove the "any verified number" fallback entirely (it can
     misattribute one tenant's inbound message to another tenant). **Resolve review
     finding #12 — two exhaustive outcomes, no ambiguous "log-only match that still
     writes":**
     - **(a) A `WhatsAppNumber` row matches the incoming `phone_number_id`** → write
       the inbound message / upsert the conversation under **that row's real
       `userId`** (`waNumber.userId`), exactly as today. This naturally covers the
       single legacy global number *once it exists as a row* — there is no separate
       env branch.
     - **(b) No row matches** → `console.log` the unmatched `phone_number_id` and
       **skip** (create nothing). We never consult `process.env.META_PHONE_NUMBER_ID`
       to invent an owner for an inbound write, because env is not tied to a `userId`
       and guessing one is the misattribution bug. (If the legacy global number has
       not been onboarded as a row, its inbound messages are logged-and-skipped until
       it is connected — an acceptable, isolation-safe tradeoff.)
     This guarantees every inbound row lands under a real, correct `userId`
     (criterion #13).
4. **Resilience:** after a valid signature, any processing error returns **200**
   (so Meta does not retry indefinitely) and is logged — except the signature
   rejection in step 2, which returns 401.

**Logging discipline:** never log the app secret, the computed HMAC, or decrypted
tokens.

**Testability:** signature verification is a pure function of (raw body, secret,
header) — unit-testable (valid → process, tampered → 401). Status mapping is
integration-testable with a crafted payload.

---

## 9. Send-path rewire

Both send routes use `resolveSendCredentials(number)` from §6.

### 9.1 `src/app/api/messages/send/route.ts`

**Credential resolution and the throw path (resolves review finding #2).** In the
actual route (verified) the message row is created and the credit is deducted
**before** credentials are resolved, and the refund runs only inside the final
`if (finalStatus === "failed")` block. `resolveSendCredentials` can **throw** when a
stored token exists but `ENCRYPTION_KEY` is missing/invalid (decrypt fails). If that
throw propagated to the outer `catch (error)`, the route would return a generic 500
that **never marks the message `failed` and never refunds the credit** — the row would
be stuck at `queued` and the tenant charged. The earlier claim that this is "identical
to the existing missing-creds path" was wrong: the existing missing-creds path does
not throw.

**Decision: wrap the resolution so a throw is funneled into the existing
missing-creds branch** (the one that sets `finalStatus = "failed"` and flows into the
refund), replacing the current inline `phoneNumberId`/`accessToken` assignment:

```ts
let phoneNumberId: string | null = null;
let accessToken: string | null = null;
try {
  ({ phoneNumberId, accessToken } = resolveSendCredentials(number));
} catch (e) {
  // bad/missing ENCRYPTION_KEY while decrypting a stored token.
  // Leave both null so the existing `if (!phoneNumberId || !accessToken)`
  // branch sets finalStatus = "failed" and the end-of-handler refund runs.
  console.error("[Send] credential resolution failed (encryption/config)"); // no token/secret
  phoneNumberId = null;
  accessToken = null;
}
```

Because both are left `null`, the pre-existing branch
`if (!phoneNumberId || !accessToken) { finalStatus = "failed"; errorMessage = ... }`
runs, the message is updated to `failed`, and the existing
`if (finalStatus === "failed") { refund … return 500 }` block refunds the credit for
non-superadmins — so credit consistency is preserved and the row is never stuck at
`queued`. (The alternative — moving resolution *before* the create/deduct — was
rejected to keep the diff minimal and leave the existing OTP guard / credit-check
ordering untouched; the wrap achieves the same correctness with less churn.) The
`errorMessage` on this branch stays the generic "not configured" string; the specific
encryption cause is logged server-side (by condition, never the token).

Everything else is **preserved exactly**:
- auth guard, number-ownership + `verified` check, template-ownership + `approved`
  check;
- the auth-template OTP guard (`template.category === "authentication" &&
  !variables?.[0]` → 400) **before** any message row or credit deduction;
- the `#131008` fix (append the `button` / `sub_type: "url"` / `index: "0"`
  component with `variables[0]`);
- credit deduct on send / refund on failure; superadmin exemption;
- message create → update with `metaMessageId`/`status`/`errorMessage`;
- Graph `v19.0`, `to` digit-stripping, error handling, response shapes.

Review-note (from requirements review.json, non-blocking): the guard tests
`!variables?.[0]` while the button block tests `vars.length > 0`. The gap is
unreachable (the guard already rejects auth templates with a falsy `variables[0]`).
**Decision:** optionally align the button condition on `vars[0]` for local clarity
during the edit, but this is cosmetic and must not change behavior.

### 9.2 `src/app/api/chat/[contactPhone]/send/route.ts`

Same change: resolve `{ phoneNumberId, accessToken }` via
`resolveSendCredentials(waNumber)` instead of the inline env fallback. This route has
**no credit logic and no pre-created message row** (verified: the credential check and
Meta call happen before the single `message.create`), so the throw handling is
simpler than §9.1: wrap the resolution and on throw leave both values `null` so the
existing `if (!phoneNumberId || !accessToken) return 500 "Meta API credentials not
configured"` guard fires **before** any row is created:

```ts
let phoneNumberId: string | null = null;
let accessToken: string | null = null;
try {
  ({ phoneNumberId, accessToken } = resolveSendCredentials(waNumber));
} catch {
  phoneNumberId = null;
  accessToken = null; // falls into the existing "credentials not configured" 500
}
```

Preserve the free-text payload, conversation upsert, message create, and the existing
422-on-Meta-failure / 500-on-missing-creds shapes exactly.

---

## 10. Config / docs (`.env.example`, `scratchpad.md`)

### 10.1 `.env.example` — rewrite (placeholders only, no secrets)

```dotenv
# Database (Turso / libSQL)
TURSO_DATABASE_URL=""
TURSO_AUTH_TOKEN=""

# NextAuth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET=""
NEXTAUTH_JWT_SECRET=""

# Meta WhatsApp Business API (Graph v19.0)
META_APP_ID=""
META_APP_SECRET=""
META_ACCESS_TOKEN=""           # legacy/global fallback token (optional once numbers carry their own)
META_PHONE_NUMBER_ID=""        # legacy/global fallback phone number id
META_WABA_ID=""
META_WEBHOOK_VERIFY_TOKEN=""   # GET handshake; must match hub.verify_token in the Meta app
# NOTE: no server-side META_CONFIG_ID — the Embedded Signup Configuration ID is only
# consumed by FB.login in the browser, so it lives solely as NEXT_PUBLIC_META_CONFIG_ID
# below. (Resolves review finding #8 — no dead/unused server mirror to drift.)

# Public (inlined into the browser bundle at BUILD time — NOT secrets; changing them
# requires a rebuild/redeploy, see §10.2)
NEXT_PUBLIC_META_APP_ID=""     # FB.init appId — Path A no-ops in the browser if unset
NEXT_PUBLIC_META_CONFIG_ID=""  # Embedded Signup Configuration ID used by FB.login

# Encryption (AES-256-GCM) — 32 raw bytes, base64-encoded
# Generate: openssl rand -base64 32
ENCRYPTION_KEY=""

# Razorpay
RAZORPAY_KEY_ID=""
RAZORPAY_KEY_SECRET=""
RAZORPAY_WEBHOOK_SECRET=""
```

Removes the Postgres `DATABASE_URL`. Documents the base64/32-byte encoding of
`ENCRYPTION_KEY`.

### 10.2 Meta-side manual prerequisites (document in `.env.example` comment block or README section)

1. Configure the WhatsApp product + **Embedded Signup** and obtain a **Configuration
   ID** → set it as **`NEXT_PUBLIC_META_CONFIG_ID`** (the config id is used only by
   the browser `FB.login`; there is no server-side `META_CONFIG_ID` — finding #8).
2. Submit **App Review** for `whatsapp_business_management` + `whatsapp_business_messaging`.
3. Set the **webhook callback URL** to `/api/webhooks/whatsapp` and the
   **verify token** to `META_WEBHOOK_VERIFY_TOKEN`; subscribe to the `messages` field.
4. **Set `META_APP_SECRET`** — it is **mandatory for delivery status to function**:
   the webhook POST handler rejects every event with 401 (and logs the missing key) if
   it is unset, even though the GET handshake would still pass on
   `META_WEBHOOK_VERIFY_TOKEN` alone. Without the app secret you get the "handshake
   works, nothing delivered" trap. (Finding #3.)
5. **Set the build-time public vars `NEXT_PUBLIC_META_APP_ID` and
   `NEXT_PUBLIC_META_CONFIG_ID`.** Next.js inlines `NEXT_PUBLIC_*` into the browser
   bundle **at build time**, so these must be present when you build/deploy; changing
   them later requires a **rebuild**. If `NEXT_PUBLIC_META_APP_ID` is unset, Path A
   (the Connect popup) silently no-ops in the browser. (Finding #9.)
6. For the manual path, the owner generates a **long-lived System User token** once in
   Business Settings → System Users (recommended so the owner need not be present each
   time).
7. Generate `ENCRYPTION_KEY` (`openssl rand -base64 32`) and store it securely —
   losing it makes stored tokens undecryptable.
8. Make the app **Live** for real tenants.

### 10.3 `scratchpad.md`

Update in the same change (per the global scratchpad rule): new endpoints
(`/api/numbers/embedded-signup`, `/api/numbers/manual`, repurposed `verify`,
neutralized `confirm`), new schema fields, new env vars, the two onboarding paths,
webhook signature verification, the two rewired send paths, and a dated change-log
entry.

---

## 11. Constraints encoded

- **TypeScript throughout; App Router handlers return `NextResponse`.**
- **Every new endpoint** calls `getServerSession(authOptions)` and 401s without
  `session.user.id`; all queries scoped by `userId: session.user.id`
  (multi-tenant isolation, FR-8). The webhook is the only unauthenticated endpoint and
  is instead gated by signature verification.
- **Never log/return decrypted tokens or secrets.** Responses use `serializeNumber`
  (strips `accessToken`). `crypto.ts` never logs.
- **Zero new dependencies.**
- **No regression** to send/credits/admin behavior (§9 preserves all existing logic).

---

## 12. Error-handling matrix

| Operation | Failure condition | Recoverable? | Caller receives | Logged? (level, no secrets) |
|-----------|-------------------|--------------|-----------------|------------------------------|
| `getKey()` | `ENCRYPTION_KEY` missing / not 32 bytes | fatal (config) | 500 "Server encryption not configured" | error, by key name only |
| `decrypt` | tampered ciphertext / bad format | fatal (that op) | 500 / send marked failed | error, no token |
| ES: code exchange | code invalid/expired/used | recoverable by retry | 400 + Meta message | warn, no token |
| ES: WABA/phone discovery | none found / no scope | recoverable (fix perms) | 400 descriptive | warn |
| ES: health fetch | token/ID bad | fatal for onboarding | 400 + Meta message | warn |
| ES: subscribe_apps | Meta non-OK | non-fatal | onboarding still succeeds | warn, outcome recorded |
| ES: register | non-OK (incl. already-registered) | non-fatal | onboarding still succeeds | info/warn, outcome recorded |
| Manual: live validate | bad token/ID | fatal (reject) | **400 + Meta message, NOTHING saved** | warn, no token |
| Manual: subscribe_apps | non-OK | non-fatal | success | warn |
| Persist (find-then-branch) | number owned by other tenant (incl. P2002 create race) | fatal | **409** "connected to another account" | warn |
| Persist | `display_phone_number` missing → empty key | fatal | 400 "could not read display phone" | warn |
| Manual: WABA tie-check | list OK but phone absent | fatal | **400, nothing saved** | warn |
| Manual: WABA tie-check | list call failed (perm/network) | non-fatal | proceeds (step 1 authoritative) | warn |
| Webhook POST | `META_APP_SECRET` unset | reject | **401, payload not processed** | **error, by key name** |
| Webhook POST | header missing / no `sha256=` prefix / length mismatch / HMAC mismatch | reject | **401, payload not processed** | warn, no secret/HMAC |
| Webhook POST | processing error (post-signature) | tolerated | 200 (no Meta retry storm) | error |
| Send | resolve/decrypt throws | fatal (that send) | wrapped → null creds → existing `failed` branch → credit refunded, 500 | error, no token |
| Send | no creds (legacy, no env either) | fatal (that send) | message `failed`, credit refunded, 500 | warn |
| Send | Meta API non-OK | fatal (that send) | message `failed` + Meta message, credit refunded, 500/422 | error |

## 13. Input validation rules (external inputs)

| Input | Required | Type / limits | On failure |
|-------|----------|---------------|------------|
| `embedded-signup.code` | yes | string, 1..4000 | 400 (zod) |
| `embedded-signup.phoneNumberId/wabaId` | no | string, 1..100 | ignored if absent (rediscovered) |
| `manual.wabaId` | yes | string, 1..100 | 400 (zod) |
| `manual.phoneNumberId` | yes | string, 1..100 | 400 (zod) |
| `manual.accessToken` | yes | string, 10..5000 | 400 (zod); never echoed back |
| `manual.label` | no | string, 0..100 | trimmed |
| webhook `hub.verify_token` | — | string | 403 on mismatch |
| webhook `X-Hub-Signature-256` | yes (POST) | `sha256=<hex>` | 401 if missing/bad |
| webhook body | yes (POST) | raw text → JSON | signature must match raw bytes |

Invariant ownership: the **route layer** owns `userId` scoping and the unique-phone
isolation; the **crypto layer** owns ciphertext integrity (GCM auth tag); the
**webhook layer** owns authenticity (HMAC). Each is enforced where the relevant data
first enters a trust boundary.

---

## 14. Files touched

**New:**
- `src/lib/crypto.ts` — AES-256-GCM encrypt/decrypt.
- `src/lib/whatsapp.ts` — `resolveSendCredentials`, `serializeNumber`, shared Graph fetch helpers.
- `src/app/api/numbers/embedded-signup/route.ts` — Path A backend.
- `src/app/api/numbers/manual/route.ts` — Path B backend.
- `scripts/test-crypto.mjs` — encryption round-trip + tamper test. **Resolves review
  finding #10:** there is no test runner or `tsx` in `package.json`, so a `.ts` file
  cannot run under plain `node`. The script is a **plain `.mjs`** that re-implements
  the tiny encrypt/decrypt inline (AES-256-GCM, same `iv.tag.ciphertext` base64 format
  as `src/lib/crypto.ts`) using only the Node built-in `crypto` — no import from the
  TypeScript source, no compile step, no new dependency. It is run with the exact
  command `ENCRYPTION_KEY=$(openssl rand -base64 32) node scripts/test-crypto.mjs`
  and asserts: (1) `decrypt(encrypt(x)) === x`; (2) tampering one char of the
  ciphertext/tag makes `decrypt` throw; (3) an absent/short key throws a clear error.
  (The production code in `src/lib/crypto.ts` is exercised for real by the manual-path
  and send verification steps; this standalone script covers AC #9's pure round-trip
  without a runner.)

**Modified:**
- `prisma/schema.prisma` — `WhatsAppNumber` new fields.
- `src/app/api/webhooks/whatsapp/route.ts` — signature verification + routing tighten.
- `src/app/api/messages/send/route.ts` — credential resolution via helper.
- `src/app/api/chat/[contactPhone]/send/route.ts` — credential resolution via helper.
- `src/app/api/numbers/route.ts` — `POST` no longer mints a usable number; `GET` uses `serializeNumber`.
- `src/app/api/numbers/[id]/route.ts` — `GET` uses `serializeNumber`.
- `src/app/api/numbers/[id]/verify/route.ts` — repurpose to health refresh.
- `src/app/api/numbers/[id]/confirm/route.ts` — neutralize (410).
- `src/app/dashboard/numbers/add/page.tsx` — Connect UI (Path A + Path B).
- `src/app/dashboard/numbers/[id]/verify/page.tsx` — remove dev-code UI.
- `src/app/dashboard/numbers/page.tsx` + `[id]/page.tsx` — surface real Meta fields.
- `.env.example` — rewrite.
- `scratchpad.md` — reference + change log.

---

## 15. Verification plan

Run after implementation (matches acceptance criteria):

1. **Build:** `npm run build` (`prisma generate && next build`) passes with no type
   or build errors. (AC #1)
2. **Schema apply:** `npm run db:push` applies the new nullable `WhatsAppNumber`
   fields with no data loss on the existing Turso DB. (AC #2)
3. **Encryption round-trip:** run
   `ENCRYPTION_KEY=$(openssl rand -base64 32) node scripts/test-crypto.mjs` (plain
   `.mjs`, no runner/tsx — finding #10). Asserts: encrypt a known string and decrypt
   back to the original; tamper one char of the ciphertext/tag and assert `decrypt`
   throws; an absent/short key throws a clear error. (AC #9)
4. **Webhook GET handshake:** `curl` with `hub.mode=subscribe` and a matching verify
   token → exact `hub.challenge`, 200; wrong token → 403, no echo. (AC #3, #4)
5. **Webhook POST signature:** POST with missing/invalid `X-Hub-Signature-256` → 401,
   no rows created; POST with a correctly HMAC-signed status payload → matching
   `Message` updated by `metaMessageId` (`deliveredAt`/`readAt`/`errorMessage`). (AC #5, #6)
6. **Manual path invalid:** POST `/api/numbers/manual` with a bad token/ID → 400 with
   Meta's message, and a DB check shows **no** new `WhatsAppNumber` row and no stored
   token. (AC #7)
7. **Manual path valid (mocked/sandbox):** valid creds → number stored with encrypted
   token; response body contains neither plaintext nor ciphertext. (AC #8)
8. **Send resolution:** unit/inspection — a number with a stored token resolves to its
   own `phoneNumberId` + decrypted token (not env); a legacy number with none falls
   back to env. (AC #10, #12)
9. **Send regression:** auth template without OTP var → 400 before any row/credit;
   with OTP var → `button`/`sub_type: url` component present (#131008); credit
   deducted on send, refunded on failure; superadmin not charged. (AC #11)
10. **Isolation:** a user cannot read/connect/send another user's number (queries
    scoped by `session.user.id`); an inbound webhook for tenant A's `phone_number_id`
    creates rows under tenant A only. (AC #13)
11. **Fake flow gone:** `confirm` no longer accepts an arbitrary local code to mark
    `verified`; `verify` no longer generates a random code. (AC #14)
12. **Docs:** `.env.example` lists Turso + full Meta set + `ENCRYPTION_KEY` + the
    Embedded Signup Configuration ID as `NEXT_PUBLIC_META_CONFIG_ID` (+ the other
    `NEXT_PUBLIC_*`), no Postgres `DATABASE_URL`; `scratchpad.md` updated with
    endpoints/schema/env + dated change-log. (AC #15, #16) — Note on AC #15: it names
    "META_CONFIG_ID"; this design satisfies the intent (the Configuration ID is
    present and documented) by placing it where the code actually reads it,
    `NEXT_PUBLIC_META_CONFIG_ID`, rather than keeping an unread server mirror
    (finding #8).
13. **UI:** number detail page shows real `codeVerificationStatus` and related fields.
    (AC #17)
14. **Cleanup:** remove any temporary test artifacts created during verification.

---

## 16. Resolved open questions (from requirements §"Open questions")

1. **ES return shape / token type:** use the client-captured `WA_EMBEDDED_SIGNUP`
   message event for `waba_id`/`phone_number_id` **plus** an OAuth `code` exchange
   (no `redirect_uri`) for the token. Stored token is the business token from the
   exchange; `tokenExpiresAt` set from `expires_in` when present, else null. Refresh
   is out of scope (future work).
2. **Token scope:** stored per `WhatsAppNumber` row; no `WabaConnection` parent (§2).
3. **Send env-fallback:** kept, but only for a legacy row with no stored creds;
   per-path numbers always use their own (§6).
4. **Webhook inbound fallback:** removed the "any verified number" guess entirely;
   strict `phone_number_id` match that writes under the matched row's real `userId`,
   else log-and-skip (no env-based owner guessing) — §8 step 3.
5. **"Credits/amount in Facebook":** surface Meta-reported phone/WABA status
   (`qualityRating`, `codeVerificationStatus`, `status`) on the detail page; paying
   Meta / WABA balance top-up is out of scope (requirements §Out of Scope). No new
   polling job — status is captured at onboarding and refreshable via the repurposed
   `verify` endpoint.
6. **New schema fields / status reuse:** use the brief's explicit field set;
   `verificationStatus` stays and is set to real `'verified'` only after a successful
   Meta health check (§2, §4, §5).
7. **Raw-body handling:** `await request.text()` then `JSON.parse`, HMAC over the raw
   text (§8).
8. **Manual validation call:** `GET /{phoneNumberId}?fields=...` with the provided
   token as the authoritative reachability check; `GET /{wabaId}/phone_numbers` as a
   **three-way** tie-check — fatal 400 only when the list succeeds and the phone is
   absent, non-fatal when the list could not be retrieved (§5.2 step 2).
9. **Bare `POST /api/numbers`:** reduced to a 400 that redirects users to the two real
   paths; it no longer mints a usable/verified number (§7.1).

---

## 17. Review responses (design-review.json revision 2)

All 12 findings from `.agents/tasks/design-review.json` are **addressed** in this
revision. None are backlogged or ignored; each change stays within the original
requirements.

| # | Severity | Status | Where resolved |
|---|----------|--------|----------------|
| 1 | HIGH | **Fixed** | §6.2 `upsertNumberForUser` — explicit find-then-branch (findUnique → cross-tenant 409 → same-user update by `id` → create with P2002→409 race guard), replacing the impossible "scoped upsert on `phoneNumber`". §4.2 step 8 and §5.2 step 4 now call it. |
| 2 | HIGH | **Fixed** | §9.1 — `resolveSendCredentials` wrapped in try/catch; on throw both creds are set `null` so the pre-existing missing-creds branch marks the message `failed` and the end-of-handler refund runs (no stuck `queued`, no over-charge). §9.2 — wrapped so a throw hits the existing "credentials not configured" 500 before any row is created. The inaccurate "identical to the existing path" claim removed. |
| 3 | HIGH | **Fixed** | §8 step 2 — ordered checks: unset `META_APP_SECRET` → 401 **and** error-log by key name (documented as a hard delivery prerequisite in §10.2 item 4); require `sha256=` prefix; length-guard both hex buffers before `timingSafeEqual`. |
| 4 | MEDIUM | **Fixed** | §4.2 step 3 — client `waba_id` primary; defensive parse `data?.data?.granular_scopes ?? []`; `target_ids` not assumed present; 400 is the terminal fallback state. |
| 5 | MEDIUM | **Fixed** | §5.2 step 2 — three-way tie-check: list-OK-but-absent → fatal 400 nothing saved; list-call-failed → non-fatal warn; list-OK-and-present → proceed. |
| 6 | MEDIUM | **Fixed** | §6.1 single `normalizePhone` used by both routes and the add flow; §6.3 legacy-row reconciliation (same-user update, documented stale-row gotcha); §4.2 step 8 / §5.2 step 4 missing-`display_phone_number` → 400 guard. |
| 7 | MEDIUM | **Fixed** | §4.2 step 7 — registration advisory only, never blocks onboarding on any result; already-registered matched on numeric `error.code === 133016`, never on message substring. |
| 8 | NIT | **Fixed** | §10.1 / §10.2 / §4.1 wiring — server `META_CONFIG_ID` dropped as dead config; only `NEXT_PUBLIC_META_CONFIG_ID` (read by `FB.login`) remains; AC #15 note explains the placement. |
| 9 | NIT | **Fixed** | §10.2 prerequisites items 4–5 — `NEXT_PUBLIC_META_APP_ID` and `NEXT_PUBLIC_META_CONFIG_ID` called out as build-time-inlined (rebuild required), with the Path-A-no-ops-if-unset warning. |
| 10 | NIT | **Fixed** | §14 / §15 step 3 — crypto test is a plain `scripts/test-crypto.mjs` (inline AES-256-GCM, no tsx/runner/compile), run with `ENCRYPTION_KEY=$(openssl rand -base64 32) node scripts/test-crypto.mjs`. |
| 11 | NIT | **Fixed** | §7.2 — detail page is the **sole** owner of the "Refresh status" action; the repurposed `[id]/verify` page is a pure redirect to the detail page. |
| 12 | NIT | **Fixed** | §8 step 3 — inbound resolution reduced to two exhaustive outcomes: match → write under the matched row's real `userId`; no match → log-and-skip. No "log-only match that still writes" and no env-based owner guessing. |

No requirement was weakened to close a finding: the isolation contract (FR-8) is now
strictly implementable (findings #1, #12), credit consistency on the send path (FR-6)
is preserved under the decrypt-throw case (finding #2), and webhook authenticity
(FR-7) fails closed with operator-visible logging (finding #3).
