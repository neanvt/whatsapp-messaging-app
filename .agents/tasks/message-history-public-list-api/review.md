# Message history/detail visibility + third-party message-list API

Adds "what was actually sent + live delivery status" visibility across three surfaces with no schema change and no new dependency: a pure `resolveBodyPreview` helper that fills `{{name}}`/`{{n}}` placeholders from stored variable values, a shared `shapePublicMessage` shaper used by both public message routes, a new keyset-paginated public `GET /api/v1/messages` LIST endpoint, a widened session `GET /api/messages`, and a dashboard expandable detail panel with distinct live-status chips. The change reuses existing auth, isolation, and JSON-parsing primitives rather than forking the send path. Verification evidence (build exit 0, lint exit 0, 16/16 harness pass, isolation proof) is recorded in the commit message `ec35d8a`.

Watch for: nothing blocking. The implementation tracks the approved design line-for-line; the few judgment calls (null-value coercion in the preview, scalar collapse in the shaper) match the design's stated contract. (confirmed)

**Verdict**: APPROVED

## High-level view

The preview helper is pure and non-throwing: it normalizes `templateVariables` once into a single `values` binding (`string[] | Record | null`), classifies the body with the existing `parseTemplateBody`, and substitutes with a fresh (non-stateful) regex. An inline try/catch replicates `parseJsonColumn` so no circular import back into `template-format.ts` is introduced. All three stored shapes (array, record, null) resolve correctly and any unresolved placeholder is left intact.

The shared shaper collapses the parsed column to `array | record | null` with the identical rule the helper uses, then returns the superset shape (adds `templateName`, `direction`, normalized `templateVariables`, `bodyPreview`) without ever leaking the raw `template` object or `template.body`. Both public routes feed the same `select` into it, so their payloads cannot drift.

The public LIST endpoint is scoped to `userId` AND `whatsappNumberId` on every query — including the `after` anchor lookup — with a compound `[createdAt desc, id desc]` order matching its keyset predicate. An unknown, deleted, or cross-tenant cursor returns an empty page rather than a 404, preserving the no-existence-oracle property. `limit`/`status`/`since` validate before the DB touch, and the `since` validator accepts both `Z` and `±HH:mm` offset ISO 8601 forms.

The session route moved from `include` to an explicit `select`, which stops shipping `userId`/`whatsappNumberId`/`conversationId`/`metaMessageId` to the browser while adding the four fields the detail view needs. The dashboard interface mirrors that select field-for-field, renders all six statuses as distinct chips, and keeps the "Sent" column's `delivered > read > sent` precedence untouched. The `[id]` route gained no try/catch and kept its auth/isolation/404.

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking issues found. The diff matches the approved design and plan on every verification point.

</details>

<details>
<summary>Details</summary>

### Preview helper purity and the single `values` binding

`resolveBodyPreview` short-circuits `!body` to `""`, binds the normalized values once to `values`, and references only `values` afterward — the retired `parsed`/`arr` names do not reappear. The string branch parses inside a two-line try/catch (catch → `null`) rather than importing `parseJsonColumn`, which would create a circular import since `template-format.ts` imports this module; the behavior is identical. The collapse rule (`Array.isArray` → array, non-null object → record, else null) is byte-for-byte the same rule the shaper applies, so the two can never disagree. Substitution uses a fresh `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g` literal rather than a reused module-level stateful regex. The numbered branch resolves only against an array in range; the named branch handles record (key lookup), positional array (declared-order via `model.names.indexOf`), and null (every `{{name}}` intact). The callback returns the original match for both `undefined` and `null` lookups and coerces any defined value with `String(value)` — the `null` guard is correct because a stored null means "no value", so leaving the placeholder intact is the right behavior. No throw path exists on any branch. (confirmed)

### Shared shaper and route consistency

`shapePublicMessage` normalizes the `unknown` from `parseJsonColumn` to `array | record | null` before both returning `templateVariables` and feeding `resolveBodyPreview`, so a legacy JSON scalar can never leak under the documented type. It returns `templateName` from `template?.name ?? null` and `bodyPreview` from the normalized `vars`, and never returns the raw `template` object or `template.body`. Both `GET /api/v1/messages` and `GET /api/v1/messages/[id]` select the identical column set (`id, recipientPhone, templateId, status, metaMessageId, errorMessage, sentAt, deliveredAt, readAt, createdAt, direction, templateVariables, template{name,body}`) and map through the same shaper, pinning their shapes together. (confirmed)

### LIST isolation, pagination, and validation

Every query carries `userId: ctx.userId` AND `whatsappNumberId: ctx.number.id`; `status`, `since`, and the keyset `OR` are additive and never drop a scope clause. The `after` anchor is resolved with a scoped `findFirst`, and a miss (unknown/deleted/cross-tenant) returns `{ data: [], nextCursor: null, hasMore: false }` with no 404 — same no-oracle path as the single route. The query uses `orderBy: [{ createdAt: "desc" }, { id: "desc" }]`, exactly matching the keyset predicate `[{ createdAt: { lt } }, { createdAt, id: { lt } }]`, so no rows are skipped or duplicated at millisecond ties. `take: limit + 1` drives `hasMore`/`nextCursor` off `page[page.length - 1].id`. `limit` honors only positive integers (clamped to 100, else 50); unknown `status` and malformed `since` both 400 before the DB touch; `ISO_RE` accepts `Z` and `±HH:mm` offsets with optional fractional seconds. The try/catch logs `"Error listing public messages:"` with the error only — no request, key, or id. (confirmed)

### `[id]` route and session route

The `[id]` route added only the import, the widened select, and the `shapePublicMessage(message)` wrap — no try/catch, and its scoped `findFirst`, identical-404, and no-path-id-logging are unchanged. The session route switched `include` → explicit `select`, which removes `userId`/`whatsappNumberId`/`conversationId`/`metaMessageId` from the browser payload and adds `direction`/`templateVariables`/`content`/`template.body`; `where userId`, `orderBy`, `take 100`, 401 branch, and `try/catch → 500` are intact. The dashboard `Message` interface matches the new select field-for-field with no FK fields. (confirmed)

### Non-regression surface

The POST send handler in `src/app/api/v1/messages/route.ts` is byte-identical to its pre-commit form (diff of the handler region shows zero changes), so its Zod body, template resolution, superadmin computation, credit logic, and `sendTemplateMessage` call are untouched. `send-template.ts` (which owns `#131008`/OTP and credits) and the webhook route are not in the diff. No `package.json` change (zero new deps) and no `prisma/schema.prisma` change. The dashboard chip map renders all six statuses (`queued/outline`, `sent/secondary`, `delivered/success`, `read/default`, `failed/destructive`, `received/warning`) with distinct variants and leaves the "Sent" timestamp column's `delivered > read > sent` precedence untouched. (confirmed)

### Verification evidence and tree state

The commit message records `npm run build` exit 0, `npm run lint` exit 0, `node scripts/test-resolve-body-preview.mjs` 16/16 pass, and the LIST isolation proof (both queries scoped, cursor scope-checked before use). The commit `ec35d8a` was made and not pushed (branch ahead of `origin/main` by 2). The working tree is clean apart from the untracked `.agents/tasks/` directory; the temp scripts convention file (`scripts/test-resolve-body-preview.mjs`) is intentionally committed per the plan, and no stray scratch files remain. The commit touches exactly the nine planned files. (confirmed)

</details>

<details>
<summary>File map</summary>

- `src/lib/template-params.ts` — new pure `resolveBodyPreview` export.
- `src/lib/template-format.ts` — new `shapePublicMessage` + `PublicMessageRow`.
- `src/app/api/v1/messages/route.ts` — new `GET` LIST handler; POST byte-unchanged.
- `src/app/api/v1/messages/[id]/route.ts` — widened select, routed through shaper; no try/catch added.
- `src/app/api/messages/route.ts` — `include` → explicit `select` (no FK/userId leak).
- `src/app/dashboard/messages/page.tsx` — expandable detail panel + distinct status chips.
- `src/app/docs/page.tsx` — LIST block, superset single-route example, live-status sync pattern.
- `scratchpad.md` — updated backend/API section + dated change-log entry.
- `scripts/test-resolve-body-preview.mjs` — standalone harness (16 cases).

Full diff: `git show ec35d8a`.

</details>
