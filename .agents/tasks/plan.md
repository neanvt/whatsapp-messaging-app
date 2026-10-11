# Implementation Plan — Meta WhatsApp Cloud API Multi-Tenant Onboarding

Source of truth: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/.agents/tasks/design.md`
(APPROVED, revision 2) and `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/.agents/tasks/requirements.md`.

All paths are absolute under `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp`.
Zero new npm dependencies (Node `crypto` built-in, FB SDK via browser `<script>`,
zod + Prisma already present). Graph API version is `v19.0` everywhere. DB changes
apply via `npm run db:push` (NOT migrations). Build command: `npm run build`
(`prisma generate && next build`).

Verified codebase facts (confirmed by reading the actual files):
- Webhook already exists at `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/webhooks/whatsapp/route.ts`
  — GET handshake works; POST has NO `X-Hub-Signature-256` verification and uses an
  env + "any verified number" inbound fallback that can misattribute tenants.
- `src/app/api/messages/send/route.ts` structure confirmed: auth guard → number
  (`verificationStatus: "verified"`) + template (`status: "approved"`) checks → auth-template
  OTP guard (`category === "authentication" && !variables?.[0]` → 400) BEFORE
  `message.create` and credit deduct → superadmin exemption (`session.user.role === "superadmin"`)
  → `message.create` (status `queued`) → deduct credit → inline creds
  `number.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID` and
  `process.env.META_ACCESS_TOKEN` → `#131008` fix appends `{ type:"button", sub_type:"url",
  index:"0", parameters:[{type:"text",text:vars[0]}] }` → `message.update` with
  `metaMessageId`/`status`/`errorMessage` → on `failed` refund credit (non-superadmin) + 500.
- `src/app/api/chat/[contactPhone]/send/route.ts`: no credit logic, no pre-created row;
  same inline env fallback; missing creds → 500 "Meta API credentials not configured";
  Meta failure → 422.
- `Message` model has `metaMessageId`, `status`, `deliveredAt`, `readAt`, `errorMessage`.
- `WhatsAppNumber` unique key is `phoneNumber` only (no compound unique).
- `src/lib/db.ts` default-exports `prisma`; `src/lib/auth.ts` named-exports `authOptions`.
- `import crypto from "crypto"` pattern already used in `src/app/api/payments/verify/route.ts`.
- Numbers list `src/app/dashboard/numbers/page.tsx` fetches `/api/numbers` and DELETEs
  `/api/numbers/[id]`; "Add Number" links to `/dashboard/numbers/add` whose page POSTs
  `/api/numbers` with a bare `phoneNumber`.
- No `.kiro/steering/*`, AGENTS.md, or CONTRIBUTING found; `scratchpad.md` exists at repo root.

> Note on user-reported issues: do NOT dismiss any reported symptom as "already working"
> from code reading alone. Where runtime verification is not possible in this environment
> (live Meta calls, real delivery), the item is marked **needs runtime verification** and
> the coder must verify in-context during implementation.

---

- [ ] 1. Extend the `WhatsAppNumber` model with the new nullable Meta-onboarding fields and apply to the live Turso DB.
      Add: `accessToken String?` (AES-256-GCM ciphertext at rest — never plaintext/logged),
      `tokenExpiresAt DateTime?`, `displayPhoneNumber String?`, `verifiedName String?`,
      `qualityRating String?`, `codeVerificationStatus String?`, `platformType String?`,
      `connectionType String @default("manual")`. All additive/nullable; keep `verificationCode`.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/prisma/schema.prisma`
      Verify: `npm run db:push` succeeds against the live Turso DB with no data loss, then
      `npm run build` (`prisma generate && next build`) passes. (AC #1, #2 — **needs runtime verification** against live Turso)

- [ ] 2. Create the AES-256-GCM crypto utility.
      `src/lib/crypto.ts` exporting `encrypt(plaintext): string` → `base64(iv).base64(tag).base64(ciphertext)`
      and `decrypt(payload): string`. Lazy private `getKey()` reads `process.env.ENCRYPTION_KEY`,
      base64-decodes, asserts exactly 32 bytes else throws
      `Error("ENCRYPTION_KEY is missing or not a 32-byte base64 key")`. 12-byte random IV per
      encrypt. `decrypt` splits on `.`; !== 3 segments → `Error("Invalid ciphertext format")`;
      GCM tag check in `final()` throws on tamper. Module NEVER logs. Also add the plain
      `scripts/test-crypto.mjs` harness (inline AES-256-GCM, same format, no import from TS,
      no new dep) asserting round-trip, tamper-throws, and absent/short-key-throws.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/lib/crypto.ts`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/scripts/test-crypto.mjs`
      Verify: `ENCRYPTION_KEY=$(openssl rand -base64 32) node scripts/test-crypto.mjs` prints
      pass for all three assertions and exits 0; `npm run build` passes. (AC #9)

- [ ] 3. Create the shared WhatsApp helper module.
      `src/lib/whatsapp.ts` exporting: `normalizePhone(s)` → `s.replace(/\D/g,"")`;
      `serializeNumber(number)` → number row with `accessToken` removed; `resolveSendCredentials(number)`
      → if `number.accessToken` non-null return `{ phoneNumberId: number.phoneNumberId,
      accessToken: decrypt(number.accessToken) }` (may throw), else env fallback
      `{ phoneNumberId: number.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID,
      accessToken: process.env.META_ACCESS_TOKEN }`; `NumberOwnedByOtherTenantError` class;
      `upsertNumberForUser({ userId, phoneNumber, data })` using find-then-branch (findUnique on
      `phoneNumber` → if existing.userId !== userId throw NumberOwnedByOtherTenantError → else
      update by `existing.id` → else create, catching Prisma P2002 → throw NumberOwnedByOtherTenantError).
      NOT a Prisma `upsert`. Import `prisma` default from `@/lib/db`, `decrypt` from `@/lib/crypto`,
      and `Prisma` from `@prisma/client`.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/lib/whatsapp.ts`
      Verify: `npm run build` passes (type-checks the new exports and Prisma types). (supports AC #8, #10)

- [ ] 4. Add the Embedded Signup backend endpoint (Path A).
      New `POST` handler at `src/app/api/numbers/embedded-signup/route.ts`. Auth-guard with
      `getServerSession(authOptions)` (401 without `session.user.id`); scope all writes to
      `session.user.id`. zod body `{ code: string(1..4000), phoneNumberId?: string(1..100),
      wabaId?: string(1..100) }`. Steps per design §4.2: require `META_APP_ID`+`META_APP_SECRET`
      (else 500); exchange code (no redirect_uri) for business token + `expires_in`→`tokenExpiresAt`;
      resolve `wabaId` (client value first, else `debug_token` defensive
      `data?.data?.granular_scopes ?? []` → `whatsapp_business_management` → `target_ids?.[0]`,
      else terminal 400); discover `phoneNumberId` via `GET /v19.0/{wabaId}/phone_numbers` if absent;
      fetch health `GET /v19.0/{phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status`;
      `POST /v19.0/{wabaId}/subscribed_apps` (non-fatal); `POST /v19.0/{phoneNumberId}/register`
      with random 6-digit pin (advisory only — already-registered via numeric `error.code === 133016`,
      never message text; never fails onboarding); guard empty `display_phone_number` → 400;
      `normalizePhone` → `encrypt(businessToken)` → `upsertNumberForUser(...)` with
      `connectionType:"embedded_signup"`, `verificationStatus:"verified"`, `verifiedAt:new Date()`;
      map `NumberOwnedByOtherTenantError` → 409; respond `serializeNumber(...)` (no token).
      Use `fetch` to Graph `v19.0`. Never log tokens.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/numbers/embedded-signup/route.ts`
      Verify: `npm run build` passes. Live OAuth exchange is **needs runtime verification** (requires
      Meta Config ID + App Review, user-supplied); coder confirms handler shape, zod rejects,
      and 409/400 branches by reading the compiled route. (FR-3, AC #8 shape)

- [ ] 5. Add the manual-credential backend endpoint (Path B).
      New `POST` handler at `src/app/api/numbers/manual/route.ts`. Auth-guard + scope to
      `session.user.id`. zod body `{ wabaId: string(1..100), phoneNumberId: string(1..100),
      accessToken: string(10..5000), label?: string(0..100) }`. Steps per design §5.2:
      validate live `GET /v19.0/{phoneNumberId}?fields=...` with provided token — non-OK → 400 with
      Meta's `error.message`, NOTHING saved; three-way WABA tie-check via
      `GET /v19.0/{wabaId}/phone_numbers` (list-OK-and-present → proceed; list-OK-and-absent → fatal
      400 nothing saved; list-call-failed → non-fatal warn); `subscribed_apps` non-fatal; empty
      `display_phone_number` guard → 400; `encrypt(providedToken)` + `upsertNumberForUser(...)` with
      `connectionType:"manual"`, `tokenExpiresAt:null`, `verificationStatus:"verified"`,
      `verifiedAt:new Date()`; `NumberOwnedByOtherTenantError` → 409; respond `serializeNumber(...)`.
      Never log the token; never echo it back.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/numbers/manual/route.ts`
      Verify: `npm run build` passes. Coder confirms: invalid-creds path returns 400 and creates no
      row (inspect handler ordering — validate-before-persist), response omits token. Live Meta
      validation is **needs runtime verification** with real/sandbox creds. (FR-4, AC #7, #8)

- [ ] 6. Add `X-Hub-Signature-256` verification and tighten multi-tenant inbound routing in the existing webhook.
      Modify `src/app/api/webhooks/whatsapp/route.ts`. Keep GET handshake unchanged. POST: read raw
      body with `await request.text()` BEFORE parsing, then `JSON.parse`. Verify signature per design
      §8: `META_APP_SECRET` unset → 401 + `console.error` naming the key; header missing / no
      `sha256=` prefix → 401; compute `crypto.createHmac("sha256", secret).update(raw,"utf8").digest("hex")`;
      length-guard both hex buffers before `crypto.timingSafeEqual` (throws on length mismatch) → 401;
      mismatch → 401 (payload NOT processed). After valid signature: keep status mapping
      (`updateMany where metaMessageId` → `status`/`deliveredAt`/`readAt`/`errorMessage`); for inbound,
      resolve owner STRICTLY by `value.metadata.phone_number_id` (`findFirst where phoneNumberId`),
      write under that row's real `userId`; NO match → `console.log` + skip. REMOVE the env +
      "any verified number" fallback entirely. Post-signature processing errors still return 200.
      Never log the secret/HMAC/tokens. `import crypto from "crypto"`.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/webhooks/whatsapp/route.ts`
      Verify: `npm run build` passes. GET handshake: `curl` with `hub.mode=subscribe` + matching
      verify token → exact challenge/200; wrong token → 403. POST: craft a payload, sign with
      `openssl`/node HMAC over the raw body using a test secret → matching `Message` updated by
      `metaMessageId`; missing/invalid signature → 401 and no rows created. (AC #3, #4, #5, #6, #13 —
      **needs runtime verification** for POST signed payload; coder exercises with a local test secret)

- [ ] 7. Rewire `messages/send` to per-number decrypted credentials while preserving all existing behavior.
      Modify `src/app/api/messages/send/route.ts`. Replace the inline
      `number.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID` / `process.env.META_ACCESS_TOKEN`
      assignment with a try/catch around `resolveSendCredentials(number)` (import from `@/lib/whatsapp`);
      on throw set both `phoneNumberId`/`accessToken` to `null` and `console.error` without the token,
      so the pre-existing `if (!phoneNumberId || !accessToken)` branch sets `finalStatus="failed"` and
      the end-of-handler refund runs. PRESERVE EXACTLY: auth guard, number `verified` + template
      `approved` checks, auth-template OTP guard before any row/credit, the `#131008` button component,
      credit deduct on send / refund on failure, superadmin exemption, `message.create`→`update` with
      `metaMessageId`/`status`/`errorMessage`, Graph `v19.0`, `to` digit-stripping, response shapes.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/messages/send/route.ts`
      Verify: `npm run build` passes. Coder confirms by re-reading the diff that the OTP guard still
      precedes `message.create`, the button block + deduct/refund + superadmin exemption are unchanged,
      and the decrypt-throw funnels into the failed+refund branch. (FR-6, AC #10, #11 — **needs runtime
      verification** for a live send; this fixes the user's "sent but not received" via per-tenant creds)

- [ ] 8. Rewire `chat/[contactPhone]/send` to per-number decrypted credentials.
      Modify `src/app/api/chat/[contactPhone]/send/route.ts`. Replace the inline env fallback with a
      try/catch around `resolveSendCredentials(waNumber)`; on throw leave both `null` so the existing
      `if (!phoneNumberId || !accessToken) return 500 "Meta API credentials not configured"` fires
      BEFORE any `message.create`. Preserve the conversation upsert, free-text payload, `message.create`,
      422-on-Meta-failure and 500-on-missing-creds shapes, Graph `v19.0`.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/chat/[contactPhone]/send/route.ts`
      Verify: `npm run build` passes; coder confirms the missing-creds 500 still precedes row creation. (FR-6.3, AC #12)

- [ ] 9. Repurpose/neutralize the fake verify/confirm/bare-POST endpoints and `serializeNumber` the number reads.
      - `src/app/api/numbers/[id]/verify/route.ts`: remove random-code generation; make it a real health
        refresh — if the number has a stored token, `GET /v19.0/{phoneNumberId}?fields=...` and update
        `displayPhoneNumber`/`verifiedName`/`qualityRating`/`codeVerificationStatus`/`platformType`;
        no token (legacy) → 400 "Reconnect this number via Connect WhatsApp". Return `serializeNumber`.
      - `src/app/api/numbers/[id]/confirm/route.ts`: neutralize → 410 Gone
        "Manual code confirmation is no longer supported. Connect via Embedded Signup or manual credentials."
      - `src/app/api/numbers/route.ts`: keep `GET` (return `serializeNumber` for each row); change `POST`
        so a bare `phoneNumber` is rejected with 400 directing to the two real paths (no usable number minted).
      - `src/app/api/numbers/[id]/route.ts`: `GET` returns `serializeNumber(number)`; keep DELETE.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/numbers/[id]/verify/route.ts`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/numbers/[id]/confirm/route.ts`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/numbers/route.ts`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/api/numbers/[id]/route.ts`
      Verify: `npm run build` passes; coder confirms `confirm` cannot mark `verified` from a local code
      and `verify` generates no random code. (FR-5, AC #14; token never leaves server via `serializeNumber`)

- [ ] 10. Replace the frontend fake-code flow with the two real Connect paths and surface real Meta statuses.
      - `src/app/dashboard/numbers/add/page.tsx`: becomes Connect page — "Connect WhatsApp" button loading
        the FB JS SDK once (`https://connect.facebook.net/en_US/sdk.js`), `FB.init({ appId:
        process.env.NEXT_PUBLIC_META_APP_ID, version:"v19.0", ... })`, a `message` listener (origin-guarded
        to facebook.com) capturing `WA_EMBEDDED_SIGNUP` `phone_number_id`/`waba_id`, `FB.login` with
        `config_id: process.env.NEXT_PUBLIC_META_CONFIG_ID`, `response_type:"code"`,
        `override_default_response_type:true`, posting `{ code, phoneNumberId?, wabaId? }` to
        `/api/numbers/embedded-signup`; plus an "Enter credentials manually" toggle with a form (WABA ID,
        Phone Number ID, Access Token, optional label) posting to `/api/numbers/manual`, showing Meta's
        exact 400 message. Remove the phone-string form.
      - `src/app/dashboard/numbers/[id]/verify/page.tsx`: delete the OTP/dev-code UI; make it a pure client
        redirect to `/dashboard/numbers/[id]`.
      - `src/app/dashboard/numbers/page.tsx`: keep list + DELETE; render `connectionType`/real statuses in badges.
      - `src/app/dashboard/numbers/[id]/page.tsx`: surface `displayPhoneNumber`, `verifiedName`,
        `qualityRating`, `codeVerificationStatus`, `platformType`, `connectionType`, and the SINGLE
        "Refresh status" button (calls repurposed `POST /api/numbers/[id]/verify`). Extend the client
        `WhatsAppNumber` TS interfaces with the new optional fields; render conditionally so legacy rows don't break.
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/dashboard/numbers/add/page.tsx`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/dashboard/numbers/[id]/verify/page.tsx`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/dashboard/numbers/page.tsx`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/src/app/dashboard/numbers/[id]/page.tsx`
      Verify: `npm run build` passes (no type errors on the extended interfaces/`NEXT_PUBLIC_*` usage).
      Live popup is **needs runtime verification** (requires Meta Config ID). (FR-5.3, US-E1/AC #17 —
      fixes "code_verification_status not visible"; answers "how the number connects without asking IDs")

- [ ] 11. Update `.env.example` and `scratchpad.md`.
      - `.env.example`: rewrite per design §10.1 — remove Postgres `DATABASE_URL`; add
        `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_JWT_SECRET`,
        full Meta set (`META_APP_ID`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`,
        `META_WABA_ID`, `META_WEBHOOK_VERIFY_TOKEN`), `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_CONFIG_ID`,
        `ENCRYPTION_KEY` (base64/32-byte, `openssl rand -base64 32`), Razorpay keys. Placeholders only —
        NO real secrets. Include the Meta-side prerequisites comment block (§10.2).
      - `scratchpad.md`: refresh `Last updated`, document the two onboarding paths, new endpoints
        (`/api/numbers/embedded-signup`, `/api/numbers/manual`, repurposed `verify`, neutralized `confirm`,
        bare `POST /api/numbers` now 400), new `WhatsAppNumber` fields, new env vars, webhook signature
        verification, the two rewired send paths; prepend a dated change-log entry (newest first).
      Files: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/.env.example`,
      `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/scratchpad.md`
      Verify: open both files and confirm `.env.example` has no Postgres `DATABASE_URL` and lists all
      required keys by name; `scratchpad.md` has the new sections + dated entry. `npm run build` still passes. (FR-9, AC #15, #16)

- [ ] 12. Final integration verification and cleanup.
      Run the full gate: `npm run build` passes clean; `ENCRYPTION_KEY=$(openssl rand -base64 32)
      node scripts/test-crypto.mjs` passes. Re-confirm no decrypted token or ciphertext is returned by any
      number endpoint (all go through `serializeNumber`) and no module logs a token/secret. Remove any
      temporary files created during verification. Document which user-reported items were verified at
      runtime vs. left as needs-runtime-verification (Meta Config ID / App Review are user-supplied).
      Files: none (verification only)
      Verify: `npm run build` exits 0 and the crypto harness exits 0. (AC #1, #9; closes the regression gate)
