# Structure-driven named-parameter template send fix

The diff replaces the index-based named-parameter mapping, the `niqen_invite`/`"rsvp"` button hardcode, and the dummy Unsplash/PDF header fallbacks in `sendTemplateMessage` with a general, structure-driven path. A new pure module (`src/lib/template-params.ts`) derives the body parameter model from `template.body` (named / numbered / none, de-duplicated first-occurrence order), resolves either the positional `variables` array or the new named `templateParams` map to one canonical shape, and detects dynamic URL buttons. A pure pre-charge gate validates body/header/button before any credit is deducted or row is created. The public route gains a `templateParams` named-map form; the session route is untouched. Docs and scratchpad are updated, and the live `niqen_invite` structure (8 named body params, IMAGE header, dynamic `{{1}}` URL button) is captured in evidence.

Watch for: nothing blocking. One cosmetic nit — the scratchpad `Last updated` date (`2026-10-13`) is older than the preexisting newest change-log entry (`2026-10-19 (d)`) (confirmed). It does not affect code behavior.

**Verdict**: APPROVED

## High-level view

The body-shape derivation is now single-sourced in `parseTemplateBody`, which scans the body once with a whitespace-tolerant regex, de-duplicates named placeholders to first-occurrence order, and classifies named vs numbered vs none. `resolveBodyParams` maps both the positional and named-map inputs onto that model and emits deterministic, declared-order entries — the index-vs-name drift that caused `#132000`/`#100` is structurally impossible because named entries are built from the de-duplicated `names` list, never from a positional scan.

The pre-charge gate is genuinely pure: body resolution, media-header presence, and dynamic-button presence are all string/presence tests with no DB write or network, and they run after the auth-OTP guard and before the credit check and `message.create`. A validation 400 therefore cannot deduct a credit or orphan a row.

Numbered templates take a byte-identical path (`{ type: "text", text: v }`, no `parameter_name`), and the authentication copy-code `#131008` button plus the early missing-OTP guard are preserved verbatim, independent of the resolved body kind. The session route `/api/messages/send` has no diff and keeps its 402→400 remap; both routes still call the one shared helper.

The public API accepts `templateParams` as an explicit object with a zod refine rejecting both forms together; the named/numbered contract and the deterministic order are documented in `/docs` with a `niqen_invite` curl, and the null-`deliveredAt` webhook issue is recorded as a separate concern.

<details>
<summary>Issues (1)</summary>

1. **Scratchpad date regression (cosmetic)** — `Last updated: 2026-10-13` is older than the newest existing change-log entry (`2026-10-19 (d)`). Non-blocking; optionally bump the header date so it is not earlier than the latest logged change.

</details>

<details>
<summary>Details</summary>

### Named body: declared names, ordered and de-duplicated (gate a)

`parseTemplateBody` collects every `{{token}}` left-to-right, then for a named body keeps the first occurrence of each distinct name in a `Set`-guarded walk, producing `names` in declared order with duplicates dropped. `resolveBodyParams` emits `entries` strictly from that `names` list — in the named-map form by pulling `namedMap[n]` for each declared `n` (request key order irrelevant), and in the positional form by zipping `names[i] → variables[i]` after checking `variables.length === names.length`. The body builder in `send-template.ts` then maps each entry to `{ type: "text", parameter_name: e.name, text: e.value }`. This matches the evidence's generated payload for the live 8-param `niqen_invite` (`event, guest_name, event_name, event_date, venue_name, allowed_guests, pass_url, card_url`): every `parameter_name` is a member of the declared set, the set is complete, and there are no extras. Because the names come from a de-duplicated model rather than a positional `namedMatches[idx]` scan, the old name drift that produced `#132000`/`#100` cannot recur (confirmed).

### Removal of the index map, niqen_invite/"rsvp" hardcode, and dummy image (gate b)

The old `vars.map((v, idx) => ({ parameter_name: namedMatches[idx] || "param_"+..., text: v }))` branch, the `template.name === "niqen_invite" || template.buttons.includes("{{")` branch pushing `{ text: "rsvp" }`, the `else if (headerType === "image")` Unsplash fallback, and the `if (!docUrl && headerType === "document")` dummy-PDF line are all gone from the diff (confirmed by the `-` hunks). The replacement is driven only by `template.body`, `template.headerType`, and `template.buttons` via the pure helpers — no name match remains anywhere in the send path.

### Header emitted only when declared, no dummy (gate c)

Header construction now gates on `isMediaHeaderType` (`image`/`video`/`document`) AND a resolved `docUrl`; a text/none header emits nothing, and no fallback link is ever injected. The pre-charge gate separately 400s a media header with no caller-supplied source (`mediaUrl`/`documentUrl`/base64; `mediaId` deliberately excluded since it is never read in construction, so the 400 message stays accurate). If a media header is declared but the source fails to resolve post-charge (e.g. the base64→MediaStore insert throws), the code sets `finalStatus = "failed"` and routes into the existing refund path rather than sending a header-less payload — the credit math stays symmetric. The single MediaStore write remains post-charge, so the pure gate cannot orphan a media row (confirmed).

### Dynamic URL button only (gate d)

`buttonUrlIsDynamic` returns true only when a `URL`-type button's `url` contains `{{`; static buttons and null/garbage JSON return false and emit no component. The send path emits the generic dynamic button solely from `buttonParam || buttonUrlParam`, and the pre-charge gate 400s a dynamic button with no such value — replacing the literal `"rsvp"`. For the live `niqen_invite` (dynamic `{{1}}` button, MARKETING), a missing `buttonParam` now yields a pre-credit 400 instead of a bogus value (confirmed against evidence §1).

### Public API: both forms, pre-credit 400 (gate e)

The route schema adds `templateParams: z.record(z.string(), z.string())` and a `.refine` rejecting a request that carries both a non-empty `variables` and a non-empty `templateParams` (400 before auth-independent processing). The route passes `namedParams: templateParams` through to the shared helper, where `resolveBodyParams` enforces the name/count contract and the gate returns `code: 400` surfaced verbatim by the public route. The disambiguation (named-map iff `templateParams` present and non-empty) is documented. The resolver also defensively rejects both forms, so the contract holds even if a caller reaches the helper directly (confirmed).

### Numbered non-regression (gate f)

For a numbered model, `resolveBodyParams` returns `{ kind: "numbered", values: variables }` and the builder emits `{ type: "text", text: v }` with no `parameter_name`, guarded by `values.length > 0` — byte-identical to the prior `vars.map(v => ({ type:"text", text:v }))` branch. A named map against a numbered template is rejected with a 400. `countVariables` now delegates to `parseTemplateBody`, keeping the numbered count single-sourced; the mirrored unit tests assert agreement. No header or generic button component is emitted for `otp_1`/`migration_alert_v2` (text body, no media header, non-dynamic/auth button), so the positional payload is unchanged (confirmed via evidence §4 static trace and the diff).

### Auth, credit, and superadmin preserved (gate g)

The early `category === "authentication" && !variables?.[0]` OTP guard is unchanged and still returns before the gate and before any credit/row. The copy-code `sub_type:"url", index:"0"` button is emitted from `variables[0]` independent of `resolvedBody.kind`, and auth templates are explicitly exempted from the generic dynamic-button 400. Credit deduct-on-send / refund-on-failure and the `!isSuperAdmin` exemption are untouched; the pure gate returns before any deduction so a validation 400 never touches credits (confirmed).

### Session route and single path (gates h, i)

`src/app/api/messages/send/route.ts` has no diff (confirmed via `git diff --stat`). It still passes only positional `variables`, never sets `namedParams`, and both routes call the one `sendTemplateMessage`. No second send path was introduced.

### Secret hygiene and docs (gates j, k)

The only payload log is the preexisting `console.log("[Meta] Sending message:", ...)` of `metaPayload`; the `Authorization: Bearer` header is never logged, and no new credential logging was added. Evidence confirms the Meta token was read from `.env` and never printed. `/docs` documents the positional and named-map forms, the deterministic first-occurrence order, the pre-charge 400, `variableCount` (numbered-only, 0 for named) vs `namedParams`, a `niqen_invite` named-map curl with placeholder values, and a separate note that null `deliveredAt` is a webhook/`META_APP_SECRET` concern. `scratchpad.md` gains a dated change-log entry and an updated send-path description (confirmed).

### Verification evidence

Build/lint/test results are recorded in evidence.md (`npm run build` exit 0, lint clean, 21/21 unit assertions). The ground-truth Graph `v19.0` call captured the real `niqen_invite` structure; the derivation reads the live body so the 8-vs-6 param difference is handled automatically. Per instructions I did not re-run the suites; the evidence is present and specific, leaving no articulable doubt requiring a spot-check.

</details>

<details>
<summary>File map</summary>

- `src/lib/template-params.ts` (new) — pure `parseTemplateBody`, `namedParams`, `resolveBodyParams`, `buttonUrlIsDynamic`.
- `src/lib/send-template.ts` — structure-driven body/header/button build; pure pre-charge gate; removed index map, niqen_invite/"rsvp", dummy image/PDF; added `namedParams` input.
- `src/lib/template-format.ts` — `countVariables` delegates to `parseTemplateBody`; re-exports `namedParams`.
- `src/app/api/v1/messages/route.ts` — accepts `templateParams`; refine rejecting both forms; passes `namedParams` through.
- `src/app/api/v1/templates/route.ts` — additive `namedParams: string[]` field.
- `src/app/docs/page.tsx` — named/positional contract, deterministic order, pre-charge 400, `variableCount`/`namedParams`, niqen_invite curl, delivery-webhook note.
- `scripts/test-template-params.mjs` (new) — mirrored pure-function unit tests.
- `scratchpad.md` — dated change-log entry + send-path description.
- `src/app/api/messages/send/route.ts` — unchanged (verified no diff).

Full diff: `git diff main` in the repo root.

</details>
