# Design Review — Public server-to-server (M2M) API with per-tenant API keys

Reviewer: design-review subagent (fresh read, no authoring context)
Date: 2026-10-13
Design under review: `.agents/tasks/public-api-m2m/design.md` (iteration 3)
Requirements: `.agents/tasks/public-api-m2m/requirements.md`

## Method

I read the full design and requirements, then verified every load-bearing claim against the live source:

- `src/app/api/messages/send/route.ts` (byte-for-byte parity target)
- `scripts/add-tenant-meta-app-table.mjs` (migration pattern)
- `src/lib/auth.ts` (superadmin derivation)
- `src/lib/whatsapp.ts` (`resolveSendCredentials`)
- `src/app/api/admin/users/[id]/route.ts` (role never set to superadmin)
- `prisma/schema.prisma` (User/WhatsAppNumber/Template/Message/UserCredits shapes)
- `src/app/docs/page.tsx` (the "no programmatic API-key scheme" note)
- `src/components/dashboard/sidebar.tsx` (nav array)
- `src/app/api/numbers/route.ts` (dashboard page dependency)

## Findings

No HIGH or MEDIUM findings. The design is internally consistent, conforms to the requirements, and its code-level assumptions check out against the real source. The items below are NITs only.

1. **NIT — `GET /api/numbers` response shape not pinned for the dashboard page.** §6.4 says the create form fetches verified numbers "from `GET /api/numbers`, filtered to `verificationStatus === "verified"`." The live route (`src/app/api/numbers/route.ts`) returns a **bare array** of serialized numbers (`numbers.map(serializeNumber)`), not an envelope like `{ numbers: [...] }`. The design is consistent with a bare array, but it never states it, so an implementer could guess wrong.
   Concrete fix: add one line to §6.4 — "`GET /api/numbers` returns a bare `WhatsAppNumber[]` (accessToken stripped); filter client-side on `verificationStatus === 'verified'`."

2. **NIT — Prisma relation names on `WhatsAppNumber` could collide with the existing `Template.whatsappNumber`/`Message.whatsappNumber` relations.** §1.1 adds `WhatsAppNumber.apiKeys ApiKey[]` and `ApiKey.whatsappNumber WhatsAppNumber`. The schema already has `Template.whatsappNumber` and `Message.whatsappNumber` fields relating to `WhatsAppNumber`. Prisma disambiguates by field name, so `apiKeys` + `whatsappNumber` on `ApiKey` is fine, but the design should confirm the relation is **unnamed** (default) and that no `@relation("...")` name is needed, since the existing relations are also unnamed and Prisma infers one relation per field pair. This is almost certainly correct but worth an explicit note so the implementer does not add a spurious named relation.
   Concrete fix: in §1.1 add "both new relations are unnamed (default inference), matching the existing unnamed `User`/`WhatsAppNumber` relations; no `@relation(\"name\")` is required."

3. **NIT — `?status` validation set includes `submitted` but the public template `select` does not surface a usability hint for it.** §5.3 validates `?status` against `draft | pending | submitted | approved | rejected` (matches the schema comment on `Template.status`). This is correct and complete. The only nit: the schema's status comment lists exactly these five, so the design should reference the schema as the source of truth for the enum rather than hardcoding — if a sixth status is ever added, the two drift silently.
   Concrete fix: add a comment in §5.3 "KNOWN mirrors the `Template.status` comment in schema.prisma (draft|pending|submitted|approved|rejected); keep in sync if the schema adds a status."

## Verdict

Zero HIGH and zero MEDIUM findings → **APPROVED**.

The three NITs do not block. They are small clarity improvements the implementer can fold in without a re-review.

## Verified Assumptions

Each item below was confirmed against the actual source.

1. **Session send route behavior (byte-for-byte parity target).** Verified in `src/app/api/messages/send/route.ts`. The design's §4 extraction faithfully mirrors the real ordering and semantics:
   - Input 400s: `!numberId || !recipient || !templateId` → "Missing required fields"; number `findFirst` with `verificationStatus:"verified"` → 400 "Invalid or unverified WhatsApp number"; template `findFirst` with `status:"approved"` → 400 "Template not found or not approved". ✓
   - OTP guard: `template.category === "authentication" && !variables?.[0]` → 400 "OTP code variable required for authentication template", **before** credit check and message create. ✓ (Design §4 step 1 and §4.3 preserve this ordering.)
   - Superadmin exemption: `isSuperAdmin = session.user.role === "superadmin"`; credit check skipped, deduct skipped, refund skipped when true. ✓
   - Insufficient credits: non-superadmin, `!userCredits || totalCredits <= 0` → **400** "Insufficient credits", before message create / Meta. ✓ (Design §4.2 remaps helper 402→400 in the session wrapper to preserve this exact 400.)
   - Message create `status:"queued"` with `whatsappNumberId`, `templateId`, `recipientPhone`, serialized `templateVariables`. ✓
   - Credit deduct (`totalCredits -1`, `usedCredits +1`) after message create. ✓
   - `resolveSendCredentials(number)` wrapped in try/catch → nulls on throw. ✓
   - Null-credential branch: `finalStatus="failed"`, `errorMessage="WhatsApp number is not connected. Reconnect it to send messages."` ✓ (exact string match with the live route).
   - `#131008` auth-template button: `{ type:"button", sub_type:"url", index:"0", parameters:[{ type:"text", text: variables[0] }] }`, keyed on `template.category === "authentication" && variables?.[0]`. ✓ (exact match).
   - `recipient.replace(/\D/g, "")`, `language.code ?? "en"`, Meta URL `graph.facebook.com/v19.0/${phoneNumberId}/messages`, `metaMessageId = metaData.messages?.[0]?.id ?? null`. ✓
   - Meta non-2xx: `errorMessage = metaData.error?.message ?? "Failed to send via Meta API"`, status failed. ✓
   - Message update sets `status`, `sentAt` only when sent, `metaMessageId`, `errorMessage`. ✓
   - Failure path refunds (`totalCredits +1`, `usedCredits -1`) when non-superadmin, then returns **500** `{ error }`. ✓ (Both not-connected and Meta-fail return 500 — design §4 step 10 and the error table are correct.)
   - Success body `{ id, status:"sent", message:"Message sent successfully" }` for the session route; the public route returns `{ id, status, metaMessageId }` per FR3.1.6. ✓

2. **Superadmin is email-driven, not DB-role-driven (design's HIGH-1 claim).** Verified in `src/lib/auth.ts` JWT callback: `token.role = user.email === (process.env.SUPERADMIN_EMAIL || "neanvtech@gmail.com") ? "superadmin" : (user.role ?? "admin")`. Confirmed in `src/app/api/admin/users/[id]/route.ts` that the only role write is `if (role === "admin") updateData.role = role` — the dashboard can never persist `role = "superadmin"`. Therefore a public-path `owner.role === "superadmin"` check alone would misclassify the superadmin and wrongly charge credits. The design's `isSuperAdminUser({ email, role })` predicate (email override OR `role === "superadmin"`) correctly mirrors the JWT rule. ✓

3. **`isSuperAdminUser` field types match the schema.** `User.email String @unique` (NOT NULL) and `User.role String @default("admin")` (NOT NULL) confirmed in `prisma/schema.prisma`. The design's tightened `{ email: string; role: string }` signature is correct — no impossible `| null`. ✓

4. **Migration pattern.** Verified `scripts/add-tenant-meta-app-table.mjs`: manual `.env` regex parse, `createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN })`, single `PRAGMA table_info(...)` probe used only for the log line, `CREATE TABLE IF NOT EXISTS` + `CREATE ... INDEX IF NOT EXISTS` run unconditionally, `catch → console.error → process.exit(1)`, `client.close()` in `finally`, no FOREIGN KEY, timestamps plain `TEXT NOT NULL` with no SQL default. The design's §1.2 clone (with two `CREATE INDEX IF NOT EXISTS` statements, both unconditional) is a faithful mirror and idempotent on re-run. Index names (`ApiKey_keyHash_key`, `ApiKey_userId_idx`) follow Prisma's naming convention, so introspection stays consistent. ✓ No `prisma db push` (FR1.5/NFR7). ✓

5. **`resolveSendCredentials` contract.** Verified in `src/lib/whatsapp.ts`: returns decrypted `{ phoneNumberId, accessToken }` when both stored fields are non-null, else `{ null, null }`; `decrypt()` may throw. The design's try/catch-to-null handling and null-credential branch match. ✓

6. **Schema shapes for the public routes.** `Message` has `id, status, recipientPhone, metaMessageId, errorMessage, sentAt, deliveredAt, readAt, createdAt, userId, whatsappNumberId` — all fields the §5.2 `select` and `where: { id, userId, whatsappNumberId }` reference exist. ✓ `Template` has `id, name, category, language, status, userId` and nullable `whatsappNumberId` — the §5.3 select and the decision to scope by `userId` only (not bound number) are justified by the nullable template-number relation. ✓

7. **Docs correction target exists.** Verified `src/app/docs/page.tsx` lines ~476–485 contain the "no programmatic API-key scheme" / "must first log in through the NextAuth credentials flow and reuse the returned session cookie" note that FR5.3 requires correcting. ✓

8. **Sidebar nav array.** Verified `src/components/dashboard/sidebar.tsx` has a `navigation` array of `{ name, href, icon }` objects and imports icons from `lucide-react`; adding `{ name: "API Keys", href: "/dashboard/api-keys", icon: KeyRound }` and importing `KeyRound` is exactly the right edit. ✓

9. **Multi-tenant isolation.** Confirmed every public query is scoped: send resolves template by `{ userId: ctx.userId }` and sends only through `ctx.number` (the key's bound number, never a client-supplied id); status reads by `{ id, userId: ctx.userId, whatsappNumberId: ctx.number.id }` (404 for cross-tenant/cross-number, no existence oracle); templates list by `{ userId: ctx.userId }`. No `/api/v1` endpoint accepts a user/number id from the client. ✓ (NFR4, AC6/10/11/14.)

10. **Key storage is hash-only, constant-time compare, no logging.** `keyHash` is the only secret-derived column (unique); plaintext never stored (FR1.6); `generateApiKey` uses `crypto.randomBytes(32)` (256 bits, NFR3); `authenticateApiKey` computes `sha256(token)`, looks up by hash, then applies `crypto.timingSafeEqual` on equal-length hex buffers as defense in depth (NFR2); `lastUsedAt` update is fire-and-forget with a `.catch` that swallows (never logs the key); no module logs the plaintext/hash/random bytes (NFR1, AC16). The one-time reveal (§6.2) returns `key` from the in-memory plaintext, never a DB read, and omits `keyHash` via a `select` allow-list. ✓

11. **Status/error semantics fully specified.** The §7 "Status semantics" list and the "Error handling (per operation)" table enumerate every code: 401 (auth), 400 (validation / not-approved template / missing OTP), 402 (insufficient credits, public), 404 (unknown message id or template not found/owned), 500 (not-connected number or Meta non-2xx, both after refund). The session wrapper's `402→400` remap is the single documented asymmetry and preserves observable legacy behavior. ✓

## Unverified / Wrong Assumptions

None. Every claim the design makes about the existing code was checked against the source and found accurate. In particular:

- The design does not overstate parity: the one deliberate difference (public 402 vs session 400 for insufficient credits) is explicitly called out and the remap keeps the session route observably unchanged.
- The requirements were updated (FR3.1.2/FR3.1.4, `Last updated: 2026-10-13`) to make `templateName | templateId` first-class, so the design's XOR `.refine` **conforms to** the spec rather than silently widening it — confirmed by reading the current requirements.md, which specifies "exactly one of `templateName` or `templateId`."

No assumption remained unverified at the end of this review.
