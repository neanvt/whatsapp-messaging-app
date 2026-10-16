# Implementation Plan — Message History: status counts, status filter, pagination

## Context & design decisions (grounded in the code)

- **Stack:** Next.js 14 App Router, TypeScript strict, Prisma 5 on **SQLite via Turso/libSQL** (`datasource db { provider = "sqlite" }`). UI is shadcn-style (`@/components/ui/*`) + Tailwind + `lucide-react`. No new deps allowed and none needed.
- **Two files change** plus the repo `scratchpad.md` doc (global rule). No worktree; edit the repo directly.
- **SQLite case-insensitivity caveat (important):** the Prisma SQLite connector does **not** support `mode: "insensitive"` on string filters. SQLite `LIKE`/`contains` is already case-insensitive for ASCII. The existing search in `src/app/api/admin/users/route.ts` uses plain `{ contains: search }` with no `mode` — follow that exact pattern. Do **not** add `mode: "insensitive"` (it would be a type/compile error or no-op).
- **Status values** (schema comment on `Message.status`): `queued, sent, delivered, read, failed, received`. Default `queued`. These are the valid filter values; display order for tiles: Sent, Delivered, Read, Failed, Queued, Received.
- **Verification:** `package.json` has no `typecheck` script. Use `npx tsc --noEmit` (tsconfig already `strict` + `noEmit`), `npm run lint` (`next lint`), and `npm run build` (`prisma generate && next build`). Non-watch forms. The build is the strongest gate; run `tsc` + `lint` first for fast feedback.

### New API response shape (object, replaces flat array)

```ts
{
  messages: Message[];          // current page, same select projection as today
  total: number;                // count of messages matching userId + search + status filter
  page: number;                 // 1-based, echoed back (clamped)
  pageSize: number;             // echoed back (clamped 1..100)
  totalPages: number;           // Math.max(1, Math.ceil(total / pageSize))
  counts: {
    total: number;              // count matching userId + search ONLY (ignores status filter)
    byStatus: Record<string, number>; // userId + search ONLY, keyed by status value
  };
}
```

### Prisma query strategy (ALL userId-scoped)

- `searchFilter` = search term present
  ? `{ OR: [ { recipientPhone: { contains: search } }, { template: { name: { contains: search } } } ] }`
  : `{}`  (nested relation filter `template.name` is valid Prisma; no `mode`).
- `statusFilter` = valid status present ? `{ status }` : `{}`.
- **List:** `findMany({ where: { userId, ...searchFilter, ...statusFilter }, select: <unchanged>, orderBy: { createdAt: 'desc' }, skip: (page-1)*pageSize, take: pageSize })`.
- **Paginated total:** `count({ where: { userId, ...searchFilter, ...statusFilter } })` — respects status filter.
- **counts.byStatus:** `groupBy({ by: ['status'], where: { userId, ...searchFilter }, _count: true })` — ignores status filter; map result rows to `Record<string, number>`.
- **counts.total:** `count({ where: { userId, ...searchFilter } })` — ignores status filter. (Can also be derived by summing `byStatus`, but a dedicated count is clearer; either is acceptable — prefer summing the groupBy to save a query.)
- Run the independent queries with `Promise.all` for one round-trip's worth of latency.
- `_count: true` on `groupBy` returns a `number` on `_count`; read `row._count` as the count per status.

---

## Plan

- [ ] 1. Rewrite the API route to parse query params, run the four userId-scoped queries, and return the new object shape.
      Replace `export async function GET()` with `GET(request: Request)`. Parse `new URL(request.url).searchParams`: `page` (parseInt, default 1, floor at 1), `pageSize` (parseInt, default 20, clamp 1..100), `status` (keep only if it is one of the six valid values via a `const VALID_STATUSES = [...] as const` set/array; else treat as "all"), `search` (trim; empty → undefined). Build `searchFilter` and `statusFilter` as above. `Promise.all([findMany(...skip/take), count(where userId+search+status), groupBy(by status, where userId+search)])`. Keep the existing `select` projection and `orderBy: { createdAt: 'desc' }` verbatim. Build `byStatus` by reducing groupBy rows (`acc[row.status] = row._count`); derive `counts.total` by summing those values. Compute `totalPages = Math.max(1, Math.ceil(total / pageSize))`. Preserve: `getServerSession(authOptions)` → 401 when no `session.user.id`; `try/catch` → 500 with the same `console.error`. Return `NextResponse.json({ messages, total, page, pageSize, totalPages, counts: { total, byStatus } })`.
      Files: `src/app/api/messages/route.ts`
      Verify: `npx tsc --noEmit` passes (route compiles, no `any` in the returned shape); later confirmed end-to-end by `npm run build` in step 4.

- [ ] 2. Update the messages page data layer: new response type, server-driven state, query-string builder, debounced search, filter + pagination state, and auto-refresh that preserves the current view.
      In `src/app/dashboard/messages/page.tsx`: keep `"use client"` and the existing `Message` interface (unchanged — projection is the same). Add a `MessagesResponse` interface matching step 1's object shape (`messages`, `total`, `page`, `pageSize`, `totalPages`, `counts: { total: number; byStatus: Record<string, number> }`). Add state: `statusFilter: string` (default `"all"`), `page: number` (default 1), `pageSize` constant (20), plus `total`, `totalPages`, `counts` (default `{ total: 0, byStatus: {} }`), and keep `search`, `loading`, `refreshing`, `lastUpdated`, `expandedId`, `messages`. Add a `debouncedSearch` state updated from `search` via a `useEffect` with `setTimeout` (~350ms, cleared on change). Rewrite `fetchMessages(silent)` to build a query string from `page`, `statusFilter` (omit when `"all"`), and `debouncedSearch` (omit when empty) using `URLSearchParams`, fetch, parse the object, and set `messages/total/totalPages/counts/lastUpdated`. Replace the mount `useEffect` so the 10s interval calls `fetchMessages(true)` (silent) against the CURRENT `page`/`statusFilter`/`debouncedSearch` — include those three in the effect deps (or read from refs) so the interval always targets the current view and resubscribes when they change. Add a `useEffect([statusFilter, debouncedSearch])` that resets `page` to 1. Add a `useEffect([page, statusFilter, debouncedSearch])` that calls `fetchMessages()`. Remove the old client-side `filteredMessages` array (filtering/searching now happens server-side) and render `messages` directly.
      Files: `src/app/dashboard/messages/page.tsx`
      Verify: `npx tsc --noEmit` passes; confirmed in `npm run build` (step 4).

- [ ] 3. Update the messages page UI: clickable status summary tiles (that double as filters), adjusted empty state, and bottom pagination controls — reusing existing Card/Badge and `getStatusBadge` colors.
      In the same file, above the search Card, render a responsive grid of summary tiles using `Card`: one "All / Total" tile (shows `counts.total`) plus one tile per status in display order Sent, Delivered, Read, Failed, Queued, Received (label + `counts.byStatus[status] ?? 0`). Each tile is a `button`/clickable Card that sets `statusFilter` to that status (or `"all"`); mark the active tile (e.g. `ring-2 ring-primary` / border highlight) and reuse `getStatusBadge`'s variant colors for visual consistency (use the same Badge for the tile's label). Keep the free-text search Input working (now feeding `debouncedSearch`). Update the empty state: when `statusFilter !== "all"` or `search` is set, show "No messages match this filter" and keep the existing "No Messages Yet" copy only when there is no active filter/search. Keep the expandable row detail, "Send New Message" button, and the "Updated HH:MM:SS" refresh button behavior exactly as they are. Add pagination controls at the bottom of the table Card: Previous/Next buttons (reuse `Button variant="outline" size="sm"`; `disabled` when `page <= 1` / `page >= totalPages` or while `loading`), a current page indicator (`Page {page} of {totalPages}`), and a "Showing X–Y of Z" line where `X = total === 0 ? 0 : (page-1)*pageSize + 1`, `Y = Math.min(page*pageSize, total)`, `Z = total`. Prev/Next adjust `page` (the step-2 effect refetches).
      Files: `src/app/dashboard/messages/page.tsx`
      Verify: `npm run lint` passes (no unused vars from the removed `filteredMessages`, no a11y/eslint complaints); visual behavior confirmed by `npm run build` (step 4).

- [ ] 4. Full build gate.
      Run the project's real build to confirm both files compile, Prisma client generates, and Next.js type-checks the route + page together.
      Files: none (verification only)
      Verify: `npx tsc --noEmit` → no errors; `npm run lint` → no errors; `npm run build` → completes successfully (`prisma generate && next build`), no type errors on `/api/messages` or `/dashboard/messages`.

- [ ] 5. Update `scratchpad.md` (global scratchpad rule).
      Refresh the `Last updated: YYYY-MM-DD`, update the description of the `GET /api/messages` endpoint (now paginated object with counts/filter/search params) and the Message History page (counts tiles, status filter, pagination), and prepend a dated "Change log" entry summarizing: added status counts + clickable status filter + server-side pagination/search to Message History; changed `/api/messages` response from flat array to `{ messages, total, page, pageSize, totalPages, counts }`. Keep it accurate to the final code; reference config by key name only (no secrets).
      Files: `scratchpad.md`
      Verify: re-read the changed sections and confirm they match the final `route.ts` response shape and the page's controls (manual read; no build impact).

## Verification note (implementation, 2026-10-16)

Ran from the repo root:

- `npx tsc --noEmit` → **exit 0**, no errors.
- `npm run lint` (`next lint`) → **exit 0**; only pre-existing `react-hooks/
  exhaustive-deps` warnings in unrelated files (`dashboard/numbers/[id]/page.tsx`,
  `dashboard/templates/[id]/page.tsx`). No new warnings/errors from the two
  changed files.
- `npm run build` (`prisma generate && next build`) → **succeeds**; `/api/messages`
  and `/dashboard/messages` both compile and type-check together.

Implemented: API route returns the new object shape with pagination + counts +
status/search filters (all `userId`-scoped); page is server-driven with clickable
status-count tiles that double as the filter, debounced search, page-1 reset on
filter/search change, bottom Previous/Next + "Showing X–Y of Z" controls, and a
10s silent auto-refresh that preserves the current view. No schema change, no new
dependency.

## Gotchas for the implementer

- Do **not** add `mode: "insensitive"` anywhere — SQLite connector rejects it; `contains` is already ASCII-insensitive (matches the existing admin/users search).
- Keep the `select` projection and `orderBy` in the route byte-for-byte as today so the `Message` interface on the page stays valid.
- The flat-array consumer is **only** this page; after step 2 nothing else reads `/api/messages` as an array (verified by repo search), so changing the shape is safe.
- `counts.byStatus` must ignore the active status filter (so the tiles always show the full per-status breakdown for the current search); only the paginated `total`/`totalPages` respect the status filter.
- Reset to page 1 on filter/search change, but the 10s auto-refresh must NOT reset page/filter/search.
- Do not touch the webhook/status-update logic or the Prisma schema.
