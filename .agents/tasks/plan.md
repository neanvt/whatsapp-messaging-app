# Implementation Plan — Fix 500 on POST /api/messages/send for authentication templates

## Context (confirmed from code, do not re-investigate)

- Route: `src/app/api/messages/send/route.ts`. The `else` branch (when Meta creds exist) builds `const components: object[] = []` and only ever pushes a `body` component from `variables`. It never adds a `header` or `button` component.
- Prisma `Template` model (`prisma/schema.prisma`) has `category String // marketing, utility, authentication`. The route already fetches the approved template into the `template` variable, so `template.category === "authentication"` is available.
- Order of side effects in the handler today:
  1. validate session / fields
  2. fetch `number`, fetch `template`
  3. credit check (skipped for superadmin)
  4. `prisma.message.create(... status: "queued")`
  5. credit deduction (skipped for superadmin)
  6. resolve `phoneNumberId` / `accessToken`, build payload, POST to Meta
  7. `prisma.message.update(...)` with result
  8. on `finalStatus === "failed"`: refund credit, return 500
- Meta's `(#131008) Required parameter is missing` is returned for `otp_1` (AUTHENTICATION) because the copy-code URL button requires a matching `button` component carrying the OTP code. Required send shape for auth templates:
  ```json
  "components": [
    { "type": "body",   "parameters": [ { "type": "text", "text": "<CODE>" } ] },
    { "type": "button", "sub_type": "url", "index": "0", "parameters": [ { "type": "text", "text": "<CODE>" } ] }
  ]
  ```
  where `<CODE>` is `variables[0]`.
- Build command: `npm run build` runs `prisma generate && next build`. Lighter check: `npx tsc --noEmit`. Env keys `META_PHONE_NUMBER_ID` and `META_ACCESS_TOKEN` are present in `.env`.

## Design decisions

- **Where to guard the missing OTP var:** place the auth-template OTP guard EARLY — right after the `template` is fetched/validated and BEFORE the credit check, `message.create`, and credit deduction. This returns a clean 400 without creating a dangling message row or deducting/refunding credits, keeping existing behavior consistent. Rationale: the current refund logic only triggers inside the Meta-failure path; adding a late return would require duplicating refund/cleanup, so guarding before any side effect is simpler and safer.
- **How to detect auth templates:** use `template.category === "authentication"` (the model field), not template name heuristics.
- **Button component shape:** append `{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: variables[0] }] }` after the existing body component, only when `template.category === "authentication"`. Keep `index` as the string `"0"` and the body component unchanged (matches the task's required shape and Meta's documented auth-template format).
- Scope stays minimal: only the component-building block and one early guard change in `route.ts`, plus the scratchpad doc. No schema change, no `prisma migrate`.

## Plan

- [ ] 1. Add an early authentication-template OTP guard in `src/app/api/messages/send/route.ts`.
      Immediately after the `if (!template) { ... }` block (template validated) and BEFORE the credit check / `prisma.message.create` / credit deduction, add:
      `if (template.category === "authentication" && !variables?.[0]) { return NextResponse.json({ error: "OTP code variable required for authentication template" }, { status: 400 }); }`
      This prevents a dangling message row and avoids credit deduction/refund churn.
      Files: `src/app/api/messages/send/route.ts`
      Verify: `npx tsc --noEmit` passes (type-check); confirm the new branch sits above `prisma.message.create`.

- [ ] 2. Append the URL button component for authentication templates in the component-building block.
      In the `else` branch, keep the existing body-component push unchanged. After it, add:
      `if (template.category === "authentication" && vars.length > 0) { components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: vars[0] }] }); }`
      Leave the `metaPayload.template` object and the `...(components.length > 0 ? { components } : {})` spread as-is (the button is now part of `components`).
      Files: `src/app/api/messages/send/route.ts`
      Verify: `npx tsc --noEmit` passes. Then run the project build `npm run build` and confirm it completes without type errors in `route.ts` (step 5 does the full build run and reporting).

- [ ] 3. Confirm no other behavior changed.
      Re-read the modified handler top-to-bottom: superadmin exemption, credit check, `message.create`, credit deduction, Meta POST, `message.update`, failure refund + 500, success 200 — all unchanged except the two additions above. No schema edits. No `prisma migrate` / `db push`.
      Files: `src/app/api/messages/send/route.ts` (review only)
      Verify: `git diff --stat` shows only `route.ts` (plus `scratchpad.md` from step 4) modified; `prisma/schema.prisma` untouched.

- [ ] 4. Create/refresh `scratchpad.md` at the repo root (user global rule).
      Since none exists, create `scratchpad.md` describing the ACTUAL app: a Next.js 14 App Router WhatsApp Business messaging platform — tech stack (Next.js 14, TypeScript, Prisma 5 + `@prisma/adapter-libsql`/Turso libSQL, NextAuth v4, Razorpay, Tailwind/Radix UI), architecture (`src/app` routes + `src/app/api/*` route handlers, `src/lib/db`, `src/lib/auth`), features (auth, WhatsApp number verification, template management, message sending via Meta Cloud API, credits system, Razorpay payments, admin/superadmin panel, audit log), schema tables (User, UserCredits, WhatsAppNumber, Template, Message, Conversation, Payment, AuditLog, Package), and env vars BY KEY NAME ONLY (`TURSO_DATABASE_URL`, `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, NextAuth + Razorpay keys — no values). Document the message-send flow (`POST /api/messages/send`: auth → validate number/template → auth-template OTP guard → credit check → create message → deduct credit → build Meta template components (body always; button for authentication category) → POST to Graph API `v19.0/{phoneNumberId}/messages` → update message → refund+500 on failure). Add `Last updated: <today>` near the top and a `Change log` section (newest first) with a dated entry: "Fixed (#131008) on auth-template sends by adding the URL `button` component (sub_type url, index 0, OTP = variables[0]) and an early 400 guard for a missing OTP variable."
      Files: `scratchpad.md`
      Verify: file exists at repo root, contains the message-send flow + the dated change-log entry, and contains no secret values (only env key names).

- [ ] 5. Run the build and report the result.
      Run `npm run build` in `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp` (it runs `prisma generate && next build`). If the full build is too heavy or fails for env/network reasons unrelated to this change, fall back to `npx tsc --noEmit` and note that.
      Files: none
      Verify: `npm run build` completes successfully (or `npx tsc --noEmit` reports no errors). Report the exact outcome.

- [ ] 6. Validate the generated Meta payload for the `otp_1` case.
      Preferred: write a throwaway standalone Node script (e.g. `scripts/_tmp_otp_test.mjs`) that reads `META_PHONE_NUMBER_ID` and `META_ACCESS_TOKEN` from `.env`, constructs the SAME payload the fixed route produces for an authentication template, and POSTs to `https://graph.facebook.com/v19.0/<phoneNumberId>/messages` with: recipient `917088970099`, template `otp_1`, language `en`, body variable `"123456"`, plus the button component. Report Meta's exact JSON response, then DELETE the script.
      If a live send is not safe/possible (e.g. real recipient, billable message, or creds not usable in this environment), SKIP the live POST and instead record in the task output the exact JSON payload the fixed code generates for `otp_1`:
      ```json
      {
        "messaging_product": "whatsapp",
        "to": "917088970099",
        "type": "template",
        "template": {
          "name": "otp_1",
          "language": { "code": "en" },
          "components": [
            { "type": "body", "parameters": [ { "type": "text", "text": "123456" } ] },
            { "type": "button", "sub_type": "url", "index": "0", "parameters": [ { "type": "text", "text": "123456" } ] }
          ]
        }
      }
      ```
      and explain it satisfies Meta's auth-template requirement because the copy-code URL button now receives its required parameter (the OTP), resolving `(#131008)`.
      Files: `scripts/_tmp_otp_test.mjs` (temporary — delete after) or none
      Verify: either Meta returns a non-error JSON (`messages[0].id` present) for the live test, OR the generated payload above is recorded with the rationale; the temp script is removed (`git status` shows no stray `scripts/_tmp_*` file).

## Notes / assumptions

- `variables` arrives as a JSON array of strings in the request body; `variables[0]` is the OTP. The guard treats an empty/missing array for an authentication template as a 400.
- Live Graph API test (step 6) sends a real, potentially billable WhatsApp message to `917088970099`. The implementer should prefer the payload-inspection fallback unless a live send is explicitly acceptable.

## Implementation evidence (2026-10-10)

### Changes made (`src/app/api/messages/send/route.ts` only, +21 lines)

1. Early auth-template OTP guard, placed immediately after the `if (!template)`
   validation and BEFORE the credit check / `message.create` / credit deduction:
   ```ts
   if (template.category === "authentication" && !variables?.[0]) {
     return NextResponse.json(
       { error: "OTP code variable required for authentication template" },
       { status: 400 },
     );
   }
   ```
2. URL button component appended in the component-building block, after the
   existing body push:
   ```ts
   if (template.category === "authentication" && vars.length > 0) {
     components.push({
       type: "button",
       sub_type: "url",
       index: "0",
       parameters: [{ type: "text", text: vars[0] }],
     });
   }
   ```
   The `metaPayload.template` object and `...(components.length > 0 ? ...)` spread
   were left unchanged. No schema change, no `prisma migrate`/`db push`.
   `git diff --stat` confirms only `route.ts` modified; `prisma/schema.prisma` untouched.

### Build / type-check results

- `npx tsc --noEmit` → exit 0 (no type errors).
- `npm run build` (`prisma generate && next build`) → exit 0, compiled
  successfully; `/api/messages/send` route built as a dynamic server route.

### Meta payload validation (step 6) — payload-inspection fallback

A live POST to recipient `917088970099` would deliver a real, billable WhatsApp
message, so the live send was intentionally skipped in favor of recording the
exact payload the fixed code produces for the `otp_1` authentication-template case
(recipient `917088970099`, language `en`, body/OTP variable `"123456"`):

```json
{
  "messaging_product": "whatsapp",
  "to": "917088970099",
  "type": "template",
  "template": {
    "name": "otp_1",
    "language": { "code": "en" },
    "components": [
      { "type": "body",   "parameters": [ { "type": "text", "text": "123456" } ] },
      { "type": "button", "sub_type": "url", "index": "0", "parameters": [ { "type": "text", "text": "123456" } ] }
    ]
  }
}
```

Why this satisfies Meta: the authentication template `otp_1` has a copy-code URL
button. Meta requires a matching `button` component (`sub_type: "url"`, `index: "0"`)
carrying the OTP as its parameter. The previous code emitted only the `body`
component, so the button parameter was missing → `(#131008) Required parameter is
missing`. The fix adds the button component with the OTP (`variables[0]`), so every
required parameter is now present, resolving `(#131008)`. The early guard returns a
clean 400 if the OTP variable is absent, before any message row or credit mutation.
