# Dashboard shell refactor into Header/Sidebar/Footer with mobile off-canvas drawer

The dashboard chrome is split into independent single-responsibility components orchestrated by a new client shell (`DashboardShell`). The server `layout.tsx` keeps the auth boundary and delegates all markup to the shell, which owns the drawer open/close state and the pathname/Escape/scroll-lock/resize effects. Below `lg` the sidebar becomes a left slide-in off-canvas drawer with a dimming overlay; at `lg+` it is the existing fixed `w-64` dark column. A new `Footer` is added, and every content page under `src/app/dashboard/**` gets a className-only responsive pass (stack-first, widen up). The change is presentation-only: no API routes, data fetching, polling, or business logic touched, and no new dependencies.

Watch for: the Footer links to both `/docs` and `/privacy-policy` — this contradicts the design/plan (which assumed `/privacy-policy` was a dead 404 and said to link only `/docs`), but `/privacy-policy` is in fact a real route in the base branch, so the coder correctly followed the authoritative requirements (FR1.2/AC5) over the stale design assumption (confirmed). The standalone `npm run lint` could not run (interactive prompt hang), but the in-build lint and type-check passed per the recorded `npm run build` exit 0 (confirmed via commit evidence).

**Verdict**: APPROVED

## High-level view

The layout seam is correct: `layout.tsx` stays a server component with `getServerSession` → `redirect("/login")` intact and returns only `<DashboardShell>{children}</DashboardShell>`. All interactive state lives in the client shell, keeping the auth gate on the server.

The drawer mechanics match the design verbatim. The shell owns one boolean and three effects (close-on-pathname, Escape+scroll-lock guarded to run only below `lg`, and a `matchMedia` resize-close that prevents a stale `open=true` at desktop). The sidebar renders the same nav in both modes; only the wrapper's positioning utilities switch at `lg`. Nav items, order, icons, active-highlight logic, and the two bottom links are preserved unchanged.

The Footer decision is the one place implementation diverges from the design doc, and the divergence is correct. The design was written against an outdated premise; the route exists now, and the requirements explicitly ask for both links, so linking both is the right call.

The content-page pass is uniformly className-only: header rows and card action clusters go `flex-col`→`sm:flex-row` with `flex-wrap gap-2` (replacing `space-x-*`, which does not combine with wrapping), and crowded grids go `grid-cols-1`→`sm:grid-cols-*`. The chat page drops its fixed `100vh` for `flex min-h-0 flex-1`, switches to single-panel below `lg`, and adds an `lg:hidden` back button, all without touching polling, send, search, or the `?contact=` logic.

Horizontal-overflow protection rests on `min-w-0` on both the content column and `main`, plus the messages table staying inside its existing `overflow-x-auto`. No new dependency was added and no API/lib/prisma/auth file was touched.

<details>
<summary>Issues (1)</summary>

1. **Commit message vs design wording (non-blocking)** — the commit says the Footer links to `/docs` and `/privacy-policy` "(both real routes)", which is accurate against the current code but reads as a contradiction of the design doc's stale "dead route" claim. The scratchpad already documents the reconciliation; no code change needed. Informational only.

</details>

<details>
<summary>Details</summary>

### Server layout stays the auth boundary

`layout.tsx` keeps `getServerSession(authOptions)` and `if (!session) redirect("/login")` exactly as before and now returns `<DashboardShell>{children}</DashboardShell>` (confirmed by reading `HEAD:src/app/dashboard/layout.tsx`). It carries no `"use client"` and holds no presentation state, so the auth gate still runs on the server before any client code. The former inline `<Sidebar/>…<Header/>…<main/>` markup moved into the shell unchanged in intent. This satisfies the first checklist item cleanly.

### Drawer state and effects in the client shell

`DashboardShell` lifts a single `open` boolean and passes `isOpen`/`onClose` to `Sidebar` and `isOpen`/`onMenuClick` to `Header` — the chosen lifted-state design over Context, appropriate for a one-level, two-consumer share. The three effects match the design:

- Close on `pathname` change — tapping a nav link both navigates and dismisses the drawer (FR2.4).
- Escape-to-close plus `document.body.style.overflow = "hidden"`, both early-returning when `matchMedia("(min-width: 1024px)")` matches, so the scroll lock never fires at `lg+` where the desktop page must scroll (FR2.5/FR2.6, AC3). The previous overflow value is captured and restored in cleanup.
- A mount-time `matchMedia` `change` listener that force-closes the drawer when the viewport crosses into `lg+`, keeping `aria-expanded` honest and the scroll lock from going stale on a later narrow toggle (confirmed).

The content column and `main` both carry `min-w-0`, and `main` is `flex min-w-0 flex-1 flex-col p-4 sm:p-6` — the flex-column commitment the chat page's `flex-1 min-h-0` root depends on, and the padding adapts for 390px (FR4.7).

### Sidebar: one component, two positioning modes

The sidebar wraps its unchanged content in a backdrop + panel fragment. The backdrop is `fixed inset-0 z-30 bg-black/50 transition-opacity lg:hidden` and toggles `opacity-100` ↔ `pointer-events-none opacity-0`, so it fades, dismisses on click, and never blocks clicks at `lg+` or when closed (FR2.3). The panel is `fixed inset-y-0 left-0 z-40 w-64` translated by `-translate-x-full`/`translate-x-0` with `transition-transform duration-200`, and `lg:static lg:z-auto lg:min-h-screen lg:translate-x-0` restores the normal fixed column at desktop (FR2.1/FR2.2, AC1/AC2). The `navigation` array (six items, order/icons), the `isActive = pathname === item.href || pathname.startsWith(item.href + "/")` logic and styling, the `WhatsApp Business` `h1`, and the two bottom links (`/docs`, `/dashboard/settings`) are all preserved verbatim, and the dark `bg-gray-900 text-white` palette is unchanged (FR2.7, AC10, NFR4).

### Header: hamburger and graceful shrink

The `Menu` button is `lg:hidden` with `aria-label="Toggle navigation menu"` and `aria-expanded={isOpen}` (a real boolean), wired to `onMenuClick` (FR3.1, NFR1, AC4). The resize-close effect means `aria-expanded` can't be a stale `true` on a desktop where the control is hidden. The welcome `h2` is `truncate` inside a `min-w-0` wrapper so it ellipsizes instead of pushing controls off-screen, the email is `hidden md:inline`, and the avatar + logout always remain (FR3.2). `signOut({ callbackUrl: "/login" })` and the bell are untouched, and `aria-label="Log out"` is added to the icon-only control (FR3.3, AC11).

### Footer and the /privacy-policy divergence

The Footer renders product name, `© {new Date().getFullYear()} WhatsApp Business`, and two links — `/docs` and `/privacy-policy` — stacking `flex-col` then `sm:flex-row`, in a white bar with the gray palette (FR1.2, AC5). It is the last child of the content column with `main` as `flex-1`, so it rests at the viewport bottom on short pages and is pushed down on tall ones (FR1.3, AC1).

The design (rev 3) and plan both insisted the Footer link only to `/docs` on the premise that `/privacy-policy` was a dead 404. That premise is now false: `src/app/privacy-policy/page.tsx` exists in the base branch (`origin/main`) as a real server-rendered page (confirmed via `git cat-file -e origin/main:…` and `git show`). The authoritative requirements FR1.2 and AC5 explicitly call for working links to both `/docs` and `/privacy-policy`. The coder linked both, which satisfies the requirements with two genuinely working targets. This is the correct resolution of a requirements-vs-stale-design conflict, and the scratchpad documents it. Not a blocking finding.

### Content pages: className-only responsive pass

Every content change is structural className only, matching the plan item-for-item (confirmed across the full diff):

- `numbers`, `templates`, `messages` header rows → `flex flex-col gap-4 … sm:flex-row sm:items-center sm:justify-between`; action clusters → `flex flex-wrap items-center gap-2`, correctly replacing `space-x-*` which does not wrap (FR4.3/FR4.4/FR4.5, AC9).
- `numbers` and `templates` list card `CardContent` → `flex flex-col gap-4 p-6 sm:flex-row …`; left info clusters kept as single-row `space-x-4`.
- `numbers/[id]` detail grid `grid-cols-1 … sm:grid-cols-2`; `templates/new` and `templates/[id]` inner `grid-cols-2`/`grid-cols-3` → `grid-cols-1 sm:grid-cols-*`, media URL input `col-span-3` → `sm:col-span-3`, category rows `flex space-x-4` → `flex flex-wrap gap-x-4 gap-y-2`, submit row `flex space-x-4` → `flex flex-wrap gap-4`.
- `settings` tab bar → `flex flex-wrap space-x-1`; `payments` balance row → `flex flex-col gap-3 sm:flex-row …` (the pre-approved optional tweak).

No handler, fetch, or data mapping is altered in any of these files.

### Chat page: single-panel switch without logic change

The root drops `h-[calc(100vh-0px)]` for `flex min-h-0 flex-1`, so it fills exactly the space `main` grants (viewport minus Header/Footer/padding), letting the Footer rest correctly and nothing overflow (FR4.2, AC6/AC8). The list wrapper becomes `cn("flex flex-col border-r … w-full lg:w-[340px] lg:min-w-[280px]", contactParam ? "hidden lg:flex" : "flex")` — the bare `min-w-[280px]` is correctly scoped to `lg` so a full-width mobile list has no stale floor. The `!contactParam` placeholder becomes `hidden lg:flex`, and the thread branch gets a first-child `lg:hidden` `ArrowLeft` back button to `/dashboard/chat`. The `?contact=` param, `router` navigation, 5000ms polling, optimistic send, search, and new-chat flow are all untouched (confirmed — the diff touches only the two className strings, one import, and the back button).

### No regressions, no new dependencies

`git diff origin/main --name-only` touches only `scratchpad.md`, the dashboard component files, and dashboard page files — no `src/app/api/**`, no `lib/`, no Prisma schema, no auth config (confirmed). `package.json`/`package-lock.json` are untouched, so there are zero new dependencies; the only new icon imports (`Menu`, `ArrowLeft`) come from the already-present `lucide-react` (NFR3, AC12 build portion).

### Build evidence (judged, not re-run)

The commit records `npm run build` (`prisma generate && next build`) → exit 0 with "Compiled successfully" and the in-build type-check + lint passing. The scratchpad adds an honest caveat that standalone `npm run lint` hangs on an interactive `next lint` config prompt in this environment (pre-existing), so FR5.3's lint requirement is met by the lint pass that runs inside `next build`. This evidence is accepted per the judge-don't-verify instruction; nothing in the diff raises an articulable doubt that would warrant a spot-check.

### Scratchpad updated

`scratchpad.md` refreshes `Last updated`, adds a dashboard-shell architecture section and a mobile-responsive strategy section, corrects the `/privacy-policy` public-page note to "real route … linked from the dashboard Footer," and appends a dated `2026-10-15` change-log entry summarizing every change plus the build/lint evidence and the privacy-policy reconciliation (confirmed).

</details>

<details>
<summary>File map</summary>

- `src/app/dashboard/layout.tsx` — reduced to session gate + `<DashboardShell>` delegation; stays a server component.
- `src/components/dashboard/dashboard-shell.tsx` (new) — client shell owning drawer state + pathname/Escape/scroll-lock/resize effects.
- `src/components/dashboard/footer.tsx` (new) — product name, copyright year, links to `/docs` and `/privacy-policy`.
- `src/components/dashboard/header.tsx` — hamburger (`lg:hidden`, aria), truncating welcome text, email `hidden md:inline`.
- `src/components/dashboard/sidebar.tsx` — backdrop + off-canvas panel keyed off `isOpen`; fixed column at `lg+`; nav/links preserved.
- `src/app/dashboard/chat/page.tsx` — flex-height root, single-panel switch below `lg`, `ArrowLeft` back button; logic unchanged.
- `src/app/dashboard/numbers/page.tsx`, `numbers/[id]/page.tsx` — header/card stacking, detail grid stack.
- `src/app/dashboard/templates/page.tsx`, `templates/new/page.tsx`, `templates/[id]/page.tsx` — header/card/grid/row stacking + wrap.
- `src/app/dashboard/messages/page.tsx` — header actions wrap.
- `src/app/dashboard/settings/page.tsx` — tab bar wrap.
- `src/app/dashboard/payments/page.tsx` — balance row stack.
- `scratchpad.md` — architecture + responsive sections, privacy-policy note correction, dated change-log entry.

Full diff: `git diff origin/main`.

</details>
