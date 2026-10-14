# Implementation Plan — Message history/detail visibility + third-party message-list API

Derived from `design.md` / `requirements.md` in this folder. Implement in place on
`main` (no worktree). Commit once at the very end; do not push. Every item leaves the
tree buildable. Order is by dependency: pure helpers first, then the shaper that
reuses them, then the routes, then the UI, then docs/scratchpad.

Global constraints (hold for every item): TypeScript App Router handlers return
`NextResponse`; per-tenant + per-key isolation (session: `session.user.id`; public:
`ctx.userId` + `ctx.number.id`); never log secrets/keys or raw path/query ids; reuse
existing helpers (`authenticateApiKey`, `unauthorized`, `parseTemplateBody`,
`parseJsonColumn`) and do NOT fork send logic; zero new npm deps; no Prisma schema
change / no `db:push`.

Verification commands discovered in `package.json`: build is `npm run build`
(`prisma generate && next build` — this type-checks the real modules and every
consumer, the authoritative gate), lint is `npm run lint` (`next lint`). The
`scripts/*.mjs` convention (see `scripts/test-template-params.mjs`) is a standalone
Node harness that MIRRORS the pure logic inline using only `node:assert/strict` — no
`@/` import, no TS loader, no new dep — run with `node scripts/<file>.mjs`.

---

- [ ] 1. Add the pure `resolveBodyPreview(body, templateVariables)` export to `src/lib/template-params.ts`.
      Signature per design §1: `(body: string | null | undefined, templateVariables: string | string[] | Record<string,string> | null | undefined): string`.
      Behavior (never throws, no DB/network): if `!body` return `""`; normalize
      `templateVariables` ONCE to a value bound to `values` of type `string[] | Record<string,string> | null`
      — if it is a string, parse with an INLINE two-line try/catch (replicate
      `parseJsonColumn`'s contract; do NOT import `parseJsonColumn` here, that would
      create a circular import since `template-format.ts` imports this module), then
      collapse: `Array.isArray` → array, non-null `object` → record, anything else
      (scalar/undefined/null/malformed) → `null`; if it is already an array/plain
      object, use it directly. Classify the body with the existing `parseTemplateBody(body)`.
      Substitute with a FRESH regex literal `body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, cb)`
      (do NOT reuse the module-level stateful `PLACEHOLDER_RE`). In the callback:
      `kind==="none"` → return body unchanged; `kind==="numbered"` → token `{{k}}` →
      `String(values[k-1])` only when `values` is an array and `k-1` is in range, else
      leave the match intact; `kind==="named"` → if `values` is a record →
      `values[name]` (leave intact when key absent), if `values` is `null` → leave all
      `{{name}}` intact, if `values` is an array → map by `model.names` declared order
      (`name` at position `i` → `values[i]`), out of range → leave intact. Any
      undefined lookup returns the original matched placeholder; a defined non-string
      value is coerced with `String(value)`.
      Files: src/lib/template-params.ts
      Verify: `npm run build` passes (type-checks the new export). `npm run lint` clean.

- [ ] 2. Add the `scripts/test-resolve-body-preview.mjs` standalone harness for `resolveBodyPreview`.
      Follow the `scripts/test-template-params.mjs` convention exactly: mirror the
      `parseTemplateBody` + `resolveBodyPreview` logic inline (Node built-ins only,
      `node:assert/strict`, no `@/` import, no new dep), with a header comment noting
      the mirror must stay in sync and that `npm run build`/`npm run lint` are the
      authoritative gate. Cover every edge from design §1's table: null/empty body →
      `""`; body with no placeholders → unchanged; named body + record values → each
      `{{name}}` replaced (AC2); named body + null values → all `{{name}}` intact, no
      throw (AC3); numbered body + array values → `{{k}}` → `values[k-1]` in range
      (AC4); numbered body + record → nothing resolves; missing key/index → placeholder
      intact; malformed JSON string → treated as null; extra values ignored (AC5);
      non-string value coerced via `String`; named body + positional array mapped by
      declared order. Assert determinism (same input → same output).
      Files: scripts/test-resolve-body-preview.mjs
      Verify: `node scripts/test-resolve-body-preview.mjs` prints all tests passed and
      exits 0.

- [ ] 3. Add the shared `shapePublicMessage(row)` shaper (and its `PublicMessageRow` interface) to `src/lib/template-format.ts`.
      Import `resolveBodyPreview` from `@/lib/template-params` (non-circular —
      `template-format.ts` already imports from `template-params.ts`). Define and export
      `interface PublicMessageRow` with fields: `id`, `recipientPhone`, `templateId:
      string | null`, `status`, `metaMessageId: string | null`, `errorMessage: string |
      null`, `sentAt/deliveredAt/readAt: Date | null`, `createdAt: Date`, `direction:
      string`, `templateVariables: string | null`, `template: { name: string; body:
      string | null } | null`. In `shapePublicMessage`: call the module-local
      `parseJsonColumn(m.templateVariables)` (same file — no import), NORMALIZE the
      `unknown` result to `string[] | Record<string,string> | null` with the exact same
      collapse rule as item 1 (array / non-null object / else null — do NOT cast raw),
      bind it to `vars`, and return exactly: `id`, `recipientPhone`, `templateId`,
      `templateName: m.template?.name ?? null`, `status`, `metaMessageId`,
      `errorMessage`, `sentAt`, `deliveredAt`, `readAt`, `createdAt`, `direction`,
      `templateVariables: vars`, `bodyPreview: resolveBodyPreview(m.template?.body, vars)`.
      Do NOT return the raw `template` object or `template.body`.
      Files: src/lib/template-format.ts
      Verify: `npm run build` passes. `npm run lint` clean.

- [ ] 4. Refactor `GET /api/v1/messages/[id]` to widen its `select` and return `shapePublicMessage(message)`.
      In `src/app/api/v1/messages/[id]/route.ts` keep `authenticateApiKey` →
      `unauthorized()`, the scoped `findFirst({ where: { id: params.id, userId:
      ctx.userId, whatsappNumberId: ctx.number.id } })`, the identical `404 { error:
      "Not found" }` (no existence oracle), and the "path id never logged" behavior
      UNCHANGED. Do NOT add a try/catch. Only two changes: (a) widen `select` to the
      unified set — add `templateId: true`, `direction: true`, `templateVariables:
      true`, and `template: { select: { name: true, body: true } }` to the existing
      scalar selections; (b) replace `return NextResponse.json(message)` with `return
      NextResponse.json(shapePublicMessage(message))` (import `shapePublicMessage` from
      `@/lib/template-format`). The returned shape becomes a back-compatible superset
      (gains `templateId`, `templateName`, `direction`, normalized `templateVariables`,
      `bodyPreview`).
      Files: src/app/api/v1/messages/[id]/route.ts
      Verify: `npm run build` passes. `npm run lint` clean.

- [ ] 5. Add the `GET /api/v1/messages` LIST handler alongside the existing `POST` in `src/app/api/v1/messages/route.ts`.
      Do NOT touch the existing `POST`, its `Body` zod schema, template resolution,
      superadmin computation, or the `sendTemplateMessage` call. Add local,
      NON-exported declarations in this file: `KNOWN_STATUS = ["queued","sent",
      "delivered","read","failed"] as const` (note: `received` is deliberately NOT a
      valid filter value — it can still appear in unfiltered results), `ISO_RE =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/`, and
      `parseSince(s): Date | null` (return null unless `ISO_RE.test(s)` and `new
      Date(s)` is valid). Add `export async function GET(request: Request)`:
      authenticate with `authenticateApiKey(request)`, `unauthorized()` on null; parse
      `new URL(request.url)` params. `limit`: `const n = Number(raw); const limit =
      Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 50;`. `status`: if present and
      not in `KNOWN_STATUS` return `400 { error: "Invalid status. Allowed: ..." }`.
      `since`: if present and `parseSince` returns null, return `400 { error: "Invalid
      'since' timestamp; expected an ISO 8601 instant ..." }`. Build the `where` always
      scoped to BOTH `userId: ctx.userId` AND `whatsappNumberId: ctx.number.id`, plus
      optional `status` and `createdAt: { gt: since }`. For `after`: do a scoped
      `findFirst({ where: { id: after, userId, whatsappNumberId }, select: { createdAt:
      true, id: true } })`; if not found return the empty page `{ data: [], nextCursor:
      null, hasMore: false }` (no 404, no oracle); if found add the keyset
      `OR: [{ createdAt: { lt: cAt } }, { createdAt: cAt, id: { lt: cId } }]`. Query:
      `findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit +
      1, select: <unified set incl. template{name,body}> })` — the compound `orderBy` is
      REQUIRED (never `createdAt` alone). Over-fetch handling: if `rows.length > limit`,
      slice to `limit`, `nextCursor = rows[limit-1].id`, `hasMore = true`; else
      `nextCursor = null`, `hasMore = false`. Map each row through
      `shapePublicMessage`. Return `NextResponse.json({ data, nextCursor, hasMore })`.
      Wrap the body in a `try/catch` logging `console.error("Error listing public
      messages:", error)` (NO request object, NO key, NO id) → `500 { error: "Internal
      server error" }`.
      Files: src/app/api/v1/messages/route.ts
      Verify: `npm run build` passes. `npm run lint` clean. Also sanity-check the POST
      is byte-unchanged (git diff shows only additions).

- [ ] 6. Widen the session `GET /api/messages` from `include` to an explicit `select`.
      In `src/app/api/messages/route.ts` keep the `getServerSession` 401 branch, the
      `where: { userId: session.user.id }`, `orderBy: { createdAt: "desc" }`, `take:
      100`, and the existing `try/catch → 500` UNCHANGED. Replace the `include` with an
      explicit `select` returning only: `id`, `recipientPhone`, `status`, `direction`,
      `templateVariables`, `errorMessage`, `content`, `sentAt`, `deliveredAt`, `readAt`,
      `createdAt`, `template: { select: { name: true, body: true } }`, `whatsappNumber:
      { select: { phoneNumber: true } }`. This stops leaking `userId`,
      `whatsappNumberId`, `conversationId`, `metaMessageId` to the browser while adding
      `direction`, `templateVariables`, `content`, and `template.body` for the detail
      view. `templateVariables` is returned RAW (parsed client-side).
      Files: src/app/api/messages/route.ts
      Verify: `npm run build` passes. `npm run lint` clean.

- [ ] 7. Enhance the dashboard history page: pinned interface, status chips, expandable detail row.
      In `src/app/dashboard/messages/page.tsx` rewrite the client `Message` interface to
      match the item-6 `select` field-for-field: `id`, `recipientPhone`, `status`,
      `direction`, `templateVariables: string | null`, `errorMessage: string | null`,
      `content: string | null`, `sentAt/deliveredAt/readAt: string | null`, `createdAt:
      string`, `template: { name: string; body: string | null } | null`,
      `whatsappNumber: { phoneNumber: string } | null` (NO userId/FK fields). Replace
      `getStatusBadge` with the distinct 6-state map: `queued`→`outline` "Queued",
      `sent`→`secondary` "Sent", `delivered`→`success` "Delivered", `read`→`default`
      "Read", `failed`→`destructive` "Failed", `received`→`warning` "Received" (all are
      valid `badge.tsx` variants; do NOT edit `badge.tsx`). Leave the "Sent" timestamp
      column EXACTLY as-is (`deliveredAt` > `readAt` > `sentAt` precedence — do not
      reorder). Leave the manual Refresh button and the 10s `setInterval` as-is (no new
      polling). Add `const [expandedId, setExpandedId] = useState<string | null>(null)`,
      add a leading chevron column (`ChevronRight`/`ChevronDown` from `lucide-react`) to
      the `<thead>` and each row to toggle `expandedId`; when expanded, render a second
      `<tr>` with a single `<td colSpan={6}>` holding a muted detail panel showing:
      template name (or "Free-text / inbound" when `template === null`), direction,
      status badge, `sentAt`/`deliveredAt`/`readAt`, `errorMessage` (destructive color,
      only when set), variable values parsed via a local `safeParse` (try/catch → null)
      rendered as index→value (array) or name→value (object) or nothing (null), a
      resolved body preview from `resolveBodyPreview(message.template?.body,
      message.templateVariables)` (import from `@/lib/template-params`) in a wrapped
      `<pre>`/block, and the `content` fallback when `template === null`. Keep the
      existing search filter working (guard `m.template?.name`).
      Files: src/app/dashboard/messages/page.tsx
      Verify: `npm run build` passes. `npm run lint` clean.

- [ ] 8. Update developer docs in `src/app/docs/page.tsx`.
      In section 6, AFTER the existing `GET /api/v1/messages/[id]` block, add a new
      `GET /api/v1/messages` (LIST) block using the existing `Method`/`CodeBlock`
      helpers, documenting: auth (Bearer, owner+number scoped); params — `limit`
      (default 50, max 100, clamped; non-integer/non-positive → 50), `status` (filter
      accepts only `sent|delivered|read|failed|queued`, 400 on unknown), `since` (ISO
      8601 instant with `Z` or `±HH:mm` offset, fractional seconds optional, examples
      `2026-10-13T12:00:00.000Z` and `2026-10-13T12:00:00+05:30`; filters `createdAt`
      strictly after; 400 on invalid), `after` (keyset cursor; unknown/deleted →
      empty page); ordering `createdAt desc`; the `{ data, nextCursor, hasMore }`
      envelope and how to page with `?after=<nextCursor>`; the per-item field list from
      design §3.6 (incl. normalized `templateVariables` and `bodyPreview`), noting that
      returned `status` may also be `received` on inbound rows though it can't be
      filtered for; an example `curl` and example 200 list response. Update the existing
      `GET /api/v1/messages/[id]` 200 example to the superset shape (add `templateId`,
      `templateName`, `direction`, `templateVariables`, `bodyPreview`). Add a short
      "Live-status sync pattern" subsection: store the POST-returned `id`, poll the
      single route or `?since=<lastSync>` then page with `after`, reconcile
      `delivered`/`read`/`failed` + timestamps/`errorMessage`. Update `const lastUpdated`
      to the change date keeping the `"Month D, YYYY"` string format.
      Files: src/app/docs/page.tsx
      Verify: `npm run build` passes. `npm run lint` clean.

- [ ] 9. Update the root `scratchpad.md`.
      In the same change, refresh `Last updated: YYYY-MM-DD` near the top and prepend a
      newest-first Change log entry. In the backend/API section add `GET
      /api/v1/messages` (API-key auth, owner+number scoped, `limit`/`status`/`since`/
      `after`, `{ data, nextCursor, hasMore }` envelope) and note the single-status
      route's widened consistent shape. Note the new `resolveBodyPreview` helper in
      `src/lib/template-params.ts` and `shapePublicMessage` in
      `src/lib/template-format.ts`, the enhanced session `GET /api/messages` fields
      (now explicit `select`, adds `direction`/`templateVariables`/`content`/
      `template.body`), and the dashboard expandable detail view + live-status chips.
      No secrets.
      Files: scratchpad.md
      Verify: `npm run build` passes (docs/scratchpad are not compiled, but run the gate
      to confirm nothing regressed). `npm run lint` clean.

- [ ] 10. Full regression gate + commit.
      Run the full gate once: `npm run build`, `npm run lint`, and `node
      scripts/test-resolve-body-preview.mjs`. Confirm no regression to the explicit
      non-regression surface (POST send, single-status route, template routes, `#131008`
      handling, credits, superadmin, webhook, isolation) — these files are read-only in
      this change; `git diff --stat` should show changes ONLY in: src/lib/template-params.ts,
      scripts/test-resolve-body-preview.mjs, src/lib/template-format.ts,
      src/app/api/v1/messages/[id]/route.ts, src/app/api/v1/messages/route.ts,
      src/app/api/messages/route.ts, src/app/dashboard/messages/page.tsx,
      src/app/docs/page.tsx, scratchpad.md. Remove any scratch files. Stage those files
      by name and create a single commit; do NOT push.
      Files: (none new) — repository commit.
      Verify: `npm run build` and `npm run lint` both pass; `node
      scripts/test-resolve-body-preview.mjs` exits 0; `git status` clean after commit.

---

## Notes / assumptions

- No test runner (vitest/jest) is configured; the `scripts/*.mjs` harness plus `npm run
  build`/`npm run lint` are the regression gate, matching the repo convention.
- No Prisma schema change and no `db:push`: all `Message` fields used already exist
  (verified in `prisma/schema.prisma`). The keyset query accepts a scan/sort since
  `Message` has no `@@index`; adding one is explicitly out of scope.
- The `template.body` field is selected for the public routes only to compute
  `bodyPreview`; it is not returned in the public payload.
- `received` is intentionally excluded from the public `status` FILTER allow-list but
  may still be returned on inbound rows — documented in item 8.
