# URL button component for WhatsApp authentication-template sends

`POST /api/messages/send` was returning a 500 for authentication templates because the Meta payload carried only a `body` component. Auth templates such as `otp_1` include a copy-code URL button whose parameter (the OTP) is mandatory, so Meta rejected the send with `(#131008) Required parameter is missing`. The fix appends a `button` component (`sub_type: "url"`, `index: "0"`) carrying `variables[0]` whenever `template.category === "authentication"`, and adds an early 400 guard that rejects auth sends with no OTP variable before any message row or credit mutation. The change is confined to `src/app/api/messages/send/route.ts` (+21 lines) plus the new `scratchpad.md`; no schema change, no migration, no unrelated files.

Watch for: a minor condition asymmetry between the guard (`!variables?.[0]`) and the button block (`vars.length > 0`) — benign today but worth a glance (confirmed). Verification used the payload-inspection fallback rather than a live Graph API send (confirmed).

**Verdict**: APPROVED

## High-level view

The button component is the actual fix. It is appended to the existing `components` array only for authentication templates, after the body push, with the OTP sourced from `vars[0]`. The body component and the `...(components.length > 0 ? { components } : {})` spread are untouched, so non-auth sends produce byte-identical payloads to before.

Credit and record integrity is handled by placing the missing-OTP guard early — immediately after template validation and before the credit check, `message.create`, and the credit decrement. A missing OTP therefore returns a clean 400 with no dangling `queued` row and no deduct/refund churn, which is the correct ordering given that refund logic only exists inside the Meta-failure path.

Everything else in the handler — superadmin exemption, insufficient-credit 400, message create/update, failure refund + 500, success 200 — is unchanged. The Prisma schema is untouched; `category` already existed on the `Template` model, so no migration is needed.

Verification evidence is present in the commit message and `plan.md`: `tsc --noEmit` and `npm run build` both exited 0, and the generated `otp_1` payload was recorded rather than sent live (the recipient would be billed). The recorded payload matches Meta's documented auth-template shape.

<details>
<summary>Issues (1)</summary>

1. **Guard/button condition asymmetry** — the guard uses `!variables?.[0]` (truthiness) while the button block uses `vars.length > 0` (presence). Harmless now because the guard already rejects auth templates lacking a truthy `variables[0]`, so the button block never runs for an auth template with an empty/falsy OTP. Non-blocking; optionally align the two conditions for clarity.

</details>

<details>
<summary>Details</summary>

### Button component shape and placement

The new block sits directly after the body-component push inside the creds-present `else` branch:

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

`index` stays the string `"0"` and the OTP is `vars[0]` (the same value the body component already carries), matching Meta's auth-template format. The button is pushed into the same `components` array, so the downstream spread needed no edits, and the condition is false for non-auth templates — their emitted payload is unchanged from before the fix (confirmed).

### Early OTP guard preserves credit/record integrity

```ts
if (template.category === "authentication" && !variables?.[0]) {
  return NextResponse.json(
    { error: "OTP code variable required for authentication template" },
    { status: 400 },
  );
}
```

Placement is the important part: this returns after `template` is validated but before the credit check, `prisma.message.create`, and the credit decrement. A missing OTP on an auth template therefore never creates a `queued` message row and never touches credits, so there is nothing to refund or clean up (confirmed). This is consistent with the existing design, where refund logic lives only inside the Meta-failure path — a late return would have required duplicating that refund, so guarding before any side effect is the correct call.

### Condition asymmetry between guard and button block

The guard tests `!variables?.[0]` (is the first element falsy/absent) while the button block tests `vars.length > 0` (is there at least one element). These are not literally the same predicate, but the sequencing makes the gap unreachable: any auth template whose `variables[0]` is falsy is already rejected by the guard, so by the time control reaches the button block an auth template always has a truthy `vars[0]` and `vars.length > 0` holds. The result is correct; the only cost is that a reader must trace both conditions to convince themselves. Aligning them (e.g. both keyed on `variables?.[0]`) would make the invariant local, but this is a readability nit, not a defect (confirmed).

### Existing behavior and scope

A top-to-bottom read of the handler confirms the surrounding flow is unchanged: 401 on no session, 400 on missing fields / unverified number / unapproved template, superadmin credit exemption, insufficient-credit 400, `message.create` with `status: "queued"`, credit decrement, Meta POST to `v19.0/{phoneNumberId}/messages`, `message.update` with final status, and the failure branch that refunds the credit (non-superadmin) and returns 500. `git diff HEAD~1 --name-only` on `prisma/schema.prisma` is empty, and `category` already exists on the `Template` model, so no migration is warranted (confirmed).

### Verification evidence

The commit message and `plan.md` record `npx tsc --noEmit` → exit 0 and `npm run build` (`prisma generate && next build`) → exit 0. The Meta payload step used the payload-inspection fallback: a live send to `917088970099` would deliver a real billable message, so the generated `otp_1` payload was recorded instead, and it matches the required auth-template shape (body + url button, both carrying `"123456"`). This satisfies the task's verification bar (recorded generated payload) without an unsafe live send (confirmed). Per instructions, the build and live API test were not re-run.

### scratchpad.md

`scratchpad.md` exists at the repo root, carries `Last updated: 2026-10-10`, and documents the real app (Next.js 14 App Router, Prisma 5 + Turso libSQL, NextAuth v4, Razorpay). The message-send flow section describes the auth-template OTP guard and the button-building step in the correct order, and the Change log has a dated newest-first entry for this fix. Environment variables are listed by key name only, with no values present (confirmed).

</details>

<details>
<summary>Files changed</summary>

- `src/app/api/messages/send/route.ts` — early auth-template OTP 400 guard; append url button component for `category === "authentication"` (+21 lines).
- `scratchpad.md` — new project technical reference incl. message-send flow and dated change-log entry.
- `.agents/tasks/plan.md` — implementation plan and verification evidence (task artifact).

Full diff: `git diff HEAD~1`.

</details>
