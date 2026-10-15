# Requirements — Dashboard Send page: NAMED params + MEDIA header + DYNAMIC URL button

Last updated: 2025-02-14
Status: Draft (requirements)
Scope owner: dashboard Send flow (`src/app/dashboard/messages/send/page.tsx` + `POST /api/messages/send`)

## Summary

The dashboard **Send Message** page can only send simple numbered-body templates. It
collects a positional `Variable {{1}}..{{n}}` list and POSTs
`{ numberId, recipient, templateId, variables }`. The session route
`POST /api/messages/send` forwards only `variables` to the shared send core
`sendTemplateMessage`. As a result, templates that use **named** body parameters, a
**media header** (image / video / document), and/or a **dynamic URL button** cannot be
sent from the dashboard: the send core's pre-charge validation gate rejects them with
HTTP 400 before any message row is created or credit charged.

Confirmed failing case (reproduce, do not re-derive): template `niqen_invite` has an
IMAGE header, EIGHT named body params (`event`, `guest_name`, `event_name`,
`event_date`, `venue_name`, `allowed_guests`, `pass_url`, `card_url`), and a dynamic URL
button. The dashboard never collects a header image URL, a named-param map, or a button
value, so the send fails at the gate.

The fix is to make the Send page **structure-aware** (inspect the selected template and
render the correct inputs) and to **plumb the extra fields through** the session route
into `sendTemplateMessage` — reusing the existing, correct send core, gate, and Meta
payload builder without modifying them. The public API (`/api/v1/messages`) already
feeds these exact fields; the session route and page should mirror that behavior.

The goal is: every approved template a tenant has — numbered, named, media-header,
dynamic-button, or any combination — is sendable from the dashboard, while numbered and
no-header templates keep working exactly as today.

## Context confirmed in code (assumptions validated)

- `src/lib/send-template.ts` `sendTemplateMessage(input)` **already accepts**
  `variables?: string[]`, `namedParams?: Record<string,string>`, `mediaUrl?`,
  `documentUrl?`, `fileName?`, `filename?`, `buttonParam?`, `buttonUrlParam?`, and the
  base64/mediaId fields. Its pre-charge gate validates body-param resolution
  (`parseTemplateBody` + `resolveBodyParams`), media-header presence, and
  dynamic-button presence, returning `{ ok:false, code:400 }` on failure before any
  DB write or credit deduction. **This core, its gate, and its Meta payload builder
  must NOT change.**
- `src/lib/template-params.ts` exports `parseTemplateBody` (classifies body as
  `named` / `numbered` / `none` and yields the ordered, de-duplicated named list or the
  numbered count), `resolveBodyParams`, `namedParams`, `buttonUrlIsDynamic` (true iff
  the buttons JSON declares a `URL`-type button whose `url` contains `{{...}}`). The
  page must reuse these — no duplicate parsing logic.
- `resolveBodyParams` **rejects** a request that supplies BOTH `variables` and
  `namedParams`. The page must submit exactly one body form per request.
- **Correction to the task's conditional:** `GET /api/templates` (session,
  `src/app/api/templates/route.ts`) uses `prisma.template.findMany` with **no `select`**,
  so it already returns the full Template row — `body`, `headerType`, `headerContent`,
  `footerContent`, `buttons`, `category`, `language`, `status`, `name`, `id`. No route
  change is required to expose `buttons`/`headerType`. The gap is purely client-side:
  the page's `Template` TS interface omits `buttons` (and `language`), and the form logic
  only reads numbered body vars. (If the implementer later chooses to trim the session
  select for payload hygiene, `buttons`, `headerType`, `headerContent`, `footerContent`,
  `category`, `language`, `status`, `name`, `id`, `body` must remain in it.)
- `buttons` is a nullable JSON **string** column (`prisma/schema.prisma` `Template`);
  `buttonUrlIsDynamic` already parses it defensively and never throws.
- Public reference: `src/app/api/v1/messages/route.ts` passes `namedParams`
  (from its `templateParams`), `mediaUrl`, `documentUrl`, `fileName`, `filename`,
  `buttonParam`, `buttonUrlParam` into `sendTemplateMessage`. The session route should
  forward the same set (named-map input is named `namedParams` for the session path).
- The session route currently remaps the core's `402` → `400` and returns
  `{ id, status:"sent", message }`. Keep both.

## Functional Requirements

### FR1 — Structure-aware Send form (page)

- **US1.** As a tenant sending a template, when I select a template I want the form to
  show exactly the inputs that template needs, so I can fill in named params, a header
  media URL, and/or a button value and actually send it.

- **FR1.1 Body-param detection.** On template selection, classify the body with
  `parseTemplateBody(template.body)` (via the shared lib — do not re-implement the
  regex). Render:
  - `kind: "numbered"` → the existing numbered inputs (`Variable {{1}}..{{n}}`),
    unchanged.
  - `kind: "named"` → one labeled text input per **distinct** named param, in the
    library's **declared order**, each labeled with the param name (e.g. `guest_name`).
  - `kind: "none"` → no body-param inputs.
- **FR1.2 Body-param submission.** Submit exactly one body form:
  - numbered → `variables: string[]` (positional, current behavior).
  - named → a `namedParams` **map** `Record<string,string>` keyed by the declared
    param names.
  - none → neither (omit both).
  Never submit both `variables` and `namedParams` in the same request.
- **FR1.3 Media header input.** When `template.headerType` (lower-cased) is `image`,
  `video`, or `document`, render a required URL input for the header media. Submit it as
  `mediaUrl` for `image`/`video` and as `documentUrl` for `document`. Show the hint:
  "Meta must fetch this over a public URL." A base64 file-upload alternative is only in
  scope if an equivalent upload path already exists elsewhere in the dashboard; if not,
  it is out of scope (see Out of Scope).
- **FR1.4 Dynamic URL button input.** When the template has a dynamic URL button
  (detected via `buttonUrlIsDynamic(template.buttons)` from the shared lib), render a
  required input for the button value and submit it as `buttonParam`. Do not render this
  input when there is no dynamic button or when `buttonUrlIsDynamic` is false.
- **FR1.5 Authentication templates.** For `category === "authentication"` templates,
  keep today's behavior: the OTP code is the first body variable; do not render the
  generic dynamic-button input for them (the core handles the copy-code button from
  `variables[0]`).
- **FR1.6 Live preview.** Keep the live Preview working for all forms. For named
  templates the preview must substitute the named values into `{{name}}` placeholders
  (reuse the shared preview resolver `resolveBodyPreview` rather than the current
  numbered-only `extractVariables` reducer); numbered preview behavior is unchanged. The
  preview must indicate when a media header is present.
- **FR1.7 Client-side validation.** Before sending, block submit and show an inline
  error if: a required named param is empty, the media-header URL is empty for a media
  header, or the dynamic-button value is empty — mirroring the server gate so the user
  gets immediate feedback. Server remains the source of truth.
- **FR1.8 Type surface.** Extend the page's `Template` interface to include `buttons:
  string | null` and `language: string` (and keep `headerType`, `headerContent`,
  `footerContent`, `category`, `status`, `body`, `name`, `id`) so the form can read
  structure. No API shape change is needed since the route already returns the full row.

### FR2 — Route plumbing (`POST /api/messages/send`)

- **US2.** As the dashboard, when I POST the extra fields I want the session route to
  forward them to the send core so named/media/button templates reach Meta correctly.

- **FR2.1** Read and forward to `sendTemplateMessage`: `namedParams`, `mediaUrl`,
  `documentUrl`, `fileName`, `filename`, `buttonParam`, `buttonUrlParam` — in addition to
  the current `variables`. (Base64/mediaId fields are accepted-and-forwarded only if
  FR1.3's base64 option is in scope; otherwise they need not be wired.)
- **FR2.2** Preserve all existing behavior: `getServerSession` auth + `session.user.id`
  scoping; `numberId` resolved as owned + `verificationStatus: "verified"`; `templateId`
  resolved as owned + `status: "approved"`; `isSuperAdmin` from
  `session.user.role === "superadmin"`; the `402 → 400` remap; the success response shape
  `{ id, status:"sent", message }`; the `Missing required fields` 400 for absent
  `numberId`/`recipient`/`templateId`.
- **FR2.3** Do not fork or duplicate send logic — all sending still flows through the
  single shared `sendTemplateMessage` core.

### FR3 — Bulk send consistency

- **US3.** As a tenant sending to many recipients, I want the header media URL, named
  params, and button value applied to every recipient so a bulk named/media/button send
  works like the current numbered bulk send.

- **FR3.1** For each recipient in the loop, send the same `mediaUrl`/`documentUrl`,
  `namedParams`/`variables`, and `buttonParam` (same-value-to-all), matching the current
  per-recipient positional-vars loop.
- **FR3.2** Preserve the existing per-recipient CSV positional-variable behavior for
  numbered templates. Do not add per-row **named** mapping (it does not exist today);
  per-row CSV mapping for named/media/button is out of scope.
- **FR3.3** Keep the existing progress bar, per-recipient results list, credit
  pre-check, and credit refresh.

### FR4 — No regression

- **FR4.1** Numbered templates (e.g. `otp_1`, `migration_alert_v2`) and simple
  no-header templates send exactly as today (same payload, same inputs).
- **FR4.2** Public `POST /api/v1/messages` is unchanged.
- **FR4.3** Auth-template `#131008` handling, credit deduct/refund symmetry, superadmin
  exemption, message history/detail, and multi-tenant isolation are unchanged.

## Non-Functional Requirements

- **NFR1 — No new dependencies, no schema change.** Zero new npm packages; no Prisma
  migration.
- **NFR2 — Reuse shared libs.** All body classification, resolution, preview, and
  button-dynamic detection go through `src/lib/template-params.ts` /
  `src/lib/template-format.ts`. No duplicated parsing or payload logic; the send core's
  gate and Meta payload builder are untouched.
- **NFR3 — Responsive.** The new inputs live in the existing dashboard shell
  (Header/Sidebar/Footer + mobile drawer) and stack cleanly on mobile.
- **NFR4 — TypeScript / App Router.** Strict typing for the new form state and request
  body; no `any` leaks on the forwarded fields.
- **NFR5 — Isolation preserved.** Number and template ownership + status checks remain
  server-side and tenant-scoped; the client never bypasses them.

## Acceptance Criteria

1. Selecting `niqen_invite` on the Send page renders eight named-param inputs labeled
   `event`, `guest_name`, `event_name`, `event_date`, `venue_name`, `allowed_guests`,
   `pass_url`, `card_url` (in declared order), one media-header URL input, and one
   dynamic-button value input.
2. Submitting `niqen_invite` with all eight named params, a public image URL, and a
   button value POSTs `{ numberId, recipient, templateId, namedParams:{...8 keys},
   mediaUrl, buttonParam }` (no `variables`), the route forwards them, and the send core
   returns `ok` (a message row is created, one credit charged, Meta payload built with a
   header image component, a named body component with `parameter_name`, and a URL button
   component).
3. A document-header template sends with the URL submitted as `documentUrl` (not
   `mediaUrl`); a video-header template submits `mediaUrl`.
4. Selecting a numbered template (e.g. `otp_1`) renders the current `Variable {{1}}..{{n}}`
   inputs and POSTs `variables: string[]` only — byte-identical request to today.
5. A no-placeholder, no-header template sends with neither `variables` nor `namedParams`
   and succeeds.
6. The request never contains both `variables` and `namedParams`; a named template never
   sends a positional array and vice versa.
7. Client-side submit is blocked with an inline error when a required named param, a
   media-header URL, or a dynamic-button value is empty; the error text names the missing
   input. The server gate still rejects (400) if the client check is bypassed.
8. The live Preview substitutes named values into `{{name}}` placeholders for named
   templates and still substitutes `{{1}}..{{n}}` for numbered templates, and shows a
   header indicator for media headers.
9. Bulk send to N recipients applies the same media URL, named params, and button value
   to all N; the progress bar, results list, and credit refresh behave as today; per-row
   CSV positional vars still work for numbered templates.
10. The session route still returns `{ id, status:"sent", message }` on success, remaps
    the core's `402` to `400`, returns `400 Missing required fields` when
    `numberId`/`recipient`/`templateId` is absent, and enforces owned+verified number and
    owned+approved template.
11. `category: "authentication"` templates behave as today: OTP is the first variable,
    the generic dynamic-button input is not shown, and `#131008` handling is intact.
12. `npm run build` / `tsc` passes with the extended `Template` interface and request
    typing; no new dependency appears in `package.json`; no Prisma migration is added.

## Out of Scope

- Any change to `src/lib/send-template.ts` (gate, credit math, Meta payload), to
  `src/lib/template-params.ts` / `template-format.ts`, or to the public
  `/api/v1/messages` and `/api/v1/templates` routes.
- Database schema / migration changes.
- Per-recipient (per-CSV-row) **named** parameter, media URL, or button value mapping.
- Base64 / direct file-upload for header media on the Send page **unless** an equivalent
  upload mechanism already exists in the dashboard to reuse; the primary path is a public
  media URL.
- Multi-button or non-index-0 dynamic button support (`buttonUrlIsDynamic` assumes the
  single button at index 0, matching the send core).
- The unrelated environment/credential, deployment, delivery-receipt, and
  access-token/templates-loading topics from the original conversation — this task is
  bounded to the Send page + session send route.

## Assumptions flagged

- **A1 (verified true):** `GET /api/templates` already returns `buttons`, `headerType`,
  and all content fields (full-row `findMany`), so exposing structure needs no route
  change — contradicting the task's conditional that they "must be added." The required
  work is client-side typing + form logic only.
- **A2:** The named-map request field for the session route is `namedParams` (matching
  `sendTemplateMessage`'s parameter), while the public API calls its equivalent input
  `templateParams`. The page/route pair uses `namedParams` end-to-end.
- **A3:** `buttonUrlIsDynamic(template.buttons)` is sufficient to decide whether to show
  the dynamic-button input; scanning the buttons JSON manually is unnecessary and would
  duplicate logic.
