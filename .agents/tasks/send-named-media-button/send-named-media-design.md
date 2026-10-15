# Design — Dashboard Send page: NAMED params + MEDIA header + DYNAMIC URL button

Last updated: 2025-02-16
Status: Revised (design review rounds 1 and 2 addressed — see "Review responses" at end)
Requirements: `.agents/tasks/send-named-media-button/send-named-media-requirements.md`
Scope: `src/app/dashboard/messages/send/page.tsx` (client) + `src/app/api/messages/send/route.ts` (session route). No change to the send core, the shared libs, the schema, or the public API.

## Overview

The dashboard Send page is numbered-body-only. On template select it scans the body with
a local `extractVariables` regex that matches only `{{digit}}`, renders a positional
`Variable {{1}}..{{n}}` list, and POSTs `{ numberId, recipient, templateId, variables }`.
The session route forwards only `variables` to `sendTemplateMessage`. Named-body,
media-header, and dynamic-URL-button templates (e.g. `niqen_invite`) therefore fail at the
send core's pre-charge gate with HTTP 400 before any row/credit is touched.

The fix has two concrete parts, both additive:

1. **Make the page structure-aware.** Replace the inline numbered-only `extractVariables`
   reducer with the shared, already-correct derivation in `src/lib/template-params.ts`
   (`parseTemplateBody`, `resolveBodyPreview`, `buttonUrlIsDynamic`), render the inputs the
   selected template actually needs (named map / media URL / button value / numbered — as
   applicable), validate them client-side, and submit exactly one body form.
2. **Plumb the extra fields through the session route.** Read `namedParams`, `mediaUrl`,
   `documentUrl`, `fileName`, `filename`, `buttonParam`, `buttonUrlParam` off the request
   body and forward them to `sendTemplateMessage` alongside `variables`, preserving every
   existing behavior (auth, ownership/status scoping, 402→400 remap, response shape).

The send core, its gate, and its Meta payload builder are **untouched**; the page/route
pair simply feed the core the same field set the public `POST /api/v1/messages` already
feeds it. This is the key reason the design is low-risk: the hard part (gate, credit math,
Meta component construction) is already proven by the public path, and we are only
widening the two dashboard-specific layers to match.

**Numbered-request fidelity (precise statement, Finding 3).** To keep numbered sends
behaving exactly as today, the numbered positional list is derived from the **same
distinct-numeric-token scan the current page uses** (`extractVariables(body).sort()` →
distinct `{{n}}` tokens, ascending), NOT from `parseTemplateBody`'s `count`. For the
canonical `{{1}}..{{n}}` body these are identical, but for a non-canonical numbered body
(sparse or duplicate indices, e.g. `{{2}} {{5}}`) the distinct-token list preserves today's
exact array shape and index mapping, whereas a `1..count` list would silently change it.
Deriving from the distinct-token scan is therefore the chosen rule, so AC4's
"byte-identical numbered request" holds for all numbered bodies, not just canonical ones.
`parseTemplateBody` is still the authority on the named/numbered/none **classification**;
only the numbered index list is derived from the token scan (and the gate's own numbered
check compares against `model.count`, which equals the distinct-token count — they agree).

## Technology stack (locked)

No change. Next.js App Router, React client component (`"use client"`), TypeScript strict,
NextAuth session auth, Prisma, existing shadcn/ui primitives (`Button`, `Input`, `Label`,
`Card`, `Badge`) and lucide-react icons. **Zero new npm dependencies. No Prisma migration.**
All template parsing/preview/button-detection comes from the existing
`src/lib/template-params.ts`.

## Client importability of the shared lib (confirmed)

`src/lib/template-params.ts` has **zero imports** — no Prisma, no `next/*`, no `fs`, no
`crypto`, no `fetch`. Every export (`parseTemplateBody`, `ParamModel`, `resolveBodyParams`,
`namedParams`, `resolveBodyPreview`, `buttonUrlIsDynamic`) is a pure string/object
function. It is therefore directly importable into the client component
(`src/app/dashboard/messages/send/page.tsx`) with no `"use server"`/server-only concern.

Decision: **import `parseTemplateBody`, `resolveBodyPreview`, and `buttonUrlIsDynamic`
directly from `@/lib/template-params`** on the client. Do **not** import from
`@/lib/template-format.ts` (it only re-exports the same functions and adds route-formatting
helpers; the direct source is cleaner and still single-sourced). No parsing logic is
duplicated in the page — the `extractVariables` regex and the numbered-only preview reducer
are removed and replaced by the lib calls. This satisfies NFR2 and the task's
"NO duplicated parsing logic" constraint.

Named-order guarantee: `parseTemplateBody` already returns named params as
**distinct names in first-occurrence order** (its `seen` Set + `names.push`), which is the
exact order the send core's `resolveBodyParams` validates against. By reusing it we inherit
that ordering — we never re-derive it.

## Templates route: no change needed (requirement A1 confirmed)

`GET /api/templates` (`src/app/api/templates/route.ts`) calls
`prisma.template.findMany({ where: { userId }, orderBy })` with **no `select`**, so it
already returns the full owner-scoped `Template` row including `body`, `headerType`,
`headerContent`, `footerContent`, `buttons`, `category`, `language`, `status`, `name`,
`id`. There is **no FK/relation include**, so no cross-tenant leakage. The task's
conditional ("widen the select if `headerType`/`buttons` are missing") does **not apply** —
the fields are present. **No route change.** The only gap is the client `Template`
interface omitting `buttons`/`language` and the form reading only numbered vars.

(If a future contributor trims this to an explicit `select` for payload hygiene, it MUST
retain `id, name, body, headerType, headerContent, footerContent, buttons, category,
language, status` and MUST remain `userId`-scoped with no relation include — mirroring the
public `GET /api/v1/templates`. That is a note, not part of this change.)

## Page design (`src/app/dashboard/messages/send/page.tsx`)

### Type surface (FR1.8, NFR4)

Extend the local `Template` interface to carry structure:

```ts
interface Template {
  id: string;
  name: string;
  body: string;
  headerType: string | null;
  headerContent: string | null;
  footerContent: string | null;
  buttons: string | null;   // NEW — nullable JSON string column
  category: string;
  language: string;         // NEW
  status: string;
}
```

The `GET /api/templates` response already includes these fields, so this is a pure
type-widening — no fetch/shape change. No `any` is introduced; the request body built in
`handleSend` is typed (see below).

### Deriving structure on template select

Replace the inline `extractVariables` + numbered-only `templateVariables`/`previewBody`
block with lib-driven derivation computed from `selectedTemplate`:

```ts
import { parseTemplateBody, resolveBodyPreview, buttonUrlIsDynamic } from "@/lib/template-params";

const paramModel = selectedTemplate
  ? parseTemplateBody(selectedTemplate.body)        // { kind:"named"|"numbered"|"none", ... }
  : { kind: "none" as const };

const headerKind = (selectedTemplate?.headerType || "").toLowerCase();
const isMediaHeader = headerKind === "image" || headerKind === "video" || headerKind === "document";

const isAuthTemplate = selectedTemplate?.category === "authentication";
const hasDynamicButton =
  !!selectedTemplate &&
  !isAuthTemplate &&
  buttonUrlIsDynamic(selectedTemplate.buttons);
```

Rationale for mirroring the gate's own predicates exactly:
- `isMediaHeader` uses the same lower-cased `image|video|document` test as the send core's
  gate (§(b)) so the client never asks for a media URL the gate wouldn't require, and never
  omits one the gate requires.
- `hasDynamicButton` excludes `authentication` templates, matching the gate's
  `!isAuthTemplate && buttonIsDynamic` condition (§(c)). Auth templates carry a copy-code
  button fed from `variables[0]`, not a generic `buttonParam` (FR1.5).

### Form state

Four pieces of body/header/button-input state, selected by `paramModel.kind` and the
header/button flags:

- **Numbered** — keep the existing `variables: Record<number, string>` state and the
  existing numbered-input UI and CSV per-recipient mapping **unchanged**.

  The single source for the numbered index list is **`numberedList`**, defined once and
  reused for the input render, the preview, the missing-vars check, and the request body —
  so there is exactly one definition (Finding 2):

  ```ts
  // Distinct numeric {{n}} tokens in ascending order — identical to today's
  // extractVariables(body).sort(). Preserves the exact array shape/index mapping for
  // canonical AND non-canonical numbered bodies (Finding 3). element type is `number`,
  // so it indexes csvPerRecipientVars (Record<number,string>) and `variables` cleanly.
  const numberedList: number[] = selectedTemplate && paramModel.kind === "numbered"
    ? [
        ...new Set(
          [...selectedTemplate.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])),
        ),
      ].sort((a, b) => a - b)
    : [];
  ```

  Render one `Input` per entry in `numberedList`, labeled `Variable {{n}}`, bound to
  `variables[n]`, with the existing CSV-column badge logic unchanged. (`extractVariables`
  and `templateVariables` are deleted; `numberedList` replaces them verbatim in behavior
  for the numbered path.)
- **Named** — add `namedValues: Record<string, string>` keyed by the declared param names
  from `paramModel.names`. Render one `Input` per name, in `paramModel.names` order, each
  `<Label>` showing the raw param name (e.g. `guest_name`).
- **Media header** — add `headerMediaUrl: string`. Render one required URL `Input` when
  `isMediaHeader`, with the hint "Meta must fetch this over a public URL." For a
  **document** header, also add `headerFileName: string` and render one optional
  "File name (shown to recipient)" `Input` beneath the URL — submitted as `fileName` so the
  recipient sees a meaningful name instead of the core's default `receipt.pdf` (Finding 5,
  option b). Image/video headers do not render a file-name input.
- **Dynamic button** — add `buttonValue: string`. Render one required `Input` when
  `hasDynamicButton`.

Reset all on template change (extend the existing `onChange` that already does
`setVariables({})` to also clear `namedValues`, `headerMediaUrl`, `headerFileName`,
`buttonValue`).

Base64/file-upload for header media is **out of scope**: no existing dashboard upload
mechanism is being reused here (the base64 path exists only in the public API body), so the
primary and only path is a public media URL (requirements Out of Scope + FR1.3). The page
sends only `mediaUrl`/`documentUrl` (and `fileName` for documents); it never sends
base64/mediaId fields.

### Live preview (FR1.6)

Replace the numbered-only `previewBody` reducer with `resolveBodyPreview`, which handles
both forms from one classifier. The `previewValues` expression must type-check against the
`ParamModel` discriminated union — the `numbered` member is `{ kind:"numbered"; count:number }`
with **no `names` field**, so the numbered branch builds its array from `numberedList`
(Finding 1):

```ts
const previewValues: string[] | Record<string, string> | null =
  paramModel.kind === "named"
    ? namedValues                                              // Record<string,string>
    : paramModel.kind === "numbered"
      ? (() => {
          // Dense positional array indexed BY TOKEN VALUE, not by numberedList
          // position. resolveBodyPreview resolves a numbered token with
          // idx = Number(token) - 1, so element (n-1) must hold the value for
          // {{n}}. Building a sparse-safe array keyed by token value makes the
          // preview correct for BOTH canonical {{1}}..{{n}} bodies AND
          // non-canonical ones (e.g. {{2}} {{5}}); see Finding 1 / A6.
          // numberedList is defined once in Form state → Numbered (number[]).
          const max = numberedList.length ? Math.max(...numberedList) : 0;
          const arr = Array.from({ length: max }, () => "");
          for (const n of numberedList) arr[n - 1] = variables[n] ?? "";
          return arr;                                          // arr[n-1] = value for {{n}}
        })()
      : null;                                                  // kind === "none"

const previewBody = selectedTemplate
  ? resolveBodyPreview(selectedTemplate.body, previewValues)
  : "";
```

Concretely: for **named**, pass the `namedValues` record — `resolveBodyPreview` substitutes
`{{name}}` from the record (keyed by name) and leaves unresolved placeholders intact. For
**numbered**, pass a dense positional array indexed by token value so element `n-1` holds
the value typed for `{{n}}`. This matters because `resolveBodyPreview` resolves a numbered
token by `idx = Number(token) - 1` and substitutes `values[idx]` whenever
`idx >= 0 && idx < values.length` (verified in `src/lib/template-params.ts`). A naive
`numberedList.map((n) => variables[n])` is dense only for the canonical `{{1}}..{{n}}` body;
for a non-canonical body like `{{2}} {{5}}` (`numberedList = [2, 5]`) that naive array would
be `[value(2), value(5)]`, and token `{{2}}` would resolve `values[2-1] = values[1]` = the
value typed for `{{5}}` — a visibly **wrong** value, not a left-intact token. The
token-value-indexed array above fixes that: `arr[1]` holds `value(2)` and `arr[4]` holds
`value(5)`, so `{{2}}` and `{{5}}` each render their own input (any gap index stays `""`).
For the canonical `{{1}}..{{n}}` body the two forms are identical, so there is zero behavior
change for the common case. For **none**, pass `null` → the body renders verbatim.
`resolveBodyPreview` accepts `string[] | Record<string,string> | null`, so this type-checks
with no `any` and no union-member mismatch. The old `extractVariables`/`.reduce` block is
removed entirely.

Media-header indicator (AC8): the existing preview already renders a "Header → Media" box
whenever `headerType && headerType !== "none"`. **That box alone satisfies AC8** — no extra
work is required for acceptance. The design keeps it as-is and does **not** add a URL echo
(explicitly out of scope for this change) so the implementer and the acceptance check agree
on exactly what "indicate a media header" means. The existing text/footer/cost blocks are
unchanged.

### Client-side validation (FR1.7)

Extend `handleSend`'s pre-submit checks (which already block on empty number/template/
recipients). Add, before the credits check:

- **Named:** every `paramModel.names` entry must have a non-empty trimmed `namedValues[name]`.
  On failure: `setError("Fill in template parameter: <name>")` naming the first missing one.
- **Media header:** if `isMediaHeader` and `headerMediaUrl.trim()` is empty →
  `setError("Enter the header media URL (Meta must fetch it over a public URL).")`.
- **Dynamic button:** if `hasDynamicButton` and `buttonValue.trim()` is empty →
  `setError("Enter the button value.")`.
- **Numbered:** the existing `missingVars` check runs over the new `numberedList`
  (which replaces the deleted `templateVariables`), with the same CSV-per-recipient
  awareness as today (Finding 4):

  ```ts
  const hasCsvVars = Object.keys(csvPerRecipientVars).length > 0;
  const missingVars = numberedList.filter((v) => {
    if (hasCsvVars && Object.values(csvPerRecipientVars)[0]?.[v] !== undefined) return false;
    return !variables[v];
  });
  if (missingVars.length > 0) {
    return setError(
      `Fill in template variables: ${missingVars.map((v) => `{{${v}}}`).join(", ")}`,
    );
  }
  ```

  This is the identical logic to today's check — only the list it iterates changed name
  from `templateVariables` to `numberedList` (same contents for the numbered path).

These mirror the server gate for immediate feedback; the server remains the source of truth
(if a client check is bypassed, the gate still returns 400 — AC7).

### Request body construction (FR1.2, FR1.3, FR1.4)

In the per-recipient loop in `handleSend`, build the POST body by `paramModel.kind` and
header/button structure. Submit **exactly one** body form — never both `variables` and
`namedParams` (the send core's `resolveBodyParams` rejects both; AC6):

```ts
type SendBody = {
  numberId: string;
  recipient: string;
  templateId: string;
  variables?: string[];                 // numbered body only
  namedParams?: Record<string, string>; // named body only — never together with variables
  mediaUrl?: string;                    // image/video header only  }  mutually exclusive:
  documentUrl?: string;                 // document header only     }  only one is ever set
  fileName?: string;                    // document header only (optional, recipient-facing name)
  buttonParam?: string;                 // dynamic URL button only
};

const base: SendBody = {
  numberId: formData.numberId,
  recipient: phone.replace(/\D/g, ""),
  templateId: formData.templateId,
};

// Body form — exactly one of variables / namedParams / neither (AC6).
// resolveBodyParams rejects a request carrying BOTH, so the client sets at most one.
if (paramModel.kind === "named") {
  base.namedParams = { ...namedValues };            // keyed by declared names
} else if (paramModel.kind === "numbered") {
  // numberedList is defined once in Form state → Numbered (number[]); reused here.
  base.variables = numberedList.map(
    (v) => csvPerRecipientVars[phone]?.[v] ?? variables[v] ?? "",
  );                                                // positional — byte-identical to today
}
// kind === "none" → neither field set

// Media header — mediaUrl for image/video, documentUrl (+ optional fileName) for document.
// By construction exactly one of mediaUrl / documentUrl is set; never both.
if (isMediaHeader) {
  if (headerKind === "document") {
    base.documentUrl = headerMediaUrl.trim();
    const fn = headerFileName.trim();
    if (fn) base.fileName = fn;                     // omit → core default "receipt.pdf"
  } else {
    base.mediaUrl = headerMediaUrl.trim();          // image | video
  }
}

// Dynamic URL button
if (hasDynamicButton) base.buttonParam = buttonValue.trim();
```

`numberedList` and `csvPerRecipientVars` are both keyed by `number`, so
`csvPerRecipientVars[phone]?.[v]` type-checks (`v: number`). The numbered branch is the same
expression the current page uses, over the same list — only the list's source changed from
`extractVariables(...).sort()` to `numberedList` (identical contents; see Overview).

Key points:
- **Named** sends a `namedParams` **map** keyed by the declared names; **numbered** keeps
  sending the positional `variables` array exactly as today (same CSV-fallback expression),
  so AC4 (byte-identical numbered request) and AC6 (never both) hold.
- `documentUrl` vs `mediaUrl` is chosen by `headerKind` so a document header submits
  `documentUrl` and image/video submit `mediaUrl` (AC2/AC3). The send core treats
  `documentUrl || mediaUrl` as the source, so either satisfies the gate, but we match the
  type for correctness and parity with the public API.
- **Auth templates:** `paramModel.kind` for an auth template is typically `numbered`
  (the OTP is `{{1}}`), so it goes down the `variables` branch — `variables[0]` is the OTP,
  exactly as today. `hasDynamicButton` is forced false for auth templates, so no generic
  `buttonParam` input is shown or sent; the send core adds the copy-code button from
  `variables[0]` itself (FR1.5, AC11). `#131008` handling is untouched.

### Bulk send (FR3)

The existing recipient loop already applies the same template to every recipient. The new
`namedParams`/`mediaUrl`/`documentUrl`/`buttonParam` are computed from form state (not
per-row) and are therefore **same-value-to-all** by construction (FR3.1). The CSV
per-recipient positional-variable mapping stays only on the numbered `variables` branch
(FR3.2) — no per-row named/media/button mapping is added (out of scope). The progress bar,
per-recipient results list, credit pre-check, and post-send credit refresh are unchanged
(FR3.3).

### Responsive layout (NFR3)

New inputs live inside the existing `CardContent className="space-y-4"` (left Compose card)
under the template select, matching the current numbered-variable block's spacing. Each
named input is a full-width stacked `Label` + `Input` (`space-y-2`), identical to the
existing variable inputs, so they stack cleanly on mobile within the existing
`grid-cols-1 lg:grid-cols-2` shell. The media-URL and button inputs follow the same stacked
pattern. No new layout primitives.

## Route design (`src/app/api/messages/send/route.ts`)

Minimal, additive change — destructure the extra fields and forward them. Everything else
(auth, ownership+status queries, 402→400 remap, response shape, missing-fields 400) is
unchanged (FR2.2).

Current:
```ts
const { numberId, recipient, templateId, variables } = body;
```
New:
```ts
const {
  numberId, recipient, templateId,
  variables, namedParams,
  mediaUrl, documentUrl, fileName, filename,
  buttonParam, buttonUrlParam,
} = body;
```

The required-field guard stays exactly as-is — only `numberId`/`recipient`/`templateId` are
mandatory; the new fields are optional and validated by the send core's gate (FR2.2). The
route destructures and forwards both `fileName` and `filename` (the core resolves
`fileName || filename` into the document filename, falling back to `"receipt.pdf"`). The
page now populates `fileName` for document headers (Finding 5, option b), so a dashboard
document send shows the recipient-facing name the sender entered rather than the default;
`filename` remains forwarded for public-API parity but the page does not set it.

Current `sendTemplateMessage` call gains the forwarded fields:
```ts
const result = await sendTemplateMessage({
  userId: session.user.id,
  number,
  template,
  recipient,
  variables,
  namedParams,
  mediaUrl,
  documentUrl,
  fileName,
  filename,
  buttonParam,
  buttonUrlParam,
  isSuperAdmin: session.user.role === "superadmin",
});
```

Unchanged and explicitly preserved:
- `getServerSession(authOptions)` → 401 when no `session.user.id` (FR2.2).
- `number` resolved via `findFirst({ id: numberId, userId: session.user.id,
  verificationStatus: "verified" })` → 400 if absent (owned + verified; NFR5).
- `template` resolved via `findFirst({ id: templateId, userId: session.user.id,
  status: "approved" })` → 400 if absent (owned + approved; NFR5).
- `isSuperAdmin: session.user.role === "superadmin"` — kept as the session route's existing
  derivation (the public route uses the email-driven predicate; this route's behavior is
  preserved as-is, not changed). **Known gotcha (Finding 9):** the dashboard send route and
  the public send route use two *different* superadmin models — session role
  (`session.user.role === "superadmin"`) here vs. email-driven `isSuperAdminUser(owner)` in
  `/api/v1/messages`. This divergence is intentional and preserved (changing it is a
  separate task); a future contributor touching superadmin credit-exemption must update both
  independently. Recorded here and in A4 so it is not mistaken for a bug.
- `402 → 400` remap on `!result.ok`; all other `result.code` passed through.
- Success response `{ id: result.message.id, status: "sent", message: "Message sent
  successfully" }`.
- Outer `try/catch` → 500 `Internal server error`.

**No change** to the send core gate or Meta payload construction (FR2.3, Out of Scope). No
fork of send logic — the single `sendTemplateMessage` core still does all sending.

### Typing (NFR4)

The route reads an untyped `body = await request.json()`. The forwarded fields are passed
positionally into the typed `SendTemplateInput`, so each lands on its typed parameter
(`namedParams?: Record<string,string>`, `mediaUrl?: string`, etc.). No `any` is introduced
beyond the already-untyped `body` destructure (which is pre-existing and out of scope to
re-type). The TS compiler enforces the field types at the `sendTemplateMessage` boundary.

## Error handling (concrete, per failure point)

| Operation | Failure condition | Recoverable? | Caller receives | Logged? |
|---|---|---|---|---|
| Client body-param validation | required named param / media URL / button value empty | yes (inline fix) | inline `setError` naming the missing input; submit blocked, no POST | no |
| Client credits pre-check | balance < recipient count | yes | inline `setError` with needed/have | no |
| POST `/api/messages/send` | missing `numberId`/`recipient`/`templateId` | yes | 400 `Missing required fields` | no |
| Number resolution | not owned / not verified | yes | 400 `Invalid or unverified WhatsApp number` | no |
| Template resolution | not owned / not approved | yes | 400 `Template not found or not approved` | no |
| Send core gate — body | named/numbered/none mismatch (incl. both forms) | yes | 400 with core's precise message | no (pure) |
| Send core gate — header | media header but no media source | yes | 400 `...provide 'mediaUrl'...` | no |
| Send core gate — button | dynamic button but no `buttonParam` | yes | 400 `...provide 'buttonParam'...` | no |
| Send core — insufficient credits | balance ≤ 0 (non-superadmin) | yes | **400** (route remaps core's 402) | no |
| Send core — not connected / Meta error | credential decrypt fail or Meta non-2xx | fatal for that recipient; credit refunded | 500 `result.error`; page marks that recipient `failed` with `data.error` | yes (core `console.error`/`warn`) |
| Route uncaught | unexpected throw | fatal | 500 `Internal server error` | yes (`console.error`) |

In the page's per-recipient loop, any non-OK response (`!res.ok`) pushes a `failed` result
with `data.error` and increments the failed counter; a thrown fetch pushes `failed` with
`"Network error"`. This is the existing behavior and is preserved — one recipient's failure
never aborts the batch.

## Input validation rules (each external input)

Page → route body fields:

| Field | Required | Type | Limits/rules | On failure |
|---|---|---|---|---|
| `numberId` | yes | string | must resolve owned+verified | 400 |
| `recipient` | yes | string (digits) | page strips `\D`; the `>= 7`-digit filter is **client-side parsing only** (the recipient splitter) — the **route only requires `recipient` be truthy** and otherwise relies on Meta to reject malformed numbers (Finding 6) | 400 if empty / Meta error if invalid |
| `templateId` | yes | string | must resolve owned+approved | 400 |
| `variables` | numbered only | `string[]` | length must equal distinct `{{n}}` count (gate) | 400 gate |
| `namedParams` | named only | `Record<string,string>` | key set must exactly equal declared names (gate) | 400 gate |
| `mediaUrl` | image/video header | string | non-empty public URL (client-checked); gate requires presence | 400 gate |
| `documentUrl` | document header | string | non-empty public URL (client-checked) | 400 gate |
| `fileName` | document header (optional) | string | trimmed; omitted when empty → core default `"receipt.pdf"` | n/a (optional) |
| `buttonParam` | dynamic button | string | non-empty (client-checked); gate requires presence | 400 gate |

The server gate (`resolveBodyParams` + header/button presence) is the authoritative
validator; client checks are UX-only and mirror it.

## Invariant ownership

- **One body form per request** (never both `variables` and `namedParams`): enforced on the
  **client** by the `paramModel.kind` branch (only one field is ever set) **and** on the
  **server** by `resolveBodyParams` (rejects both). The server is authoritative; the client
  branch guarantees we never trip the server rule accidentally.
- **Tenant isolation / ownership + status**: owned by the **route** (`findFirst` with
  `userId` + `verificationStatus`/`status`), unchanged. The client never bypasses it.
- **Named order == gate order**: owned by the shared **lib** (`parseTemplateBody` first-
  occurrence order), reused on both client and server — single source, cannot drift.
- **Credit math symmetry / Meta payload shape**: owned by the **send core**, untouched.

## Edge cases

- **Named template with a repeated `{{name}}`**: `parseTemplateBody` de-dupes to one input;
  one value fills all occurrences in both preview and send. Correct.
- **Document header**: submits `documentUrl` (not `mediaUrl`), plus `fileName` when the
  sender entered one; the core builds a document header component using
  `fileName || filename || "receipt.pdf"`. If the sender leaves the file-name input blank,
  the recipient sees the core default `"receipt.pdf"` — an accepted, documented behavior
  (Finding 5). AC3.
- **Video header**: submits `mediaUrl`; core builds a video header component. AC3.
- **No-placeholder, no-header template**: `kind:"none"`, no media, no dynamic button → body
  has neither `variables` nor `namedParams`; gate emits no body component; send succeeds.
  AC5.
- **Auth template (`otp_1` etc.)**: numbered body (OTP = `{{1}}`), no generic button input,
  copy-code button added by core from `variables[0]`. AC11.
- **Template with a static (non-dynamic) URL button**: `buttonUrlIsDynamic` returns false →
  no button input, no `buttonParam` sent; core emits no dynamic button component. Correct.
- **Numbered template via CSV per-recipient columns**: still maps per row through the
  `variables` branch; named/media/button are not per-row (out of scope). FR3.2.
- **`buttons` column is `null` or malformed JSON**: `buttonUrlIsDynamic` returns false
  defensively (never throws) → no button input. Safe.

## Testability

**Unit-testable (pure, no DB/network):**
- The page's structure derivation is a thin wrapper over `parseTemplateBody`,
  `resolveBodyPreview`, and `buttonUrlIsDynamic` — these are already pure and unit-testable
  in isolation (existing lib tests cover named/numbered/none ordering, preview substitution,
  and dynamic-button detection). The design adds no new parsing logic to test.
- The request-body construction is a pure function of (`paramModel`, form state,
  header/button flags); it can be extracted or exercised to assert "named → `namedParams`
  only", "numbered → `variables` only", "document → `documentUrl`", "image/video →
  `mediaUrl`", "dynamic button → `buttonParam`", "none → neither".

**Integration-testable (in principle):**
- The route forwarding (`POST /api/messages/send` with the extra fields reaching
  `sendTemplateMessage`) — assert the gate accepts a well-formed named/media/button request
  and the response shape stays `{ id, status, message }`.

**Manual/E2E:** template-select rendering and live preview in the dashboard.

The design is test-friendly because the risky logic already lives behind pure, tested libs
and an already-tested send core; the new surface is wiring + render, not new algorithms.

**Harness reality (round-2 U3):** `package.json` has a `build` and a `lint` script but
**no `test` script and no test framework** in `devDependencies`. The unit/integration
framing above describes *what would be testable* if a harness existed; it does **not** imply
a runnable automated-test gate for this change. The authoritative gate for this task is
`npm run build` (which runs `prisma generate && next build` and the full `tsc` typecheck)
plus the manual traces in the Verification plan below — matching AC12, which requires only
`npm run build`/`tsc`. Standing up a test runner is out of scope.

## Verification plan

1. **Build / typecheck:** `npm run build` passes with the extended `Template` interface and
   the typed `SendBody`; no new entry in `package.json`; no new file under
   `prisma/migrations`. (AC12, NFR1.)
2. **Named-template trace (`niqen_invite`):**
   - Select → `parseTemplateBody(body)` yields `kind:"named"` with the eight names in
     declared order (`event, guest_name, event_name, event_date, venue_name,
     allowed_guests, pass_url, card_url`) → 8 labeled inputs. `headerType="image"` →
     `isMediaHeader` → one media-URL input. `buttonUrlIsDynamic(buttons)` true (non-auth) →
     one button-value input. (AC1.)
   - Fill all 8 + a public image URL + a button value → POST body is
     `{ numberId, recipient, templateId, namedParams:{...8 keys}, mediaUrl, buttonParam }`
     with **no `variables`** → route forwards → gate passes → Meta payload has a header
     `image` component, a body component with `parameter_name` per entry, and a URL button
     component; one credit charged, one message row created. (AC2, AC6.)
3. **Document / video header:** a document-header template submits `documentUrl` (plus
   `fileName` when the file-name input is filled; omitted → core default `"receipt.pdf"`);
   a video-header template submits `mediaUrl` and no `fileName`. (AC3.)
4. **Numbered no-regression trace (`otp_1`):** select → `kind:"numbered"` →
   `numberedList` = distinct `{{n}}` tokens ascending (identical to today's
   `extractVariables(...).sort()`); the current `Variable {{1}}..{{n}}` inputs render; POST
   body carries `variables: string[]` only — byte-identical to today (same list, same
   CSV-fallback expression), including for non-canonical numbered bodies. Auth copy-code
   button still driven by `variables[0]`; no generic button input shown. (AC4, AC11.)
5. **No-placeholder, no-header template:** sends with neither `variables` nor `namedParams`
   and succeeds. (AC5.)
6. **Client validation:** empty required named param / media URL / button value blocks
   submit with a naming inline error; bypassing the client still yields a 400 from the gate.
   (AC7.)
7. **Preview:** named values substitute into `{{name}}`; numbered values into `{{n}}`;
   media header indicator shown. (AC8.)
8. **Bulk:** send to N recipients applies the same media/named/button to all; progress bar,
   results list, and credit refresh behave as today; numbered per-row CSV still works.
   (AC9.)
9. **Route contract:** success → `{ id, status:"sent", message }`; core 402 → 400; absent
   required field → 400 `Missing required fields`; owned+verified number and owned+approved
   template enforced. (AC10.)
10. **No-regression sweep:** public `POST /api/v1/messages`, public `GET /api/v1/templates`,
    `src/lib/send-template.ts`, and `src/lib/template-params.ts` are unmodified
    (`git diff --stat` shows changes only in `send/page.tsx` and `messages/send/route.ts`).
    (FR4, Out of Scope.)

## Ambiguities / unverified assumptions (flagged)

- **A1 — route select (confirmed):** `GET /api/templates` returns the full row (no
  `select`), so `buttons`/`headerType`/`language` are already present. No route change —
  verified in `src/app/api/templates/route.ts`.
- **A2 — field name:** the session request/forward uses `namedParams` end-to-end (matching
  `SendTemplateInput.namedParams`), while the public API input is `templateParams`. Confirmed
  in `send-template.ts` and `v1/messages/route.ts`.
- **A3 — button detection:** `buttonUrlIsDynamic(template.buttons)` alone decides the
  button input; the send core uses the same predicate for the gate and the component, so
  client and server agree. Confirmed.
- **A4 — superadmin derivation (noted, not changed; Finding 9):** this route keeps its
  existing `session.user.role === "superadmin"` derivation; the email-driven
  `isSuperAdminUser` predicate used by the public route is intentionally **not** adopted here
  to avoid changing session-route behavior. The two routes therefore use divergent superadmin
  models — a real gotcha for future contributors (recorded in the route section's known-gotcha
  note). If parity were desired it would be a separate task.
- **A5 — base64 header upload:** no existing dashboard upload path to reuse, so the page
  sends only a public `mediaUrl`/`documentUrl` (plus optional `fileName` for documents); the
  route does not wire base64/mediaId fields. Consistent with Out of Scope.
- **A6 — numbered index list source (resolved, round-1 Finding 3):** the numbered
  positional list (`numberedList`) is derived from the distinct `{{n}}` token scan, NOT from
  `parseTemplateBody().count`, so numbered **requests** stay byte-identical to today for both
  canonical and non-canonical numbered bodies. `parseTemplateBody` still owns the
  named/numbered/none classification.
- **A7 — numbered preview indexing (resolved, round-2 Finding 1):** the numbered **preview**
  array is indexed by token value (element `n-1` holds the value for `{{n}}`), not by
  `numberedList` position, because `resolveBodyPreview` resolves a numbered token with
  `Number(token)-1`. A position-indexed array would mis-display non-canonical bodies
  (e.g. `{{2}} {{5}}` would render `{{2}}` using the value typed for `{{5}}`). This is a
  preview-only concern — the send request is unaffected (A6) — but the preview is now correct
  for all numbered bodies, canonical and non-canonical.
- **No remaining unresolved ambiguity.**

## Review responses (round 1)

Review: `.agents/tasks/send-named-media-button/send-named-media-design-review.md`
(verdict CHANGES_REQUESTED — 2 HIGH, 3 MEDIUM, 4 NIT). Every finding is addressed below.

| # | Severity | Disposition | How addressed |
|---|---|---|---|
| 1 | HIGH | Fixed | Live-preview `previewValues` snippet rewritten to drop the invalid `paramModel.names` access in the numbered branch; numbered branch now builds the array from `numberedList`, typed `string[] \| Record<string,string> \| null`, matching `resolveBodyPreview`'s signature. No TS2339, no `any`. (Live preview section.) |
| 2 | HIGH | Fixed | `numberedList: number[]` is now defined once (Form state → Numbered) and reused by the input render, preview, missing-vars check, and request body. Element type is `number`, so `csvPerRecipientVars[phone]?.[v]` type-checks. (Form state + Request body + Validation sections.) |
| 3 | MEDIUM | Fixed (chosen rule stated) | Chose "preserve today's exact token list": `numberedList` is derived from the distinct-token scan (`matchAll(/\{\{(\d+)\}\}/g)` → `Set` → sort), not `1..count`. AC4 "byte-identical" now holds for non-canonical bodies too. Stated in Overview, Form state, A6. |
| 4 | MEDIUM | Fixed | Numbered `missingVars` check restated explicitly over `numberedList` (not the deleted `templateVariables`), same CSV-aware logic as today. (Client-side validation section.) |
| 5 | MEDIUM | Fixed (option b) | The page now sends an optional `fileName` for document headers; the route already forwards it. Document headers show the sender-entered name, falling back to `"receipt.pdf"` when blank (documented in Edge cases + validation table). |
| 6 | NIT | Fixed | Validation table clarified: the `>= 7`-digit rule is client-side parsing only; the route requires only a truthy `recipient` and relies on Meta to reject bad numbers. |
| 7 | NIT | Fixed | Stated the existing "Header → Media" box already satisfies AC8; dropped the optional URL echo (explicitly out of scope). (Live preview section.) |
| 8 | NIT | Fixed | `SendBody` type annotated to note `variables`/`namedParams` and `mediaUrl`/`documentUrl` are mutually exclusive by construction; a one-line note added in the branch. |
| 9 | NIT | Addressed (note only, no code change) | Added a one-line known-gotcha note in the route section and A4 recording the two divergent superadmin models (session role vs. email-driven) and that the divergence is intentional. |

All dispositions align with the requirements: the chosen rule for Finding 3 preserves FR4.1
(numbered no-regression); Finding 5's optional `fileName` stays within FR1.3/FR2.1 (public
URL primary path, route forwards the field) and adds no new dependency or schema change
(NFR1). No finding required deviating from scope or the locked stack.

## Review responses (round 2)

Review: `.agents/tasks/send-named-media-button/send-named-media-design-review.md`
(verdict CHANGES_REQUESTED — 0 HIGH, 1 MEDIUM, 3 NIT). Every finding is addressed below. The
MEDIUM is a preview-correctness defect in the round-1 numbered-preview snippet plus a false
rationale; the three NITs confirm acceptance mappings and documentation choices (no code
change). I re-verified the load-bearing claim (`resolveBodyPreview`'s `Number(token)-1`
indexing) directly in `src/lib/template-params.ts` before applying the fix.

| # | Severity | Disposition | How addressed |
|---|---|---|---|
| 1 | MEDIUM | Fixed (concrete fix adopted) | The numbered-preview array is now built **indexed by token value** — `const max = numberedList.length ? Math.max(...numberedList) : 0; const arr = Array.from({length:max}, () => ""); for (const n of numberedList) arr[n-1] = variables[n] ?? "";` — so element `n-1` holds the value for `{{n}}`, matching `resolveBodyPreview`'s `Number(token)-1` resolution. This is identical to the old proposal for canonical `{{1}}..{{n}}` bodies and correct for non-canonical bodies (`{{2}} {{5}}` no longer renders `{{2}}` with `{{5}}`'s value). The false "leaves tokens intact (acceptable)" rationale is **removed** and replaced with the truthful explanation (worked `{{2}} {{5}}` example). Recorded as A7. (Live preview section.) |
| 2 | NIT | Fixed | Added the back-reference comment `// numberedList is defined once in Form state → Numbered (number[]); reused here.` at the request-body use site, making the single-source rule obvious where `numberedList` is consumed. No code behavior change. (Request body construction section.) |
| 3 | NIT | Confirmed (no change) | Design already states the existing "Header → Media" box (rendered for `headerType !== "none"`, printing "Media" for image/video/document) alone satisfies AC8, and deliberately adds no URL echo. The acceptance mapping is verified against the real preview block. No scope added. (Live preview section, unchanged.) |
| 4 | NIT | Confirmed (no change) | Design already forwards both `fileName` and `filename` for public-API parity and retains the note that `filename` is forwarded for parity but the page sets only `fileName` (the core resolves `fileName || filename || "receipt.pdf"`). No code change. (Route design section, unchanged.) |

Non-blocking context from the review's Unverified/Wrong table, folded in:
- **U1 (niqen_invite E2E unverified):** the AC2 trace remains correct-by-source-inspection
  (gate/payload logic verified in `send-template.ts`, V5–V9), not an observed live send. The
  Verification plan already frames step 2 as a trace; no live Meta send is performed from the
  design/review phase. Treated as plausible-by-construction, which is the correct posture.
- **U3 (no test harness):** addressed by the new "Harness reality" note in Testability — the
  authoritative gate is `npm run build`/`tsc` + manual traces (AC12), and the unit/integration
  framing is explicitly marked as "in principle," not a runnable gate. Standing up a test
  runner stays out of scope.

All round-2 dispositions align with the requirements: Finding 1's fix is preview-only and
keeps the numbered **send** request byte-identical (FR4.1 / AC4 unaffected — A6), improves
AC8 preview correctness, and introduces no new dependency, schema change, or scope. The NITs
confirm existing acceptance mappings without altering behavior. With Finding 1 resolved and
the W1 rationale corrected, the review's own stated bar for APPROVED is met.
