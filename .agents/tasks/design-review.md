# Design Review — Meta WhatsApp Cloud API Multi-Tenant Onboarding

Reviewer: design-review subagent (fresh read, no prior context)
Design reviewed: `.agents/tasks/design.md` (revision 2)
Requirements: `.agents/tasks/requirements.md`
Date: 2026-10-11

## Method

I read the design and the requirements end to end, then verified every claim the
design makes about the existing codebase against the actual source rather than
taking the design's word for it. Files read and verified:

- `src/app/api/messages/send/route.ts`
- `src/app/api/chat/[contactPhone]/send/route.ts`
- `src/app/api/webhooks/whatsapp/route.ts`
- `src/app/api/numbers/route.ts`
- `src/app/api/numbers/[id]/route.ts`
- `src/app/api/numbers/[id]/verify/route.ts`
- `src/app/api/numbers/[id]/confirm/route.ts`
- `src/app/dashboard/numbers/add/page.tsx`
- `src/app/dashboard/numbers/[id]/page.tsx`
- `prisma/schema.prisma`
- `src/lib/db.ts`
- `src/app/api/payments/verify/route.ts` (crypto import claim)
- `package.json` (deps / test-runner claim)
- `.env.example`

This is revision 2; it carries a §17 table claiming all 12 prior findings are
resolved. I re-checked each resolution against the code rather than trusting the
table. The critical concern areas named in the task brief — Graph API call shapes,
raw-body webhook handling, encryption key encoding, multi-tenant isolation, the
manual-path 400-without-save contract, send-path regression safety, schema
nullability, and env-var documentation — are each addressed and consistent with the
real code. The remaining findings below are all NITs; none block.

## Verified Assumptions (design claim → confirmed against source)

1. **`messages/send` current behavior** — the message row is created and the credit
   decremented *before* `phoneNumberId`/`accessToken` are resolved; the refund lives
   only inside the final `if (finalStatus === "failed")` block; the existing
   `if (!phoneNumberId || !accessToken)` branch sets `finalStatus = "failed"`.
   Confirmed. The design's §9.1 wrap (catch → set both creds `null` → fall into the
   existing failed+refund branch) is therefore correct and preserves credit
   consistency without reordering the OTP guard or the credit check.
2. **Send-path regression anchors** — the auth-template OTP guard
   (`category === "authentication" && !variables?.[0]` → 400) runs before any row or
   deduction; the `#131008` fix appends `{ type: "button", sub_type: "url",
   index: "0", parameters: [...] }`; superadmin skips the credit check and refund;
   Graph version is `v19.0`; `to` is digit-stripped. All confirmed verbatim.
3. **Webhook current state** — GET handshake keys off `META_WEBHOOK_VERIFY_TOKEN`;
   POST does `await request.json()` with no signature check; status mapping is by
   `metaMessageId` via `updateMany`; inbound resolution falls back to
   `META_PHONE_NUMBER_ID` then "any verified number". Confirmed. The design's plan to
   switch POST to `request.text()` + `JSON.parse`, add the HMAC check, and remove both
   fallbacks is grounded in the real code.
4. **Schema** — `WhatsAppNumber` has only `phoneNumber @unique`; there is NO compound
   `@@unique([phoneNumber, userId])`; `verificationCode` still exists. Confirmed. The
   §6.2 decision to use find-then-branch instead of a Prisma `upsert` is justified by
   the real schema (a `upsert` cannot be scoped to `userId`).
5. **`add/page.tsx` legacy key** — stores `phoneNumber.replace(/\D/g, "")` as
   `cleanedNumber`. Confirmed, matching the §6.1 `normalizePhone` rule and the §6.3
   reconciliation reasoning.
6. **Detail page** — "Continue Verification" link renders only when
   `verificationStatus !== "verified"`; there is currently no "Refresh status" button.
   Confirmed; §7.2 adds the single owner for it.
7. **`numbers` routes** — `POST /api/numbers` currently mints a `pending` number from
   a bare `phoneNumber`; `verify` generates a random 6-digit code; `confirm` flips to
   `verified` on code match. Confirmed; §7.1 repurpose/neutralize decisions are
   accurate to the code they replace.
8. **Stack facts** — `prisma` is a default export from `@/lib/db`; datasource uses
   `env("TURSO_DATABASE_URL")`; `payments/verify` imports Node `crypto`; `zod` is a
   dependency; there is NO test runner / `tsx` in `package.json`. All confirmed —
   validating the "zero new dependencies" and the plain-`.mjs` crypto test decisions.
9. **`.env.example` current state** — has Postgres `DATABASE_URL`, no Turso vars, a
   partial Meta set. Confirmed; the §10.1 rewrite is warranted.
10. **New files do not already exist** — `src/lib/crypto.ts`, `src/lib/whatsapp.ts`,
    `src/app/api/numbers/embedded-signup/route.ts`, `src/app/api/numbers/manual/route.ts`,
    `scripts/test-crypto.mjs` are all new. Confirmed.

## Unverified / Residual-Risk Assumptions (external, cannot confirm from code)

These are inherent to Meta's platform and cannot be proven from this repo. They are
not findings in themselves, but the implementer should treat them as risks:

- **Embedded Signup token type/lifetime** — §4.2 step 2 calls the OAuth code-exchange
  result a "business token" and stores it per number with `tokenExpiresAt` from
  `expires_in`. In practice the code exchange typically returns a *user* access token
  (not a long-lived System User token). The design puts refresh out of scope
  (consistent with the requirements), so a connected number may stop sending when the
  token expires. See NIT-2.
- **`debug_token` `granular_scopes[].target_ids` population** — the design already
  treats this as best-effort with a terminal 400 fallback (prior finding #4), which is
  the correct defensive posture.
- **`/{phoneNumberId}/register` semantics and error code `133016`** for
  already-registered — matching on the numeric code (not message text) is the right
  call; the exact code is a Meta detail the implementer should confirm against current
  Graph docs at build time.

## Findings

1. **NIT — §9.2 narrative overstates "before any row is created."**
   The design says the chat-send credential guard fires "before any row is created."
   Verified against `src/app/api/chat/[contactPhone]/send/route.ts`: the message row
   is indeed created only after the credential check, so the claim holds for the
   *message* row. However, the **conversation `upsert` runs before** the credential
   block, so on a decrypt-throw / missing-creds path a conversation row is still
   created or its `lastMessagePreview`/`lastMessageAt` updated while the send returns
   500. This is **pre-existing behavior that the rewire does not change** (the current
   code already upserts the conversation before the cred check), so it is not a
   regression — only the sentence is imprecise.
   CONCRETE FIX: reword §9.2 to "no *message* row is created before the guard; the
   conversation upsert already runs earlier and is unchanged by this rewire," or, if a
   stray conversation row is undesirable, move the `resolveSendCredentials` wrap above
   the conversation `upsert` so a credential failure returns 500 before any DB write.

2. **NIT — manual-path `tokenExpiresAt: null` silently accepts a temporary token.**
   §5.2 step 4 hardcodes `tokenExpiresAt: null` ("manual tokens treated as
   long-lived; we do not introspect expiry"). If a consultant pastes a short-lived
   user token, sends will fail later with no expiry signal in the UI. The UI helper
   text in §5.1 does recommend a System User token, which mitigates this.
   CONCRETE FIX: keep the behavior but add one line to §5.2/§10.3 noting the known
   gotcha ("a temporary token stored manually will stop working at Meta's expiry; no
   proactive expiry tracking") so it lands in `scratchpad.md`'s gotchas, matching the
   out-of-scope refresh decision.

3. **NIT — AC #15 wording vs. `META_CONFIG_ID` placement.**
   Acceptance criterion #15 literally names `META_CONFIG_ID` in `.env.example`; the
   design (prior finding #8) intentionally drops the server mirror and keeps only
   `NEXT_PUBLIC_META_CONFIG_ID`. The design's §15 note explains this is the correct
   placement (the config id is only read by `FB.login` in the browser). This is a
   defensible deviation, not a defect, but it technically diverges from the literal AC
   text.
   CONCRETE FIX: leave the implementation as designed; ensure the `scratchpad.md` /
   `.env.example` comment states explicitly that the Embedded Signup Configuration ID
   lives as `NEXT_PUBLIC_META_CONFIG_ID` and that this satisfies AC #15's intent, so a
   later reader does not "fix" it by re-adding a dead server var.

## Verdict

No HIGH or MEDIUM findings. Three NITs, all documentation-precision or
already-mitigated external risks. Per the mechanical rule (HIGH + MEDIUM count = 0),
the verdict is **APPROVED**. The design is implementable as written; the NITs can be
folded into the implementation without a design re-spin.
