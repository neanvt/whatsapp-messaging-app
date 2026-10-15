# Design review — Dashboard Send page: NAMED params + MEDIA header + DYNAMIC URL button

Reviewed design: `.agents/tasks/send-named-media-button/send-named-media-design.md`
Against requirements: `.agents/tasks/send-named-media-button/send-named-media-requirements.md`
Review date: 2025-02-16
Reviewer posture: fresh read, every load-bearing claim re-verified against source.

## Verdict

CHANGES_REQUESTED — 2 MEDIUM, 4 NIT. (Mechanical: MEDIUM/HIGH count > 0.)

The design is largely sound and the core/route/lib claims hold up under source inspection.
The two MEDIUMs are concrete correctness/spec gaps that an implementer could get wrong
without a stated rule: (1) a whitespace-tolerant-regex mismatch between the classifier
(`parseTemplateBody`) and the design's own `numberedList` scan that silently diverges for
`{{ 1 }}`-style bodies and breaks the named-param label/match path for `{{ name }}` bodies,
and (2) an under-specified handling of the `category` field type and the auth-template
classification claim that is stated as "typically" rather than pinned to a rule.

---

## Findings

### 1. MEDIUM — Whitespace-tolerant classifier vs. non-tolerant `numberedList`/named scan diverge

**Where:** Design "Form state → Numbered" (`numberedList` built with
`/\{\{(\d+)\}\}/g`) and the whole derivation that trusts `parseTemplateBody`'s
classification.

**Problem:** `parseTemplateBody` (verified in `src/lib/template-params.ts`) classifies with
a **whitespace-tolerant** regex: `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g`. It matches `{{ 1 }}`,
`{{ guest_name }}`, etc. The design's `numberedList` uses a **non-tolerant**
`/\{\{(\d+)\}\}/g` (matching today's `extractVariables`). For a body like `{{ 1 }}`:

- `parseTemplateBody` → `{ kind: "numbered", count: 1 }`.
- `numberedList` regex → `[]` (no match on the spaced token).
- Result: zero numbered inputs render, `base.variables = []` (length 0), the send-core gate
  (`resolveBodyParams`) requires `count === 1` → **400 for a template the user cannot fill
  from the UI.**

For a **named** body with spaced tokens like `{{ guest_name }}`, the named path is driven by
`paramModel.names` (tolerant, correct), but the **preview** calls `resolveBodyPreview` which
uses the tolerant regex and the `namedValues` record keyed by `guest_name` — that part is
fine. The break is specifically the numbered index list.

This is strictly today's behavior for the numbered-only path (today's `extractVariables` is
also non-tolerant), so it is arguably "no regression" — but the design newly makes
`parseTemplateBody` the authority on classification while keeping a *different* regex for the
index list, creating a classifier/index split that did not exist before and that the design
explicitly claims "agree" ("the gate's own numbered check compares against `model.count`,
which equals the distinct-token count — they agree"). They do **not** agree for
whitespace-padded numeric tokens.

**Concrete fix:** Derive `numberedList` from the **same tolerant scan**, filtered to numeric
tokens, so it can never diverge from `parseTemplateBody`'s count:

```ts
const numberedList: number[] =
  selectedTemplate && paramModel.kind === "numbered"
    ? [
        ...new Set(
          [...selectedTemplate.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) =>
            Number(m[1]),
          ),
        ),
      ].sort((a, b) => a - b)
    : [];
```

(Note `\s*` added around `(\d+)`.) Then `numberedList.length` equals `paramModel.count` for
all numeric bodies, canonical or not, spaced or not — and the design's own stated invariant
("they agree") actually holds. State explicitly that the scan is whitespace-tolerant to match
the classifier.

---

### 2. MEDIUM — Auth-template classification stated as "typically numbered", not pinned; `category` typing of `kind` interaction under-specified

**Where:** Design "Request body construction → Auth templates" ("`paramModel.kind` for an
auth template is **typically** `numbered` …") and "Edge cases → Auth template".

**Problem:** The behavior for authentication templates depends on `paramModel.kind` being
`numbered` so the OTP flows through the `variables[0]` branch. The design hedges with
"typically", which leaves the implementer without a rule for an auth template whose body is
**named** or **none**:

- The send core guards `template.category === "authentication" && !variables?.[0]` **before**
  the body gate (verified in `send-template.ts`). If an auth template classifies as `named`,
  the client would build `namedParams` and send **no** `variables`, so `variables?.[0]` is
  undefined → core returns 400 "OTP code variable required…" even though the user filled the
  named inputs. If it classifies as `none`, same 400.
- FR1.5/AC11 require auth templates to "behave as today: OTP is the first variable." Today the
  page always renders numbered inputs and always sends `variables`, so an auth template today
  sends `variables[0]` regardless of body shape. The new structure-aware branch can change
  that if `parseTemplateBody` returns `named`/`none` for an auth body.

**Concrete fix:** Pin the rule: for `category === "authentication"`, **force the numbered
branch** (render the numbered OTP input and submit `variables`) regardless of
`paramModel.kind`, so `variables[0]` is always populated and the core's auth guard + copy-code
button path is fed exactly as today. For example:

```ts
const effectiveKind =
  selectedTemplate?.category === "authentication" ? "numbered" : paramModel.kind;
```

and drive the form/validation/request-body branches off `effectiveKind` (while still using
`paramModel.names`/`count` where numbered). State this explicitly rather than "typically."

---

### 3. NIT — `selectedTemplate` possibly `undefined` inside the per-recipient loop is not addressed

**Where:** Design "Request body construction" uses `paramModel.kind`, `isMediaHeader`,
`headerKind`, `hasDynamicButton`, `numberedList` inside `handleSend`'s loop. These derive from
`selectedTemplate`, which is `templates.find(...)` and can be `undefined`.

**Problem:** `handleSend` early-returns on empty `formData.templateId` but not on
`selectedTemplate === undefined` (an id with no matching row). All the derived values default
to the `none` branch, so the request would send neither body form — the gate/route then
rejects via the owned+approved template lookup (400). This matches today's loose assumption,
so it is not a regression, but the design asserts strict typing (NFR4) and should note that
the derivations assume `selectedTemplate` is defined (guaranteed in practice because the
`<select>` only offers fetched approved templates).

**Concrete fix:** Add one line to the derivation note: "`selectedTemplate` is guaranteed
defined whenever `formData.templateId` is set because the select options come from the fetched
approved list; the `none`-default fall-through is a defensive no-op." Optionally early-return
in `handleSend` if `!selectedTemplate`.

---

### 4. NIT — `category` field type on the `Template` interface vs. core's `category === "authentication"` check

**Where:** Design "Type surface" keeps `category: string`.

**Problem:** Fine as-is (`string`), but the design's auth-template logic compares
`selectedTemplate?.category === "authentication"`. The current page's interface already types
`category: string` and the route returns it, so this is consistent. Noting only that the
design should keep `category` non-optional (it is always present on the full-row response),
which the snippet does. No change required beyond confirming it stays `string`, not widened to
`string | null`.

**Concrete fix:** None needed; keep `category: string`. Recorded for completeness so the
implementer does not accidentally make it nullable.

---

### 5. NIT — Preview "Header → Media" box prints "Media" for text headers too? Verify AC8 wording

**Where:** Design "Live preview → Media-header indicator (AC8)" claims the existing box
"renders a 'Header → Media' box whenever `headerType && headerType !== 'none'`."

**Problem (verified):** The actual preview block (`send/page.tsx`) renders the header box when
`headerType && headerType !== "none"` and prints **"Text Header"** when
`headerType === "text"`, else **"Media"**. So the box appears for *text* headers too, but
labels them "Text Header", and labels image/video/document as "Media". The design's statement
"That box alone satisfies AC8" is correct for media headers (AC8 only requires indicating a
media header), but the design's parenthetical "(rendered for `headerType !== 'none'`, printing
'Media' for image/video/document)" slightly overstates — it prints "Media" only in the non-text
branch. This is accurate enough but the design should not imply the box is media-only.

**Concrete fix:** Reword to: "the existing header box renders for any non-`none` header and
prints 'Media' for image/video/document (and 'Text Header' for text); the media case satisfies
AC8." No code change.

---

### 6. NIT — Route success response field mismatch note (`metaMessageId`) between session and public routes

**Where:** Design "Route design → Unchanged and explicitly preserved" lists the success shape
`{ id, status: "sent", message: "Message sent successfully" }`.

**Problem (verified correct):** The session route returns exactly that shape (string
`message`), while the public route returns `{ id, status, metaMessageId }`. The design
correctly preserves the session shape and does not conflate them. This is only a NIT to record
that the two routes' success shapes legitimately differ and the design keeps the session one
intact — no action, just confirming no accidental drift toward the public shape.

**Concrete fix:** None. Preserved correctly.

---

## Verified assumptions (checked against source)

- **V1 — Lib is client-importable (A/NFR2).** `src/lib/template-params.ts` has **zero
  imports** and every export (`parseTemplateBody`, `ParamModel`, `resolveBodyParams`,
  `namedParams`, `resolveBodyPreview`, `buttonUrlIsDynamic`) is a pure string/object function.
  No `next/*`, `fs`, `crypto`, `fetch`, Prisma, or `"use server"`. **The design's "directly
  importable on the client, no duplication" claim is TRUE.**

- **V2 — Exports exist and match the names the design imports.** `parseTemplateBody`,
  `resolveBodyPreview`, `buttonUrlIsDynamic` are all exported. The design imports exactly
  these three. TRUE.

- **V3 — `resolveBodyPreview` numbered indexing is `Number(token) - 1`.** Confirmed:
  `const idx = Number(token) - 1; if (idx >= 0 && idx < values.length) value = values[idx];`.
  The design's round-2 fix (token-value-indexed array, `arr[n-1] = variables[n]`) correctly
  matches this. TRUE.

- **V4 — `resolveBodyPreview` accepts `string | string[] | Record<string,string> | null |
  undefined`.** Confirmed by signature. The design's `previewValues` typed `string[] |
  Record<string,string> | null` is assignable. TRUE — no `any`, no union mismatch.

- **V5 — `resolveBodyParams` rejects BOTH forms (AC6).** Confirmed:
  `if (hasNamedMap && hasPositional) return { ok:false, ... }`. The design's "submit exactly
  one body form" is validated server-side as claimed. TRUE.

- **V6 — Send core gate order and predicates (AC2/AC3/AC7).** Confirmed in
  `send-template.ts`: (a) body resolution via `parseTemplateBody`+`resolveBodyParams`;
  (b) media-header presence with `gateHeaderType in {image,video,document}` and
  `hasHeaderMediaSource = documentUrl || mediaUrl || *Base64`; (c) non-auth dynamic button via
  `buttonUrlIsDynamic` + `buttonParam || buttonUrlParam`. All run **before** the credit check
  and message row. The design's client predicates (`isMediaHeader`, `hasDynamicButton`
  excluding auth) mirror these exactly. TRUE.

- **V7 — Core accepts the full forwarded field set.** `SendTemplateInput` includes
  `variables`, `namedParams`, `mediaUrl`, `documentUrl`, `fileName`, `filename`, `buttonParam`,
  `buttonUrlParam`, base64 fields, `isSuperAdmin`. The route's forwarding (design) lands each on
  its typed param. TRUE.

- **V8 — `documentUrl || mediaUrl` both satisfy the gate; core uses `documentUrl || mediaUrl`
  as `docUrl` (AC3).** Confirmed `let docUrl = documentUrl || mediaUrl;`. Document header builds
  `filename: fileName || filename || "receipt.pdf"`. The design's document→`documentUrl`+optional
  `fileName`, image/video→`mediaUrl` mapping is correct. TRUE.

- **V9 — `GET /api/templates` returns the full owner-scoped row, no `select`, no FK include
  (A1, AC-select).** Confirmed `prisma.template.findMany({ where:{ userId }, orderBy })`. Row
  includes `body, headerType, headerContent, footerContent, buttons, category, language,
  status, name, id`. No relation include → no cross-tenant leak. **The design's "no route
  change needed" is TRUE; the task's conditional to widen the select does not apply.**

- **V10 — Session route preserves auth/userId scoping, ownership+status, 402→400, response
  shape, missing-fields 400.** Confirmed in current `route.ts`: `getServerSession`→401; number
  `findFirst({id,userId,verificationStatus:"verified"})`→400; template
  `findFirst({id,userId,status:"approved"})`→400; `code === 402 ? 400`; `{id,status:"sent",
  message}`; `Missing required fields` 400. The design's additive destructure+forward leaves all
  of these intact. TRUE.

- **V11 — `isSuperAdmin` divergence between routes (A4/Finding 9).** Confirmed: session route
  uses `session.user.role === "superadmin"`; public route uses `isSuperAdminUser(owner)`
  (email-driven). The design preserves the session derivation and records the divergence as an
  intentional gotcha. TRUE and correctly flagged.

- **V12 — Numbered request stays byte-identical to today (AC4) for canonical bodies.** The
  design's `variables = numberedList.map(v => csvPerRecipientVars[phone]?.[v] ?? variables[v] ??
  "")` is the exact expression today uses, over the same list for canonical `{{1}}..{{n}}`
  bodies. TRUE for canonical bodies (and for non-canonical numeric bodies, modulo Finding 1's
  whitespace case).

- **V13 — `parseTemplateBody` named order is first-occurrence, de-duplicated.** Confirmed
  (`seen` Set + `names.push`). Matches `resolveBodyParams`' validation order. The design's
  "named order == gate order, single-sourced" is TRUE.

- **V14 — `buttonUrlIsDynamic` is defensive (null/garbage → false, never throws).** Confirmed.
  The design's "null/malformed buttons → no input, safe" is TRUE.

- **V15 — Auth copy-code button fed from `variables[0]`, independent of body kind.** Confirmed:
  core pushes the copy-code button when `category === "authentication" && variables?.[0]`. The
  design's auth-template handling relies on `variables[0]` being set — see Finding 2 for the
  edge where classification is not numbered.

## Unverified / wrong assumptions

- **W1 — "`numberedList` distinct-token count equals `model.count` — they agree" is WRONG for
  whitespace-padded numeric tokens.** See Finding 1. `parseTemplateBody` is whitespace-tolerant;
  the design's `numberedList` regex is not. For `{{ 1 }}` they disagree (`count=1`,
  `numberedList=[]`), producing an unfillable 400. (For bodies with no interior whitespace they
  do agree.) Fixed by Finding 1's tolerant scan.

- **W2 — "`paramModel.kind` for an auth template is typically `numbered`" is UNVERIFIED as a
  guaranteed invariant.** It depends on the specific auth template body. If an auth template
  body is named (`{{code}}`) or none, the design's branch sends `namedParams`/neither and the
  core's pre-body auth guard returns 400. See Finding 2. The design should pin the rule, not
  rely on "typically."

- **W3 — niqen_invite end-to-end send is UNVERIFIED by live Meta call.** The AC2 trace is
  correct-by-source-inspection (V5–V9 confirm gate + payload construction), not an observed live
  send. This matches the design's own "trace, not live send" framing and is the correct posture;
  flagged only so the implementer treats AC2 as a build/typecheck + source-trace gate, not an
  observed-green test (the repo has no test harness — `package.json` has `build`/`lint` only, no
  `test` script, consistent with the design's "Harness reality" note, which I confirmed).

- **W4 — base64/upload path reuse: correctly assumed absent.** The design states no dashboard
  upload mechanism exists to reuse, so only `mediaUrl`/`documentUrl` are sent. The core's base64
  branch exists but the page never populates it. I did not exhaustively search the dashboard for
  an upload component; the design's scope decision (public URL only) is consistent with FR1.3 /
  Out of Scope regardless, so this is non-blocking.

## Scope / regression check

- No new npm dependency, no Prisma migration — consistent with NFR1; the design adds only type
  widening + render + route forwarding. OK.
- Public `POST /api/v1/messages` and `GET /api/v1/templates`, `send-template.ts`,
  `template-params.ts` are untouched by the design's stated edits (changes confined to
  `send/page.tsx` and `messages/send/route.ts`). OK (FR4.2, Out of Scope).
- Credit deduct/refund symmetry, auth `#131008` handling, superadmin exemption, history,
  isolation: all live in the untouched core/route-scoping and are preserved. OK (FR4.3) — subject
  to Finding 2 for the auth-classification edge.

Resolve Findings 1 and 2 (both MEDIUM) and the verdict flips to APPROVED; the NITs are optional
documentation/clarity tweaks.
