# Requirements — Message history/detail visibility + third-party message-list API

## Summary

Add three capabilities to the multi-tenant WhatsApp Business SaaS (Next.js 14 App
Router, TypeScript, Prisma + libSQL/Turso, Tailwind) so that both dashboard users
and third-party API-key integrations can see message **status** and **exactly what
was sent**:

1. A per-message **detail view** in the dashboard history that shows the resolved
   message content (template name, actual variable values, a resolved-body preview),
   recipient, direction, status, and the webhook-driven timestamps.
2. A **live status display** on the dashboard with distinct status chips and a manual
   refresh, surfacing the webhook-written `deliveredAt`/`readAt`/`failed` state.
3. A third-party **message LIST + live status** API — `GET /api/v1/messages` — with
   API-key auth, keyset pagination, filtering, and a shared public shaper reused by the
   existing single-message route, plus developer docs.

A prerequisite data fix is **already done and must not be redone**:
`src/lib/send-template.ts` now persists variable VALUES into
`Message.templateVariables` as a JSON **object** for the named-map form
(`namedParams`/public `templateParams`) or a JSON **array** for the positional
`variables` form, else `null`. Every consumer added here (resolved-body preview, public
shaper, dashboard detail) MUST handle all three shapes: JSON array, JSON object/record,
or null.

### Grounded facts (verified against current code)

- `Message` fields: `id`, `userId`, `whatsappNumberId`, `templateId`, `template`
  (relation), `metaMessageId`, `recipientPhone`, `templateVariables` (`String?` JSON —
  array | object | null), `status` (`queued|sent|delivered|read|failed|received`),
  `errorMessage`, `direction` (`outbound|inbound`), `content`, `conversationId`,
  `sentAt`, `deliveredAt`, `readAt`, `createdAt`. **No `@@index` exists on `Message`** —
  the keyset query scans and sorts; this is accepted at current volume.
- `src/app/api/messages/route.ts` (session route) currently uses Prisma `include`
  (`template: { select: { name } }`, `whatsappNumber: { select: { phoneNumber } }`),
  is `userId`-scoped, orders by `createdAt desc`, and returns the raw rows (which leak
  `userId`/FK columns to the browser today).
- `src/app/api/v1/messages/[id]/route.ts` authenticates with `authenticateApiKey`,
  queries `findFirst` scoped to `{ id, userId: ctx.userId, whatsappNumberId: ctx.number.id }`,
  returns an identical `404 { error: "Not found" }` for missing/cross-tenant/cross-number
  ids (no existence oracle), never logs the id, and has **no try/catch wrapper**. It does
  NOT currently return `templateName` or `direction`.
- `src/lib/api-auth.ts` exposes `authenticateApiKey(request)` returning
  `{ userId, apiKey, number }` (or `null`) and `unauthorized()` (401 JSON). It never logs
  the key.
- `src/lib/template-format.ts` exposes `parseJsonColumn(value: string|null): unknown`
  (defensive JSON parse, never throws) and re-exports `namedParams`.
- `src/lib/template-params.ts` exposes `parseTemplateBody(body)` returning
  `{ kind: "named"|"numbered"|"none", ... }` with a whitespace-tolerant
  `{{name}}`/`{{n}}` scanner. No resolved-body helper exists yet.
- `src/app/dashboard/messages/page.tsx` is a client component with a 5-column
  responsive table (Recipient, Template, From, Status, Sent), a **manual Refresh button
  already present**, a 10-second auto-refresh `setInterval` already present, a search
  box, and a `getStatusBadge` whose "Sent" column precedence is
  **`deliveredAt` > `readAt` > `sentAt`** (confirmed in code).
- The webhook (`src/app/api/webhooks/whatsapp/route.ts`) updates `status` plus
  `deliveredAt`/`readAt`/`errorMessage` keyed by `metaMessageId` via `updateMany`, and
  writes inbound rows with `status: "received"`, `direction: "inbound"`.
- `src/app/docs/page.tsx` documents `POST /api/v1/messages` and
  `GET /api/v1/messages/[id]`; it has no LIST endpoint section yet.
- Valid `Badge` variants in use: `success`, `secondary`, `destructive`, `outline`.

### Assumptions (noted explicitly for design review)

- A1. The existing 10-second auto-refresh satisfies the live-status need; "No new
  polling infra" is read as *do not add new polling mechanisms* — the existing interval
  and manual Refresh button stay as-is. No change required beyond ensuring the detail
  view and timestamps reflect refreshed data.
- A2. The resolved-body preview is computed **client-side** in the dashboard from
  `template.body` + parsed `templateVariables` returned by `GET /api/messages`, and
  **may** be computed server-side in the public shaper "if cheap". The shared pure helper
  `resolveBodyPreview` lives in `src/lib/template-params.ts` so both can reuse it.
- A3. "Expandable row" is the chosen dashboard detail UX (over a modal/separate page)
  because it fits the existing responsive table (5→6 columns) and avoids new routing.
- A4. The public `nextCursor` is the `id` of the last row in the page (used as the
  `?after=` cursor on the next request); `hasMore` is true when a full `limit` page was
  returned and more rows may follow.

---

## Functional Requirements

### FR1 — Dashboard message detail view

- FR1.1 The dashboard history (`src/app/dashboard/messages/page.tsx`) SHALL provide a
  per-message detail view, implemented as an **expandable row** toggled from each row,
  without breaking the existing responsive table layout.
- FR1.2 The detail view SHALL display: template name; the actual variable VALUES that
  were sent (parsed from `Message.templateVariables` — array, object, or null); a
  **resolved body preview** (the template body with `{{name}}`/`{{n}}` placeholders
  substituted by the stored values); recipient phone; direction (`outbound`/`inbound`);
  status; and the `sentAt`, `deliveredAt`, `readAt` timestamps plus `errorMessage` when
  present.
- FR1.3 The detail view SHALL render correctly for all three `templateVariables` shapes:
  a JSON array (numbered), a JSON object/record (named), and `null` (no values stored —
  show placeholders intact / no variable values).
- FR1.4 The resolved-body preview SHALL be produced by the shared, pure, no-throw helper
  `resolveBodyPreview` (see FR4) so dashboard and public API cannot drift.

### FR2 — Widen the session `GET /api/messages`

- FR2.1 `GET /api/messages` SHALL remain `userId`-scoped
  (`where: { userId: session.user.id }`) and SHALL keep returning the user's messages
  ordered by `createdAt desc`.
- FR2.2 The route SHALL use an **explicit Prisma `select`** (NOT `include`) that returns
  only the fields the client needs, so internal FKs and `userId` are NOT leaked to the
  browser.
- FR2.3 The selected fields SHALL include, in addition to the fields already consumed by
  the page (`id`, `recipientPhone`, `status`, `sentAt`, `deliveredAt`, `readAt`,
  `errorMessage`, `template.name`, `whatsappNumber.phoneNumber`): `template.body`,
  `templateVariables`, and `direction`, enabling the detail view and resolved-body
  preview.
- FR2.4 The client SHALL consume this response via a **pinned TypeScript interface** that
  matches the explicit `select` shape (not raw Prisma types).

### FR3 — Live status display

- FR3.1 Status chips SHALL distinctly represent `queued`, `sent`, `delivered`, `read`,
  `failed`, and `received`, each using a valid `Badge` variant (`success`, `secondary`,
  `destructive`, `outline`). The current mapping SHALL be extended to cover `received`
  (currently it falls through to the `queued`/default `outline` case) and SHALL keep
  distinct treatment for `read` vs `delivered`.
- FR3.2 The dashboard SHALL display the webhook-driven timestamps; the "Sent" column
  precedence SHALL remain **`deliveredAt` > `readAt` > `sentAt`** (unchanged — the design
  MUST NOT claim or implement a `read > delivered > sent` order).
- FR3.3 A **manual Refresh** control SHALL re-fetch `GET /api/messages`. (It already
  exists; it SHALL be preserved.) No new polling infrastructure SHALL be introduced.

### FR4 — Shared resolved-body preview helper

- FR4.1 A new function `resolveBodyPreview(body, values)` SHALL be added to
  `src/lib/template-params.ts`. It SHALL be pure (no DB, no network, no side effects) and
  SHALL never throw.
- FR4.2 It SHALL reuse `parseTemplateBody` (from the same module) and the defensive
  `parseJsonColumn` from `src/lib/template-format.ts`, avoiding circular imports.
- FR4.3 `values` MAY be:
  - a JSON **array** (numbered form): `{{1}}` → `values[0]`, `{{n}}` → `values[n-1]`.
    The numbered branch SHALL use a single consistent variable name for the normalized
    value.
  - a JSON **object/record** (named form): `{{name}}` → `values[name]`.
  - `null`/`undefined`: ALL placeholders SHALL be left intact.
- FR4.4 Missing or extra values SHALL leave the placeholder as-is or blank — never throw,
  and the output SHALL be deterministic for a given input.
- FR4.5 The dominant real cases — a named template with an OBJECT of values, and `null`
  `templateVariables` — SHALL be handled correctly.

### FR5 — Shared public message shaper

- FR5.1 A shared `shapePublicMessage(row)` SHALL be added (in a shared, non-route module,
  e.g. `src/lib/template-format.ts` or an equivalent lib file — NOT in a route file,
  since Next.js route modules may only export HTTP handlers) and used by BOTH the LIST
  route and the single `[id]` route.
- FR5.2 `shapePublicMessage` SHALL return exactly: `id`, `recipientPhone`, `templateId`,
  `templateName`, `status`, `metaMessageId`, `errorMessage`, `sentAt`, `deliveredAt`,
  `readAt`, `createdAt`, `direction`, `templateVariables` (NORMALIZED via
  `parseJsonColumn` to array | record | null), and OPTIONALLY a resolved body preview if
  cheap to compute.
- FR5.3 The single `GET /api/v1/messages/[id]` route SHALL be refactored to use
  `shapePublicMessage` WITHOUT changing its auth, isolation, or identical-404 behavior,
  and WITHOUT adding a try/catch wrapper (its current no-oracle structure is preserved).
  The route's Prisma `select` SHALL be widened to include the fields the shaper needs
  (`templateId`, `templateName` via the template relation, `direction`,
  `templateVariables`, and `template.body` only if the preview is included).

### FR6 — Third-party message LIST API (`GET /api/v1/messages`)

- FR6.1 A new `GET /api/v1/messages` handler SHALL be added alongside the existing `POST`
  in `src/app/api/v1/messages/route.ts`.
- FR6.2 Auth SHALL be API-key only, reusing `authenticateApiKey` and `unauthorized` from
  `src/lib/api-auth.ts`. A missing/invalid key SHALL return the standard 401.
- FR6.3 Every query SHALL be scoped to BOTH `ctx.userId` AND the key's bound number
  `ctx.number.id` — identical isolation to the single `[id]` route.
- FR6.4 The key and any path/query ids SHALL never be logged on any branch.
- FR6.5 Query parameters:
  - `?limit=` — default `50`, maximum `100`, parsed as a pinned integer (invalid or
    out-of-range values clamp to the bounds / default; non-integer input SHALL NOT crash).
  - `?status=` — one of `queued|sent|delivered|read|failed|received`; an unknown value
    SHALL be rejected or ignored per the design's chosen validation rule (design to pick;
    see AC).
  - `?since=<ISO 8601>` — validated with an ISO-8601 **shape regex** that ACCEPTS a
    timezone offset (e.g. `+05:30`) and seconds precision; it SHALL NOT use an over-strict
    round-trip comparison that rejects otherwise-valid timestamps. An invalid `since`
    SHALL return `400`.
  - `?after=<messageId>` — keyset cursor.
- FR6.6 Results SHALL be ordered by the COMPOUND key `[createdAt desc, id desc]` (the
  secondary `id` tiebreak is required for a stable keyset).
- FR6.7 The `?after` cursor SHALL be resolved into the compound `(createdAt, id)` boundary
  for the keyset `where`. A deleted/unknown cursor id SHALL cause the endpoint to return
  an **empty page** (`{ data: [], nextCursor: null, hasMore: false }`), NOT an error.
- FR6.8 The response envelope SHALL be `{ data: [...], nextCursor: string | null, hasMore:
  boolean }`, where each `data` element is produced by `shapePublicMessage`, `nextCursor`
  is the last row's `id` when a further page may exist (else `null`), and `hasMore`
  reflects whether more rows follow.
- FR6.9 The LIST and single routes SHALL return consistent per-message shapes (both via
  `shapePublicMessage`).

### FR7 — Developer documentation

- FR7.1 `src/app/docs/page.tsx` SHALL document `GET /api/v1/messages` (LIST): auth,
  `limit`/`status`/`since`/`after` parameters, ordering, the `{ data, nextCursor, hasMore }`
  envelope, and the per-message fields returned by `shapePublicMessage` (including the
  normalized `templateVariables` and, if present, the resolved body preview).
- FR7.2 The docs SHALL describe the **sync pattern**: how a third-party app lists
  messages, pages with `nextCursor`/`after`, and polls for live status so it can update
  its own records from where it initiated the message. The pattern SHALL also be
  documented in `/docs`.
- FR7.3 The single `GET /api/v1/messages/[id]` doc SHALL be updated to reflect any added
  fields (`templateName`, `direction`, normalized `templateVariables`, optional preview)
  if the refactor changes its response shape.

---

## Non-Functional Requirements

- NFR1 (Isolation) — Every data access SHALL enforce tenant isolation: session route by
  `session.user.id`; public routes by `ctx.userId` AND `ctx.number.id`. No cross-tenant
  or cross-number leakage.
- NFR2 (No secret leakage) — API keys, hashes, tokens, and raw path/query ids SHALL NOT
  be logged. The session route's explicit `select` SHALL NOT leak `userId`/FK columns to
  the browser.
- NFR3 (Purity / testability) — `resolveBodyPreview` and `shapePublicMessage` SHALL be
  pure and framework-free so they are unit-testable in isolation.
- NFR4 (No new dependencies) — The change SHALL add zero new npm dependencies and SHALL
  reuse existing helpers (`authenticateApiKey`, `unauthorized`, `parseTemplateBody`,
  `parseJsonColumn`). It SHALL NOT fork send logic.
- NFR5 (No schema change) — No Prisma schema change and no `db:push`. If a raw idempotent
  `@libsql` script is truly needed it MAY be added, but the keyset query is accepted to
  scan/sort given there is no `Message` index.
- NFR6 (TypeScript / App Router) — All handlers SHALL be TypeScript and SHALL return
  `NextResponse`.
- NFR7 (No regressions) — The change SHALL NOT regress: `POST /api/v1/messages` send,
  the single-status route, template routes, the authentication-template `(#131008)`
  button behavior, credits, superadmin, the webhook, or isolation.

---

## Acceptance Criteria

1. Expanding a dashboard history row reveals a detail panel showing template name,
   variable values, resolved body preview, recipient, direction, status, and
   `sentAt`/`deliveredAt`/`readAt` timestamps plus `errorMessage` when set; the table
   remains responsive.
2. For a message sent via a **named** template (object `templateVariables`), the detail
   preview shows the body with every `{{name}}` replaced by its stored value.
3. For a message with `null` `templateVariables`, the detail preview shows the body with
   ALL placeholders left intact and no runtime error.
4. For a **numbered** template (array `templateVariables`), `{{1}}..{{n}}` are replaced by
   `values[0..n-1]`.
5. `GET /api/messages` uses an explicit `select` (not `include`); its JSON response
   contains `template.body`, `templateVariables`, and `direction`, and contains NO
   `userId` or raw FK columns. The page consumes it via a pinned interface.
6. Status chips render distinctly for `queued`, `sent`, `delivered`, `read`, `failed`,
   and `received`, each with a valid `Badge` variant; `received` no longer falls through
   to the queued/default badge.
7. The dashboard "Sent" column precedence is `deliveredAt` > `readAt` > `sentAt`
   (verified unchanged); the manual Refresh button re-fetches and no new polling
   mechanism was added.
8. `resolveBodyPreview(body, values)` is pure and never throws for: array values, object
   values, `null`/`undefined` values, missing keys/indices, and extra keys/indices;
   output is deterministic.
9. `GET /api/v1/messages` with a valid key returns `{ data, nextCursor, hasMore }` where
   `data` is scoped to the key's `userId` AND `ctx.number.id` and ordered by
   `[createdAt desc, id desc]`.
10. `GET /api/v1/messages` with a missing/invalid key returns `401` via `unauthorized()`.
11. `?limit=` defaults to 50, caps at 100, parses as an integer, and tolerates
    invalid/non-integer input without crashing.
12. `?status=delivered` (and each other valid value) filters results to that status;
    an invalid status is handled per the design's documented rule without a 500.
13. `?since=2024-01-02T03:04:05+05:30` (offset + seconds) is ACCEPTED; a clearly invalid
    `since` returns `400`.
14. `?after=<lastId>` returns the next page using the compound `(createdAt, id)` keyset;
    `?after=<deleted-or-unknown-id>` returns an empty page `{ data: [], nextCursor: null,
    hasMore: false }` rather than an error.
15. The single `GET /api/v1/messages/{id}` and the LIST route return consistent per-row
    shapes (both via `shapePublicMessage`); `templateVariables` is normalized to
    array | record | null via `parseJsonColumn`.
16. The single `[id]` route retains its exact auth, cross-tenant/cross-number identical
    `404`, no-logging, and no-try/catch structure after the refactor.
17. `/docs` documents the LIST endpoint (auth, params, ordering, envelope, fields) and
    the live-status **sync pattern** for third-party apps.
18. No new npm dependency is added, no Prisma schema change / `db:push` occurs, and the
    existing POST send, single-status route, template routes, `(#131008)`, credits,
    superadmin, webhook, and isolation behaviors are unchanged (regression gate passes).

---

## Out of Scope

- Any change to the send core (`src/lib/send-template.ts`) or the already-completed
  `templateVariables` value-persistence fix.
- Adding a database index on `Message` or any Prisma schema migration / `db:push`.
- New real-time/push/polling infrastructure (websockets, SSE, new intervals).
- Webhook delivery-status write logic (unchanged; only read/display here).
- Changing API-key auth, credit, or superadmin models.
- Offset-based or page-number pagination (keyset only).
- Inbound-message content rendering beyond showing `direction` and existing fields.
