# Design — Named-parameter template send fix

Last updated: 2025-06-13
Status: revision 2 — resolves all findings in `design-review.json` (2 HIGH, 4 MEDIUM, 4 NIT). See §14 for the point-by-point response to each finding.

## 1. Overview

WhatsApp template sends fail with `(#132000) Number of parameters does not match the expected number of params` or `(#100) Invalid parameter` whenever a tenant sends a **named-parameter** template (e.g. `niqen_invite`) through `POST /api/v1/messages`. Meta's Cloud API treats named-parameter and numbered templates as two distinct wire shapes:

- **Named** body components: `{ "type": "text", "parameter_name": "<name>", "text": "<value>" }`, and the SET of `parameter_name`s must exactly equal the template's declared named variables — none missing, none extra, names spelled exactly as declared. Order of the array does not strictly matter to Meta for named params, but we emit a deterministic order anyway so the payload is stable and testable.
- **Numbered** body components: positional `{ "type": "text", "text": "<value>" }` with no `parameter_name`, in `{{1}}..{{n}}` order.

The root cause in `src/lib/send-template.ts` is threefold:

1. The named-parameter array is built by **index position** — `parameter_name: namedMatches[idx] || "param_" + (idx+1)` — against `namedMatches`, a **non-de-duplicated** regex scan of `template.body`. A body that repeats a placeholder (e.g. `{{guest_name}}` twice) shifts every subsequent name, so the emitted `parameter_name` set no longer matches Meta's declared set → `#132000`/`#100`.
2. A hardcoded `template.name === "niqen_invite"` branch injects a URL button with the literal value `"rsvp"`. This is a leaked special-case patch; it fires for a static (non-dynamic) button and sends a parameter Meta never asked for.
3. A static `headerType === "image"` template with no runtime media gets a **dummy Unsplash fallback image** injected as a header parameter, which Meta rejects for a template whose header carries no variable.

This design replaces the index-based mapping, the `niqen_invite`/`"rsvp"` hardcode, and the dummy-image fallback with a **general, structure-driven** solution. The single shared send path (`sendTemplateMessage`) is preserved — both routes keep calling it, and numbered templates keep producing a byte-for-byte identical payload. No schema change. No new dependencies.

## 2. Technology stack (locked)

- **Runtime / framework:** Next.js App Router route handlers (existing), TypeScript, Node runtime.
- **DB access:** Prisma (`@prisma/client`) + `@libsql/client` for the existing MediaStore raw insert. No new ORM, no `prisma db:push`.
- **Validation:** `zod` (already used by the public route `Body` schema).
- **HTTP to Meta:** native `fetch` (unchanged).
- **No new runtime dependencies.** All logic reuses `src/lib/send-template.ts`, `src/lib/whatsapp.ts`, `src/lib/api-auth.ts`, `src/lib/api-key.ts`, `src/lib/template-format.ts`.

## 3. Files to create / modify

| File | Change |
| --- | --- |
| `src/lib/template-params.ts` | **NEW.** Pure, DB/network-free module holding the parameter-model derivation and the positional→named / named-map resolution and validation (NFR6 testability). |
| `src/lib/send-template.ts` | Rewrite the body/header/button component construction to call the pure helpers; add a pre-charge validation gate; delete the `niqen_invite`/`"rsvp"` hardcode and the Unsplash fallback. Add a `namedParams?: Record<string,string>` field to `SendTemplateInput`. |
| `src/app/api/v1/messages/route.ts` | Extend the `Body` zod schema to accept the named-map form; disambiguate named-map vs positional; pass the resolved shape to the helper. Return the pre-charge 400 verbatim. |
| `src/app/api/messages/send/route.ts` | No logic change required (dashboard sends positional `variables`); it continues to pass `variables` through. (Confirmed observably unchanged.) |
| `src/lib/template-format.ts` | Re-export `namedParams(body): string[]` (ordered, de-duplicated declared names) from `template-params.ts` so the templates route and docs share one derivation. Change `countVariables` to **delegate** to `parseTemplateBody` (single source of truth for the numbered count — Finding 4). |
| `src/app/api/v1/templates/route.ts` | Add an additive, non-breaking `namedParams: string[]` field to each template in the `GET /api/v1/templates` response (ordered, de-duplicated declared names; `[]` for numbered/none). `variableCount` is unchanged (numbered-only). (Finding 3.) |
| `src/app/docs/page.tsx` | Document the named-variable contract in §6 (`POST /api/v1/messages`) and the `GET /api/v1/templates` subsection; add a `niqen_invite` named curl example; add the deterministic order rule; document `namedParams` and the meaning of `variableCount` for named vs numbered templates. |
| `scratchpad.md` | Append a dated change-log entry and update the API/send-path description. |

## 4. The parameter model — `src/lib/template-params.ts` (pure functions)

All functions here are pure (string in, value out) so they are unit-testable with no DB or network (NFR6).

### 4.1 Placeholder scan

```
type ParamModel =
  | { kind: "named"; names: string[] }   // ordered, de-duplicated declared names
  | { kind: "numbered"; count: number }  // distinct {{1}}..{{n}} count
  | { kind: "none" };                    // no placeholders in body
```

`parseTemplateBody(body: string | null | undefined): ParamModel`

Algorithm:
1. Scan `body` left-to-right with `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g`, collecting raw tokens in order of appearance. The `\s*` whitespace tolerance (so `{{ guest_name }}` matches) is an **intentional** change from the current `send-template.ts` scan (`/\{\{([a-zA-Z0-9_]+)\}\}/g`, no `\s*`) and makes this scan consistent with `countVariables` (which already uses `\s*`) — Finding 4.
2. If no tokens → `{ kind: "none" }`.
3. Classify: a token is **numeric** if `/^\d+$/.test(token)`. A template is **named** iff ≥1 token is non-numeric (A2); otherwise **numbered**.
4. **Named** branch: walk the tokens left-to-right, keep **first occurrence** of each distinct name, drop later duplicates (A1 de-dup). Result `names` is the declared order. (A mixed named+numbered body is treated as named per A2; the numeric tokens become names like `"1"` — this is an edge case flagged in §9; in practice Meta does not approve mixed bodies, so we classify-and-proceed rather than special-case.)
5. **Numbered** branch: `count` = the size of the **Set** of numeric tokens collected by the **single unified scan in step 1** (deduplicated). It is NOT computed by a second, separate regex. We do **not** assume contiguity.

**Single source of truth for the numbered count (Finding 4).** To guarantee `parseTemplateBody` and the still-live `countVariables` can never drift on numbered bodies, `countVariables(body)` is refactored to delegate: `const m = parseTemplateBody(body); return m.kind === "numbered" ? m.count : 0;`. (For a named or none body it returns 0, matching today's numeric-only behavior.) A unit test also asserts the two agree for representative numbered bodies as a belt-and-suspenders check.

This replaces the inline `namedMatches` scan + `isNamed` check in `send-template.ts`.

### 4.2 Resolve to a canonical ordered value list

The helper must receive ONE canonical shape. We resolve both public-API forms to an **ordered `string[]`** that lines up 1:1 with `model.names` (named) or `{{1}}..{{n}}` (numbered). We keep the names alongside so the body builder can attach `parameter_name`.

```
type ResolvedBody =
  | { kind: "named"; entries: Array<{ name: string; value: string }> }
  | { kind: "numbered"; values: string[] }
  | { kind: "none" };

resolveBodyParams(
  model: ParamModel,
  input: { variables?: string[]; namedParams?: Record<string, string>; name: string }
): { ok: true; resolved: ResolvedBody } | { ok: false; error: string }
```

The `name` field (the template name) is passed in so the resolver can interpolate `"Template '<name>' …"` into its error strings without reaching for DB/network — the §5.1 caller supplies `name: template.name` (Finding 9). The function stays pure (all inputs are plain values).

Rules (this is the pre-charge validation core, FR2):

- **`model.kind === "none"`** → `{ kind: "none" }` regardless of input (no body params emitted). If the caller supplied values for a no-param template, ignore them (back-compat: current code emits a body component only when `vars.length > 0`; with `none` there are no declared params so we emit nothing).
- **`model.kind === "numbered"`**:
  - If `namedParams` is provided (non-empty) → **error**: `"Template '<name>' uses numbered placeholders; send a positional 'variables' array of N values, not a named map."` (FR1.4 — reject with 400).
  - Else require `variables.length === model.count`; on mismatch → error `"Template '<name>' expects <count> variable(s); received <variables.length>."` Otherwise `{ kind: "numbered", values: variables }`.
- **`model.kind === "named"`**:
  - **Named-map form** (`namedParams` present and non-empty): every declared name in `model.names` MUST be a key in `namedParams`; `namedParams` MUST NOT contain keys outside `model.names`. On missing or unknown → error listing expected vs provided (FR2.2). Emit entries in `model.names` order, pulling values from the map (order of keys in the request JSON is irrelevant — FR1.3).
  - **Positional form** (`variables` present, no `namedParams`): require `variables.length === model.names.length` (FR2.1); on mismatch → error `"Template '<name>' expects <N> named parameter(s) in order [<names>]; received <variables.length> positional value(s)."` Emit entries `{ name: model.names[i], value: variables[i] }` (A1 deterministic positional→named — FR1.2). **Positional count is validated against the DISTINCT declared name count (`model.names.length`), never the raw placeholder-occurrence count** (Finding 5): `model.names` is already de-duplicated, so a name that appears twice in the body still consumes exactly one positional value and is emitted once per distinct name. A caller never passes a value "per occurrence."
  - If **both** `variables` and `namedParams` are present → error `"Provide either 'variables' (positional) or the named parameter map, not both."` (FR1.5 — a request must not be interpretable as both.)
  - If **neither** is present for a named template → error `"Template '<name>' requires <N> named parameter(s): [<names>]."`

The error strings deliberately echo expected-vs-provided names/counts so the 400 body is Meta-style and actionable, without any Meta round-trip (FR2.3) and without secrets (NFR4).

### 4.3 Why this fixes the root cause

The old code did `vars.map((v, idx) => ({ parameter_name: namedMatches[idx], text: v }))`. `namedMatches` was NOT de-duplicated, so for a body where any name repeats, `namedMatches[idx]` drifts off the intended name and the emitted `parameter_name` set stops matching Meta's declared set → `#132000`/`#100`. The new model de-duplicates to `names` first, then maps by that stable declared order, and (in named-map form) pulls strictly by key — so the emitted set is always exactly `model.names`.

## 5. Component construction in `sendTemplateMessage`

`SendTemplateInput` gains one optional field:

```
namedParams?: Record<string, string>; // named-map form from the public API; undefined for session route
```

Build order (header, body, buttons) stays the same so numbered output is byte-identical.

### 5.1 Pre-charge gate (before credit check, before message row)

**Exact insertion point (code anchors — Finding 7).** The gate is inserted between these two existing statements in `sendTemplateMessage`:

- *After* the auth-OTP guard return:
  ```
  if (template.category === "authentication" && !variables?.[0]) {
    return { ok: false, code: 400, error: "OTP code variable required for authentication template" };
  }
  ```
- *Before* the credit balance check:
  ```
  if (!isSuperAdmin) {
    const userCredits = await prisma.userCredits.findUnique({ where: { userId } });
    ...
  }
  ```

The gate performs ONLY pure, I/O-free checks (string parsing + presence tests). It never touches the DB or network, so a 400 here cannot leave an orphaned row (Finding 1):

```
// (a) BODY param resolution — pure (string in, value out)
const model = parseTemplateBody(template.body);
const bodyResolution = resolveBodyParams(model, { variables, namedParams, name: template.name });
if (!bodyResolution.ok) {
  return { ok: false, code: 400, error: bodyResolution.error };
}
const resolvedBody = bodyResolution.resolved;

// (b) HEADER presence check — pure (NO upload, NO DB write; Finding 1)
const headerType = (template.headerType || "").toLowerCase();
const isMediaHeader = headerType === "image" || headerType === "video" || headerType === "document";
const hasHeaderMediaSource = !!(documentUrl || mediaUrl || documentBase64 || pdfBase64 || mediaBase64);
if (isMediaHeader && !hasHeaderMediaSource) {
  return {
    ok: false,
    code: 400,
    error: `Template '${template.name}' has a ${headerType} header; provide 'mediaUrl' (or 'documentUrl'/base64) for the header media.`,
  };
}

// (c) BUTTON dynamic-but-missing-value check — pure
const buttonIsDynamic = buttonUrlIsDynamic(template.buttons);
const btnParam = buttonParam || buttonUrlParam;
const isAuth = template.category === "authentication";
if (!isAuth && buttonIsDynamic && !btnParam) {
  return {
    ok: false,
    code: 400,
    error: `Template '${template.name}' has a dynamic URL button; provide 'buttonParam' (the URL suffix/value).`,
  };
}
```

The header presence check (b) uses **presence-only** detection of a media source — it does NOT attempt the base64→MediaStore upload, and `mediaId` is deliberately NOT in the presence list (see §5.3 and Finding 6). The actual base64→MediaStore upload still runs later, inside the Meta-send block, AFTER the credit check and message-row creation; an upload failure there funnels into the existing failed+refund path (Finding 1). The ordering is therefore unambiguous:

```
auth-OTP guard  →  pre-charge gate (pure: body + header-presence + button)  →  credit check  →  message.create  →  deduct credit  →  [Meta-send block: base64 upload if needed → build components → POST to Meta]  →  refund on failure
```

This guarantees AC5: a name/count/header/button mismatch returns 400 with **no** credit deducted, **no** charged message row persisted, and **no** MediaStore insert attempted.

**Note on authentication templates (Finding 2).**
- The auth copy-code button (§5.4 step 1) is emitted from `variables[0]` **independently of `resolvedBody.kind`** — including `kind: "none"` for auth templates whose body carries no `{{n}}` placeholder (the code reads `variables?.[0]` directly, never `resolvedBody`). So an OTP-only template with an empty body still emits the copy-code button correctly (FR4.1).
- The resolver's numbered branch requires `variables.length === count`; an auth OTP template with one `{{1}}` placeholder is satisfied by `variables=[otp]` (count===1). An auth template whose body has zero placeholders resolves to `kind:"none"`, the body component is omitted, and the OTP guard + copy-code button carry the code. No special-casing needed beyond keeping the OTP guard ahead of the gate.
- **Auth + media-header decision:** the media-header 400 (gate check `b`) applies **uniformly**, including to authentication templates. This product's authentication templates do not use media headers (OTP templates are text-body + copy-code button only), so the uniform 400 cannot regress a real auth send. This is confirmed at implementation time by the §10 ground-truth step, which must verify no tenant authentication template declares a media header before the uniform 400 ships. If one is ever found, the gate would need an auth carve-out — but that case is not expected and is explicitly checked, not assumed.

### 5.2 BODY component

```
if (resolvedBody.kind === "named") {
  components.push({
    type: "body",
    parameters: resolvedBody.entries.map(e => ({
      type: "text",
      parameter_name: e.name,
      text: e.value,
    })),
  });
} else if (resolvedBody.kind === "numbered" && resolvedBody.values.length > 0) {
  components.push({
    type: "body",
    parameters: resolvedBody.values.map(v => ({ type: "text", text: v })),
  });
}
// kind === "none" → no body component (unchanged behavior)
```

The numbered branch is byte-for-byte identical to today's output (`{ type: "text", text: v }`, no `parameter_name`) — FR3.2 / AC6.

### 5.3 HEADER component (FR3.3 / AC7)

Replace the current logic that (a) injects a dummy document URL for `headerType === "document"` and (b) injects a hardcoded Unsplash image when `headerType === "image"` and no `docUrl`.

New rules, driven only by `template.headerType`:

```
const headerType = (template.headerType || "").toLowerCase();
const isMediaHeader = headerType === "image" || headerType === "video" || headerType === "document";
```

- `headerType` is empty / `"none"` / `"text"` → **no header component** emitted. (A `text` header with no `{{}}` is static; Meta needs no runtime parameter. If a text header carries a variable it is an edge case flagged in §9 — current product does not create variable text headers, so we do not emit a text-header param.)
- `headerType` is a media type (`image`/`video`/`document`): a runtime media link is required. The **presence** of a media source is validated in the pre-charge gate (§5.1 check `b`, pure, no I/O). The actual URL **resolution** happens here, inside the Meta-send block (after credit check / message-row creation), from (in order) `documentUrl`, `mediaUrl`, then the base64→MediaStore upload path (unchanged mechanism — this is the ONLY step that writes a MediaStore row, and it runs post-charge). Then:
  - If `docUrl` resolved → emit `{ type: "header", parameters: [{ type: headerType, [headerType]: { link: docUrl, ...(document ? { filename } : {}) } }] }`.
  - If the base64 upload throws / `docUrl` still fails to resolve → this is NOT a validation 400 (we already passed the pre-charge presence gate). It funnels into the existing failed+refund path: set `finalStatus = "failed"`, store an error, refund the credit (NFR / FR4.3). This matches today's error handling for a failed send and keeps credit math symmetric.

**Removed:** the `else if (headerType === "image") { ...Unsplash link... }` block and the `if (!docUrl && headerType === "document") { ...dummy.pdf... }` block are deleted (AC7). The dummy fallbacks never execute now; a media header with no source is caught earlier by the pre-charge presence gate.

**Why presence-gate then post-charge upload (Finding 1).** The base64→MediaStore path does a `createClient(...)` + `INSERT INTO MediaStore` (a DB write). If that ran inside the pre-charge gate, a later validation 400 could orphan a MediaStore row. So the gate only checks that *some* media source string is present (I/O-free); the write happens exactly once, post-charge, where an upload failure is already handled by the failed+refund branch. The gate and the resolver never duplicate the write.

**`mediaId` (Finding 6).** `SendTemplateInput.mediaId` is accepted and forwarded end-to-end today but is **never read** in component construction — it is currently dead input. This design keeps it unused: `mediaId` is NOT added to the gate's `hasHeaderMediaSource` presence check and NOT read in header construction, so a caller who supplies only `mediaId` for a media header still receives the accurate 400 ("provide 'mediaUrl' …"). Adding Meta `id`-based media headers (`{ type, [type]: { id } }`) is out of scope (no scope creep). This is stated so the 400 message stays accurate and the coder does not treat the omission as an oversight.

### 5.4 BUTTON component (FR3.4 / FR3.5 / FR4.1 / AC8 / AC9)

Order of checks:

1. **Authentication copy-code button (unchanged, FR4.1):** if `template.category === "authentication" && variables?.[0]`, push `{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: variables[0] }] }`. This is preserved exactly to avoid `(#131008)`.
2. **Dynamic URL button (general):** else, determine whether the template's button is dynamic by inspecting `template.buttons`. Parse `template.buttons` with `parseJsonColumn` (it is a JSON string per schema). A button is **dynamic** iff a URL-type button's `url` contains `{{`...`}}`. Only then:
   - Take the caller value `const btnParam = buttonParam || buttonUrlParam;`
   - If `btnParam` is present → push the `sub_type:"url", index:"0"` button with `{ type: "text", text: btnParam }`.
   - If the button is dynamic but `btnParam` is absent → pre-charge **400**: `"Template '<name>' has a dynamic URL button; provide 'buttonParam' (the URL suffix/value)."` (Decision: 400 rather than a literal fallback — the old `"rsvp"` literal was the bug.)
3. **Static button (no `{{}}`):** emit **no** button component. The `template.name === "niqen_invite"` branch and the `"rsvp"` literal are deleted entirely (FR3.5).

If `template.buttons` is null/unparseable, treat as "no dynamic button" (emit nothing). **Precondition (Finding 8):** the emitted component hardcodes `index:"0"`, which assumes the dynamic URL button is the single button at index 0 — unchanged from current behavior. `buttonUrlIsDynamic` returns a plain boolean (does any URL button carry `{{…}}`); it does not resolve a button index. Multi-button index resolution (e.g. a static button at index 0 and a dynamic URL button at index 1) is explicitly out of scope and flagged in §9. For the single-button templates this product uses, `index:"0"` is correct.

Button dynamic-detection is factored into a pure helper `buttonUrlIsDynamic(buttonsJson: string | null): boolean` in `template-params.ts` for unit testing.

### 5.5 Credit lifecycle & single path (FR4.3 / FR4.5 / FR4.7 / AC10 / AC11)

Unchanged: deduct 1 on send, refund 1 on failure, superadmin exempt from both. The pre-charge gate returns before any deduction, so a validation 400 never touches credits. Both routes keep calling `sendTemplateMessage`; the session route keeps its 402→400 remap. No second send path is introduced.

### 5.6 Meta error surfacing (FR4.6 / AC12)

Unchanged: on a non-2xx Meta response, `errorMessage = details ? "<message>: <details>" : "<message>"` and is stored on `Message.errorMessage`.

### 5.7 Secret hygiene (NFR4 / AC16)

The existing `console.log("[Meta] Sending message:", JSON.stringify(metaPayload, ...))` logs only the payload (no token). It stays. The `Authorization: Bearer ${accessToken}` header is never logged. No new logging of credentials is added.

## 6. Public API contract — `src/app/api/v1/messages/route.ts`

### 6.1 Request shape and disambiguation (FR1 / FR1.5)

Decision on the named-map carrier (A4): rather than merging arbitrary top-level keys (which collides with reserved fields like `mediaUrl`, `recipient`, etc.), use a **single explicit object field** `templateParams`:

```
templateParams: z.record(z.string(), z.string()).optional()
```

So the full accepted body for named sends is:

```json
{ "recipient": "...", "templateName": "niqen_invite",
  "templateParams": { "event": "...", "guest_name": "...", "event_name": "...",
                      "event_date": "...", "venue_name": "...", "allowed_guests": "..." } }
```

and positional stays exactly as today:

```json
{ "recipient": "...", "templateName": "niqen_invite", "variables": ["...","...", ...] }
```

**Disambiguation rule (documented, unambiguous):** the request is treated as **named-map** iff `templateParams` is present and non-empty; otherwise it is **positional** using `variables`. A request MUST NOT send both `variables` and `templateParams` — the zod schema adds a `.refine` rejecting that combination with 400 (`"Provide either 'variables' or 'templateParams', not both."`). This makes a request un-interpretable as both forms (FR1.5). Reason for choosing an explicit `templateParams` object over free top-level keys: it is self-describing, cannot collide with reserved fields, and keeps the flat zod schema (A4) intact.

The route passes `namedParams: parsed.data.templateParams` and `variables: parsed.data.variables` through to `sendTemplateMessage`. Final validation (name/count match) happens in the pre-charge gate (§5.1), which centralizes the rule in the single shared path and returns a 400 the route surfaces verbatim.

### 6.2 Error code mapping

The helper's new validation failures use `code: 400`. The public route already surfaces `result.code` verbatim, so a 400 flows out unchanged. The session route's 402→400 remap is untouched (a 400 stays 400).

### 6.3 `GET /api/v1/templates` response + docs contract (FR5.2 / AC13 / Finding 3)

`countVariables(body)` counts only numeric `{{n}}` placeholders, so for a named template like `niqen_invite` it returns **0** — misleading to an integrator unless supplemented. To make the named contract discoverable (FR5.2), the templates route gains ONE additive, non-breaking field:

- **`namedParams: string[]`** — the ordered, de-duplicated declared named parameters (`parseTemplateBody(body).kind === "named" ? names : []`). For numbered or no-placeholder templates it is `[]`. This is the exact list and order an integrator must send (as `templateParams` keys, or as positional `variables` in this order).

`variableCount` is left unchanged (still numbered-only). The route response becomes `{ ...t, buttons, variableCount, namedParams }`.

The `/docs` `GET /api/v1/templates` section (FR5.2) states, in placeholder-only terms:

> `variableCount` is the number of **numbered** (`{{1}}`, `{{2}}`…) placeholders; for a **named-parameter** template it is `0`. Read `namedParams` to get the template's declared parameter names in the exact order to send. Send them either as a `templateParams` object keyed by those names, or as a positional `variables` array in that same order (first-occurrence, left-to-right over the body).

This makes the FR5.2/AC13 doc contract concretely implementable (an integrator never has to guess).

## 7. Static trace — `niqen_invite`

Assume the real `niqen_invite` body (to be confirmed by the ground-truth call in §10) renders as, e.g.:

```
Hi {{guest_name}}, you are invited to {{event_name}} ({{event}}) on {{event_date}} at {{venue_name}}. Guests allowed: {{allowed_guests}}.
```

Note the requirement states the declared order is `event, guest_name, event_name, event_date, venue_name, allowed_guests` (AC4). The order is whatever **first-occurrence** scan of the ACTUAL approved body yields; the §10 call records the real body. For the trace, take the declared order as the requirement's canonical list:

`names = ["event", "guest_name", "event_name", "event_date", "venue_name", "allowed_guests"]` (6 distinct, de-duplicated).

**Named-map send** `templateParams = { event:"E", guest_name:"G", event_name:"N", event_date:"D", venue_name:"V", allowed_guests:"6" }`:

`resolveBodyParams` validates every declared name is a key (yes) and no extra keys (none), then emits in declared order:

```json
{ "type": "body", "parameters": [
  { "type": "text", "parameter_name": "event",          "text": "E" },
  { "type": "text", "parameter_name": "guest_name",     "text": "G" },
  { "type": "text", "parameter_name": "event_name",     "text": "N" },
  { "type": "text", "parameter_name": "event_date",     "text": "D" },
  { "type": "text", "parameter_name": "venue_name",     "text": "V" },
  { "type": "text", "parameter_name": "allowed_guests", "text": "6" }
] }
```

**Why Meta accepts it:** every `parameter_name` is a member of the template's declared named set, the set is complete (all six present), there are no extras, and each has a `text` value. Meta matches named params by name, not position, so this satisfies `#132000` (count/param match) and `#100` (valid parameter) — the two errors we are fixing. No header component is emitted unless `niqen_invite` declares a media header (the §10 call confirms its real header format); no button component is emitted unless its button URL is dynamic and `buttonParam` is supplied.

**Positional send** `variables = ["E","G","N","D","V","6"]`: `resolveBodyParams` checks `length === 6 === names.length`, then zips `names[i] → variables[i]`, producing the identical component above (AC3).

## 8. Numbered-template non-regression

For `otp_1` (body `{{1}}`) and `migration_alert_v2` (numbered body), `parseTemplateBody` returns `{ kind: "numbered", count }`. `resolveBodyParams` returns `{ kind: "numbered", values: variables }`, and the body builder emits `{ type: "text", text: v }` with **no** `parameter_name` — byte-for-byte identical to the current `vars.map(v => ({ type:"text", text:v }))` branch (AC6). The authentication copy-code button and OTP guard are preserved exactly (FR4.1/FR4.2/AC9). The session route `/api/messages/send` sends positional `variables` and never sets `templateParams`, so it is observably unchanged (FR4.5/AC11).

## 9. Edge cases

| Case | Behavior |
| --- | --- |
| Body with a repeated named placeholder (`{{x}}` twice) | De-duplicated to one declared name; one value consumed; emitted once (A1). |
| Mixed named + numeric placeholders in one body | Classified as **named** (A2); numeric tokens become string names. Flagged: Meta rarely approves such bodies; we classify-and-send rather than special-case, and the §10 ground-truth call surfaces the real structure. |
| Named map with missing / extra key | Pre-charge 400 echoing expected vs provided names (FR2.2). |
| Positional count ≠ declared count (named or numbered) | Pre-charge 400 with expected count (FR2.1). |
| `templateParams` sent for a numbered template | 400 (FR1.4 reject). |
| Both `variables` and `templateParams` | 400 at the zod `.refine` and again defensively in the resolver (FR1.5). |
| Media-header template with no `mediaUrl`/base64 | Pre-charge 400 (no dummy image) (FR3.3). |
| Dynamic URL button with no `buttonParam` | Pre-charge 400 (no `"rsvp"` literal) (FR3.4). |
| Static button / text header / no header | No component emitted. |
| `template.buttons` null or unparseable | Treated as no dynamic button; emit nothing. |
| Multiple dynamic buttons | Out of current scope; single `index:"0"` button preserved. Flagged for future work. |

## 10. Ground-truth closing section (perform at implementation time)

Before finalizing the fix, make **ONE** real diagnostic Graph API call to capture the actual approved structure of `niqen_invite` (AC1). This is the evidence the fix is validated against — not assumptions.

- **Call:** `GET https://graph.facebook.com/v19.0/{wabaId}/message_templates?name=niqen_invite&fields=name,status,category,language,components`. The Graph API version is pinned to **`v19.0`** — the same version the send path uses (`graph.facebook.com/v19.0/{phoneNumberId}/messages`), so the diagnostic sees the identical `components` shape the sender will see (avoids a v-latest shape surprise — Finding 10).
- **IDs:** `wabaId = 1290990196241997`, `phoneNumberId = 1068572486335513`.
- **Auth:** `Authorization: Bearer $META_ACCESS_TOKEN`, read from `.env` at run time. **Never print, echo, or commit the token.** Reference it by key name only.
- **Record as evidence** (paste into the implementation PR/commit notes or a scratch file that is deleted before commit per AC15): the EXACT returned `components` JSON — specifically (a) the BODY component's ordered named params (`example.body_text_named_params` / the `{{name}}` set), which pins the real declared order for AC4; (b) the HEADER component `format` (NONE / TEXT / IMAGE / VIDEO / DOCUMENT) and whether it declares an example, which decides §5.3; (c) the BUTTONS component — whether any URL button's `url` is static or contains a `{{1}}` variable, which decides §5.4.

Use the recorded order as the authoritative `names` list; if it differs from the assumed `event, guest_name, event_name, event_date, venue_name, allowed_guests`, update the `/docs` example and the trace in §7 to match the recorded order (the derivation code does not change — it reads the live body).

**Auth + media-header check (Finding 2).** As part of this step, also fetch the tenant's authentication templates (`GET .../v19.0/{wabaId}/message_templates?fields=name,category,components`) and confirm none declares a media (`IMAGE`/`VIDEO`/`DOCUMENT`) HEADER format. This validates the §5.1 decision to apply the media-header 400 uniformly (including to auth). If any auth template unexpectedly carries a media header, add an auth carve-out to gate check `b` before shipping; otherwise the uniform 400 is confirmed safe.

- **Optional live proof:** ONE live test send of `niqen_invite` to `917088970099` with the corrected payload (named-map form, all six params) to confirm Meta returns `200` with a `wamid` and NO `#132000`/`#100`. Record only the response status + `wamid` as evidence (never the token). Remove any temp script before commit.

Example (illustrative; run with the real env var, do not print it):

```bash
curl -s -G "https://graph.facebook.com/v19.0/1290990196241997/message_templates" \
  --data-urlencode "name=niqen_invite" \
  --data-urlencode "fields=name,status,category,language,components" \
  -H "Authorization: Bearer $META_ACCESS_TOKEN"
```

## 11. Separate operational note — null `deliveredAt` / webhook subscription (OUT OF SCOPE, FR6 / AC14)

**Do not change in this task.** The Surshyam/Insights symptom "Message delivered: 0" / `Message.deliveredAt` staying null is a **distinct** problem from the `#132000` send bug. A send can be accepted by Meta (200 + `wamid`, `status="sent"`) yet never receive a delivery status callback, so `deliveredAt` is never written.

Root cause is on the webhook path, not the send path: `/api/webhooks/whatsapp` verifies `X-Hub-Signature-256` against the owning app's secret. If `META_APP_SECRET` is unset on the deploy (Model A) or the tenant's Model-B secret is missing/wrong, every signed status POST fails signature verification and returns 401, so no status update is applied. Equally, if the WABA is not **subscribed** to the app's webhook fields (`messages`), Meta never POSTs statuses at all. Remediation (separate task): confirm `META_APP_SECRET` is set on the deploy, confirm the WABA webhook subscription includes `messages`, and re-test. This note is documentation only — no code change here.

## 12. Testing strategy

- **Unit (pure, no DB/network — NFR6):** `parseTemplateBody` (named / numbered / none / repeated-name de-dup / mixed / `\s*`-tolerant tokens like `{{ guest_name }}`), `resolveBodyParams` (named-map happy path, missing key, extra key, positional happy path, wrong count, both-forms error, numbered reject-map), `buttonUrlIsDynamic` (static vs `{{}}` URL, null/garbage), and a `countVariables ≡ parseTemplateBody` agreement test on numbered bodies (Finding 4). Build the expected Meta body component for the `niqen_invite` trace (§7) and assert exact shape.
- **Integration (route-level, mock Meta `fetch`):** AC2 named-map 200, AC3 positional 200 producing identical component, AC5 mismatch 400 with no credit deduction / no charged row, AC6 numbered byte-identical, AC9 auth OTP button + missing-OTP 400, AC10 credit symmetry on success and failure, AC11 both routes hit the same helper.
- **Ground-truth (manual, §10):** real `niqen_invite` structure captured; optional live send proving `#132000` resolved.
- **Gate (AC15):** `npm run build` + lint/typecheck green; temp repro artifacts removed; commit on `main` (no push).

## 13. Requirements traceability

FR1→§6/§4.2; FR2→§5.1/§4.2; FR3→§5.2–5.4; FR4→§5.5/§5.6/§8; FR5→§3/§6.3 (docs edits, deferred to implementation) ; FR6→§11. NFR1–NFR6→§2/§4/§5.7/§12. AC1→§10; AC2–AC4→§7; AC5→§5.1; AC6→§8; AC7→§5.3; AC8→§5.4; AC9→§5.1/§5.4/§8; AC10→§5.5; AC11→§6.2/§8; AC12→§5.6; AC13→§6.3; AC14→§11; AC15→§12; AC16→§5.7/§10.

## 14. Response to design review findings (revision 2)

All 10 findings from `design-review.json` (verdict CHANGES_REQUESTED) are **addressed**. None backlogged, none ignored. Each resolution stays within the original requirements (no scope creep; no schema change; single send path preserved).

| # | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | HIGH | Header media validation can't be a pure pre-charge gate — base64→MediaStore has DB-write side effects; upload ordering vs credit check undefined. | §5.1 gate check `b` is **presence-only** (`documentUrl || mediaUrl || documentBase64 || pdfBase64 || mediaBase64`), no upload, no DB write, 400 when a media header has no source. The actual base64→MediaStore upload stays **post-charge** inside the Meta-send block (§5.3), with upload failure routed to the existing failed+refund path. Explicit end-to-end ordering written in §5.1. |
| 2 | HIGH | Auth-template interaction under-specified: (a) copy-code button independence from `resolvedBody.kind`; (b) auth + media-header would hit the new 400. | §5.1 now states the copy-code button fires from `variables[0]` **independently of `resolvedBody.kind` (including `none`)**, and that the media-header 400 applies **uniformly** to auth; §10 ground-truth adds an explicit check that no auth template declares a media header before shipping the uniform 400. |
| 3 | MED | `variableCount`→0 for named templates; docs contract (FR5.2/AC13) never specified. | New §6.3: add additive, non-breaking **`namedParams: string[]`** to the `GET /api/v1/templates` response; §3 table updated; exact docs wording for `variableCount` (numbered-only, 0 for named) vs `namedParams` specified. |
| 4 | MED | New scan regex differs from `countVariables`; numbered-count agreement asserted but not guaranteed. | §4.1: `\s*` tolerance called out as intentional; numbered `count` = Set size of numeric tokens from the **single unified scan**; `countVariables` refactored to **delegate to `parseTemplateBody`** (single source of truth) plus an agreement unit test (§12). |
| 5 | MED | Duplicate-name positional-consumption rule ambiguous. | §4.2: positional count is validated against the **DISTINCT** declared-name count (`model.names.length`), never raw occurrences; a repeated name consumes one value and is emitted once. |
| 6 | MED | `mediaId` accepted end-to-end but never read; §5.3 omits it, so a `mediaId`-only caller hits the new 400 silently. | §5.3: states `mediaId` is **currently dead input and remains unused** — NOT counted in the gate presence check, so the 400 message stays accurate; Meta id-based headers are out of scope. |
| 7 | NIT | Gate insertion point not pinned to concrete anchors. | §5.1 now quotes both anchors (after the auth-OTP guard return, before the `if (!isSuperAdmin) { …userCredits… }` credit check). |
| 8 | NIT | `buttonUrlIsDynamic` is boolean but component hardcodes `index:"0"`. | §5.4: single-dynamic-URL-button-at-index-0 **precondition** stated explicitly (unchanged from today); multi-button index resolution out of scope. |
| 9 | NIT | Error strings interpolate `<name>` but resolver signature has no name. | §4.2: `resolveBodyParams` input gains a `name: string` field; §5.1 caller passes `name: template.name`. |
| 10 | NIT | Graph API version explicit in curl but omitted in §10 prose. | §10 prose now pins **`v19.0`**, matching the send path, to avoid a v-latest components-shape surprise. |
