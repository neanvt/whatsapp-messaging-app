# Message History: status counts, status filter, and server-side pagination

Changes `GET /api/messages` from a flat array to a paginated object `{ messages, total, page, pageSize, totalPages, counts: { total, byStatus } }` and rewires the dashboard Message History page to drive filtering, searching, and pagination from the server. The route now parses `page`/`pageSize`/`status`/`search` query params and runs three `userId`-scoped Prisma queries in parallel: a paginated `findMany`, a `count` that respects the active status filter, and a `groupBy` over status that deliberately ignores the status filter so the summary tiles always show the full per-status breakdown for the current search. The page adds clickable status-count tiles that double as the status filter, a debounced search box, page-1 reset on filter/search change, and a 10s silent auto-refresh that preserves the current view via a ref.

Watch for: nothing blocking. One informational note on the scratchpad `Last updated` date being earlier than existing change-log entries (confirmed, spec-mandated).

**Verdict**: APPROVED

## High-level view

The API moved from "return everything, cap at 100" to a real paginated contract. The object shape is clean and every query carries the `userId` scope, so there is no cross-user leakage on the list, the paginated count, or the status group-by. The separation of concerns in the counts is the key design point and it is implemented correctly: `total`/`totalPages` reflect the active status filter and page, while `counts.total` and `counts.byStatus` reflect only `userId` + search, so the tiles don't collapse to a single bucket once a status is selected.

Search follows the existing SQLite-aware pattern — plain `contains` with no `mode: "insensitive"` — which the plan calls out explicitly and which matches the admin/users route. This is the right call for the Turso/libSQL connector; adding `mode` would be a compile error or no-op.

The page is now server-driven. State changes (filter, debounced search, page) recompute a `useCallback` whose identity drives a fetch effect; a separate effect resets to page 1 on filter/search change; and the auto-refresh reads the latest fetch function through a ref so its 10s interval always targets the current view without resubscribing. All the preserved UI (expandable rows, Send New Message, the "Updated HH:MM:SS" button, loading/empty states) is intact, and the empty state is now filter-aware.

Verification evidence is recorded in `plan.md`: `npx tsc --noEmit` clean, `npm run lint` clean (only pre-existing unrelated `exhaustive-deps` warnings), `npm run build` succeeds. No new dependencies; schema and webhook untouched.

<details>
<summary>Issues (1)</summary>

1. **Scratchpad `Last updated` predates existing entries** (informational, not blocking) — `Last updated: 2026-10-16` is older than the retained `2026-10-20` change-log entries above the new one. This is exactly what the task required, so no change is needed; flagged only so a future editor doesn't "correct" it by mistake.

</details>

<details>
<summary>Details</summary>

### Paginated object contract replaces the flat array

The route returns `{ messages, total, page, pageSize, totalPages, counts: { total, byStatus } }` and the page consumes it through a `MessagesResponse` interface that mirrors the shape field-for-field. A repo search confirms the dashboard page is the only consumer of `/api/messages`, so there are no flat-array leftovers anywhere else — the shape change is safe. `byStatus` is typed `Record<string, number>` on both sides; no `any` leaks into the public shape.

### Query param parsing and clamping

`page` parses via `parseInt`, defaults to 1 on `NaN`, and floors at 1 with `Math.max(1, parsedPage)`. `pageSize` defaults to 20 and clamps to `1..100` via `Math.min(MAX_PAGE_SIZE, Math.max(1, parsedPageSize))`. `status` is kept only when it is one of the six valid values (`queued/sent/delivered/read/failed/received`) via the `VALID_STATUSES` tuple, otherwise it falls through to `undefined` and is treated as "all". `search` is trimmed and empty strings collapse to `undefined`. The parsing is defensive against garbage input (`?page=abc`, `?pageSize=-5`, `?status=bogus`) without throwing.

### userId scoping and the counts split

The correctness crux. All three queries carry `userId`:

```
findMany: where { userId, ...searchFilter, ...statusFilter }
count:    where { userId, ...searchFilter, ...statusFilter }
groupBy:  where { userId, ...searchFilter }     // no statusFilter — intentional
```

The paginated `total` (and therefore `totalPages`) respects the active status filter, so the "Showing X–Y of Z" line and the Prev/Next bounds track the filtered set. `counts.byStatus` comes from the group-by that omits `statusFilter`, so selecting "Failed" does not zero out the other tiles — they keep the full breakdown for the current search. `counts.total` is summed from the group-by rather than a fourth query, staying consistent with `byStatus` by construction. No cross-user leakage on any path.

### Pagination math and the unclamped page ceiling

`totalPages = Math.max(1, Math.ceil(total / pageSize))`, so an empty result set reports 1 page rather than 0. `showingFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1` and `showingTo = Math.min(page * PAGE_SIZE, total)` read correctly at the last partial page and at zero results. The server clamps `page >= 1` but does not clamp `page` down to `totalPages`; the client disables Next at `page >= totalPages`, so an over-range page is only reachable by a hand-crafted URL, which yields an empty `findMany` page with still-correct `counts`. Not exploitable and not a UI concern.

### Search follows the SQLite-safe pattern

```ts
OR: [
  { recipientPhone: { contains: search } },
  { template: { name: { contains: search } } },
]
```

No `mode: "insensitive"`, matching the existing `admin/users` route (verified — that file has no `mode` usage). On the SQLite/libSQL connector `contains` is already ASCII case-insensitive, so this satisfies "case-insensitive where supported" without a connector error. The nested `template.name` relation filter is valid Prisma.

### Server-driven page: fetch, reset, and auto-refresh wiring

`fetchMessages` is a `useCallback` keyed on `[page, statusFilter, debouncedSearch]`; a fetch effect depends on that callback so any of the three changing triggers a refetch. A separate effect resets `page` to 1 on `[statusFilter, debouncedSearch]` change. The 10s auto-refresh stores the current `fetchMessages` in `fetchRef` and the interval calls `fetchRef.current(true)`, so it always hits the current page/filter/search and the interval is set up once without resubscribing — the fix for the "auto-refresh must not reset the view" requirement. Search is debounced ~350ms before it feeds `debouncedSearch`.

Behavioral detail (not a defect): changing a filter while on page > 1 fires both the page-reset effect and a callback-identity change. React coalesces the renders into a single fetch at page 1 with the new filter, so there is no duplicate request of consequence.

### UI preserved and filter-aware

The clickable tiles render an "All" tile bound to `counts.total` plus one tile per status in display order (Sent, Delivered, Read, Failed, Queued, Received), each showing `counts.byStatus[value] ?? 0`, reusing `getStatusBadge` for label colors and marking the active tile with `ring-2 ring-primary` plus `aria-pressed`. The empty state switches to "No Messages Found" / "No messages match this filter" when `hasActiveFilter` is set and keeps the original onboarding copy otherwise. Expandable row detail, the Send New Message button, and the "Updated HH:MM:SS" refresh button are unchanged. Pagination controls (Prev/Next disabled at bounds and while loading, "Page X of Y", "Showing X–Y of Z") sit in the table card footer.

### Scope and verification

No new dependencies; the Prisma schema and webhook logic are untouched (diff only spans the two app files plus `scratchpad.md` and the task plan). TypeScript is strict and the public response/consumer shapes avoid `any`. Verification evidence is recorded in `plan.md` and the commit message: `npx tsc --noEmit` exit 0, `npm run lint` clean apart from pre-existing unrelated `exhaustive-deps` warnings, and `npm run build` succeeds with both routes type-checking together. Per instructions these suites were not re-run; the recorded evidence is present and specific.

</details>

<details>
<summary>File map</summary>

- `src/app/api/messages/route.ts` — GET now takes `request`, parses page/pageSize/status/search, runs three userId-scoped queries (findMany + count + groupBy), returns the paginated object with counts.
- `src/app/dashboard/messages/page.tsx` — server-driven fetching, debounced search, clickable status tiles as filter, page-1 reset on filter/search, bottom pagination controls, ref-based 10s auto-refresh; removed client-side `filteredMessages`.
- `scratchpad.md` — `Last updated` set to 2026-10-16, `/api/messages` endpoint row + Message History section updated, newest-first change-log entry prepended.
- Full diff: `git diff HEAD~1 HEAD` (commit 2789830).

</details>
