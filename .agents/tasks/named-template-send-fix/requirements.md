# Requirements — Named-parameter template send fix

Last updated: 2025-06-12

## Summary

WhatsApp template sends FAIL (`(#132000) Number of parameters does not match the expected number of params`, `(#100) Invalid parameter`) or are accepted-but-not-delivered when a tenant sends a **named-parameter** template (e.g. `niqen_invite`) through the public `POST /api/v1/messages`. Meta's Cloud API requires named-parameter templates to send BODY components as `{ "type": "text", "parameter_name": "<name>", "text": "<value>" }` where the set of `parameter_name`s **exactly** matches the template's declared named variables (none missing, none extra, correct names). Numbered templates use positional `{ "type": "text", "text": "<value>" }`.

The current `src/lib/send-template.ts` builds named parameters by **index position** (`parameter_name: namedMatches[idx]`) against a regex scan of `template.body` that is **not de-duplicated** and **not ordered to Meta's declared order**, and it hardcodes a `template.name === "niqen_invite"` URL button with a literal `"rsvp"` value. These are the reactive patches that keep failing. This task diagnoses the real root cause (named-param shape + name-set matching) and replaces the index-based mapping and the `niqen_invite`/`"rsvp"` hardcode with a correct **general** solution, without forking the single shared send path.

This has been patched twice already. Before implementing, the live symptom MUST be reproduced/confirmed against the actual `niqen_invite` template definition and Meta's `error.error_data.details` captured — the fix is validated against Meta's real error payload, not against assumptions.

### Assumptions (explicitly noted — the design review must confirm or correct)

- A1. The template's canonical **named-parameter order** (the order Meta expects `parameter_name` entries, used for deterministic positional→named mapping) is the **first-occurrence order of distinct `{{name}}` placeholders scanned left-to-right through `template.body`**. This matches how Meta renders body text. If a stored field already carries Meta's declared order, the design should prefer that; otherwise body-scan order is the deterministic contract.
- A2. A template is "named" iff at least one `{{...}}` placeholder in `template.body` is non-numeric (contains a letter/underscore); it is "numbered" iff all placeholders are numeric (`{{1}}`, `{{2}}`...). Mixed named+numbered in one body is treated as named and flagged by the design as an edge case.
- A3. The `Template` row's `body`, `headerType`, `headerContent`, `buttons` columns reflect the template as approved by Meta for this tenant. Named-parameter name derivation is driven by `body` (the only place placeholders live for the body component).
- A4. The public API accepts the named map as a top-level object merged into the request body (not nested) — see FR1 for the exact disambiguation rule — because the existing `Body` zod schema is a flat object. The design chooses the concrete carrier field/shape.
- A5. No schema change is required; everything needed (`body`, `headerType`, `headerContent`, `buttons`, `category`, `language`, `name`) already exists on `Template`.

## Functional Requirements

### FR1 — Public API accepts BOTH positional and named variable forms

`POST /api/v1/messages` MUST accept **either**:

- **Positional (back-compat, unchanged):** `variables: string[]` — ordered values, exactly as today.
- **Named map (new):** a map of `{ "<parameter_name>": "<value>", ... }` whose keys are the template's declared named parameters (e.g. `{ "event": "...", "guest_name": "...", "event_name": "...", "event_date": "...", "venue_name": "...", "allowed_guests": "..." }`).

Rules:

1. FR1.1 The two forms are mutually resolvable to the same internal representation before calling the shared helper, so the helper receives one canonical shape.
2. FR1.2 When the client sends the **positional** form for a **named** template, the platform MUST perform a **deterministic positional→named mapping**: map `variables[i]` to the template's i-th declared named parameter, where declared order is the **first-occurrence order of distinct named placeholders in `template.body`** (A1), **de-duplicated** (a name that appears twice in the body consumes exactly one positional value and is emitted once). This order MUST be documented in `/docs`.
3. FR1.3 When the client sends the **named map** form, each provided key MUST correspond to a declared parameter name; values are emitted in the template's declared de-duplicated order regardless of the key order in the request JSON.
4. FR1.4 For **numbered** templates, positional `variables` continue to map to `{{1}}..{{n}}` positionally and are sent as positional `{ "type":"text","text":"..." }` (no `parameter_name`). The named-map form is not required for numbered templates; if supplied for a numbered template the design defines the behavior (reject with 400 as a mismatch is acceptable).
5. FR1.5 The disambiguation between the two forms (how the route decides a request is "named map" vs "positional") MUST be unambiguous and documented; a request MUST NOT be interpretable as both.

### FR2 — Pre-charge validation against declared named parameters

1. FR2.1 Before deducting any credit, validate the provided variables against the template's declared named parameters:
   - Named map: every required declared name is present; no unknown/extra keys.
   - Positional for a named template: `variables.length` equals the count of distinct declared named parameters.
2. FR2.2 On mismatch (missing name, extra/unknown name, wrong count), return **HTTP 400** with a clear message that echoes Meta-style detail (which names were expected vs provided) **before** any `Message` row is persisted in a charged state and **before** a credit is deducted.
3. FR2.3 The validation MUST NOT leak secrets/tokens and MUST NOT depend on a round-trip to Meta — it is a local pre-flight check derived from `template.body`.

### FR3 — `sendTemplateMessage` builds correct Meta components (general, no hardcode)

1. FR3.1 **BODY (named template):** emit ordered, de-duplicated parameters `{ "type":"text", "parameter_name":"<name>", "text":"<value>" }` in the template's declared order (A1). No index-vs-name drift; the current `parameter_name: namedMatches[idx]` approach MUST be replaced.
2. FR3.2 **BODY (numbered template):** emit positional `{ "type":"text", "text":"<value>" }` with no `parameter_name` (unchanged behavior).
3. FR3.3 **HEADER:** include a header component **only when the template actually has a header** (`headerType` set and not `none`). For a media header (image/video/document) send the correct media param type bound to the provided/resolved media URL. For a **static** header (no variable), do **not** inject a dummy fallback image — remove the `headerType === "image"` fallback to the hardcoded Unsplash URL where the template header is static/non-variable. The design defines exactly when a media URL is required vs when the header carries no runtime parameter.
4. FR3.4 **BUTTON:** include a URL button component **only when the template's button actually has a dynamic URL variable**. Remove the `template.name === "niqen_invite"` hardcode and the literal `"rsvp"` fallback value. A static button (no `{{...}}`) MUST NOT produce a button component. When a dynamic URL button exists, its value comes from the caller-supplied button parameter (`buttonParam`/`buttonUrlParam`), not a literal.
5. FR3.5 The `niqen_invite` name check MUST be fully removed; behavior MUST be driven only by template structure (`body`, `headerType`, `buttons`).

### FR4 — Preserve existing behavior exactly

1. FR4.1 **Authentication copy-code URL button** (prevents `(#131008)`): keep emitting the `sub_type:"url", index:"0"` button carrying the OTP as its parameter for `category === "authentication"`.
2. FR4.2 **Early missing-OTP 400 guard:** keep the pre-record, pre-charge guard that rejects an authentication send when `variables[0]` (OTP) is missing.
3. FR4.3 **Credit lifecycle:** deduct 1 credit on send, refund 1 on failure; superadmin (`isSuperAdminUser` / passed-through `isSuperAdmin`) exempt from both check and deduct/refund. Math stays symmetric.
4. FR4.4 **Numbered templates (`otp_1`, `migration_alert_v2`)** send byte-for-byte identically to today.
5. FR4.5 **Session route `/api/messages/send`** stays observably unchanged for existing callers (including the 402→400 remap). It MUST keep calling the same shared helper — no fork, no second send path.
6. FR4.6 Meta's `error.error_data.details` MUST continue to be surfaced into the stored `Message.errorMessage` (as `"<message>: <details>"` when details present).
7. FR4.7 The shared `src/lib/send-template.ts` remains the single send path for both routes.

### FR5 — Documentation update

1. FR5.1 Update the `/docs` page (`src/app/docs/page.tsx`) `POST /api/v1/messages` section to document the named-variable contract: the named-map form, the positional form, the deterministic positional→named order (A1), the pre-charge 400 on name/count mismatch, and a named-template `curl` example (e.g. `niqen_invite`).
2. FR5.2 Update the `/docs` page `GET /api/v1/templates` section to explain that for named templates the integration should read the declared parameter names (and how `variableCount` relates to named vs numbered templates), so a third-party app knows which names/order to send.
3. FR5.3 Docs MUST NOT include real tokens, keys, phone IDs, or FB credentials — examples use placeholders only.

### FR6 — Separate operational note (document only, DO NOT fix in this task)

1. FR6.1 Record — as a clearly separated note — that `deliveredAt` being null (Insights "Message delivered: 0") is a **distinct** problem from the `#132000` send bug: the status webhook is not receiving delivery updates, most likely because `META_APP_SECRET` is unset on the deploy or the WABA is not subscribed to the webhook. This note is documentation only; no code change for it in this task.

## Non-Functional Requirements

- NFR1 **TypeScript / App Router:** all handlers return `NextResponse`; no `any`-driven payload construction where a typed shape is practical.
- NFR2 **No new runtime dependencies** (prefer zero new deps). Reuse `src/lib/send-template.ts`, `src/lib/whatsapp.ts` (`resolveSendCredentials`), `src/lib/api-auth.ts`, `src/lib/api-key.ts`, `src/lib/template-format.ts`.
- NFR3 **Multi-tenant isolation preserved:** the public send always uses the key-scoped `userId` + the key's bound number (`ctx.number`); no client-supplied number or credentials are ever honored.
- NFR4 **Secret hygiene:** never log tokens, access tokens, API keys, or app secrets. Existing `console.log` of the Meta payload MUST NOT begin logging credentials.
- NFR5 **No schema change expected.** If one is truly unavoidable, it must be an idempotent `@libsql/client` script (NOT `prisma db:push`). (A5 asserts none is needed.)
- NFR6 **Testability:** the named/numbered detection, the de-duplicated declared-order derivation, and the positional→named mapping MUST be factored so they can be unit-tested in isolation (pure functions, no DB/network).

## Acceptance Criteria

1. **AC1 — Root cause captured first.** A reproduction against the real `niqen_invite` definition is performed and Meta's `error.error_data.details` for the `#132000`/`#100` failures is captured and referenced before the fix is finalized. The fix addresses named-parameter shape + name-set matching, not a `niqen_invite` special case.
2. **AC2 — Named map send succeeds.** `POST /api/v1/messages` with `{ recipient, templateName:"niqen_invite", event, guest_name, event_name, event_date, venue_name, allowed_guests }` builds a BODY component of six ordered, de-duplicated `{type:"text", parameter_name, text}` entries matching the template's declared names, and Meta accepts it (no `#132000`/`#100`).
3. **AC3 — Positional back-compat for named template.** `POST /api/v1/messages` with `variables: [...6 values...]` for `niqen_invite` maps each value to the i-th distinct declared named parameter in body-scan order (A1), producing the identical component to AC2.
4. **AC4 — Deterministic documented order.** The positional→named order is first-occurrence, distinct, left-to-right over `template.body`, and this exact rule is written in `/docs`. Given `niqen_invite`'s body, the order is `event, guest_name, event_name, event_date, venue_name, allowed_guests`.
5. **AC5 — Pre-charge 400 on mismatch.** Sending a named template with a missing/extra name or wrong positional count returns HTTP 400 with a message echoing expected-vs-provided names, and **no credit is deducted** and **no charged message row persists** for that request.
6. **AC6 — Numbered templates unchanged.** `otp_1` and `migration_alert_v2` produce positional BODY params with **no** `parameter_name`, byte-for-byte identical to current output.
7. **AC7 — Header correctness.** A template with no header produces no header component; a static (non-variable) header never injects the hardcoded Unsplash fallback image; a media header uses the correct param type (`image`/`video`/`document`) with the resolved URL.
8. **AC8 — Button correctness.** A template whose button has no `{{...}}` variable produces no button component; the `template.name === "niqen_invite"` check and the literal `"rsvp"` value are removed; a dynamic URL button is populated only from caller-supplied `buttonParam`/`buttonUrlParam`.
9. **AC9 — Auth templates intact.** Authentication templates still emit the copy-code URL button with the OTP and still 400 early when the OTP (`variables[0]`) is missing, with no message row/credit side effects.
10. **AC10 — Credit math symmetric.** Non-superadmin: 1 credit deducted on success, 1 refunded on failure; superadmin: never charged/refunded. Verified for both success and failure paths.
11. **AC11 — Single send path preserved.** Both `/api/v1/messages` and `/api/messages/send` call the same `sendTemplateMessage`; the session route keeps its 402→400 remap and is observably unchanged for existing callers.
12. **AC12 — Meta error surfaced.** On a Meta failure, `Message.errorMessage` contains Meta's `message` plus `error_data.details` when present.
13. **AC13 — Docs updated.** The `/docs` `POST /api/v1/messages` and `GET /api/v1/templates` sections document the named-variable contract, the deterministic order, and the pre-charge mismatch 400, using placeholder credentials only.
14. **AC14 — Operational note recorded, not fixed.** The `deliveredAt`-null/webhook (`META_APP_SECRET`/WABA subscription) issue is documented as a separate concern and intentionally not changed in this task.
15. **AC15 — Build/lint/tests green.** `npm run build` (and lint/typecheck) pass; unit tests for the named/numbered detection and mapping pass. Any temporary repro artifacts are removed. Work is committed on `main` (no push, no worktree).
16. **AC16 — Secret hygiene.** No tokens, access tokens, API keys, phone IDs, or app secrets are logged or written to docs/commits.

## Out of Scope

- Fixing the delivery-webhook / `deliveredAt`-null problem (FR6 documents it only).
- Changing the DB schema or running `prisma db:push`.
- Adding new runtime dependencies.
- Altering authentication/credit/isolation semantics beyond what FR4 preserves.
- Changing the session route's observable contract for existing callers.
- Reworking template creation/approval flows or the Meta template-sync pipeline (beyond removing the leaked `niqen_invite` hardcode in the send path).
- Pushing to a remote or opening a PR.
