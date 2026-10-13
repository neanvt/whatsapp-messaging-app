# Dashboard Layout Refactor + Mobile Responsiveness — Requirements

Last updated: 2025-02-14

## Summary

The dashboard shell (`src/app/dashboard/layout.tsx` + `Sidebar` + `Header`) is
desktop-only. The sidebar is a fixed `w-64` column that is always visible, the
header never offers a way to reach navigation on small screens, and several
content pages use fixed widths or multi-column grids that overflow below the
`lg` breakpoint. There is no footer.

This task refactors the shell into clean, independent layout components
(Header, Sidebar, Footer, plus a client shell that owns drawer state) and makes
every dashboard screen usable from ~360px up to desktop. It is a
presentation-only change: no API routes, data fetching, or business logic
change. Public pages (landing/login/register/docs/privacy) are out of the
dashboard layout and are touched only if an obvious mobile break is found.

Target reference widths for acceptance: **390px** (small phone) and **1280px**
(desktop). The layout must also not break at the common intermediate `md`
(~768px) tablet width.

## Assumptions

- "Mobile" = below Tailwind `lg` (1024px); the off-canvas drawer appears below
  `lg` and the fixed sidebar appears at `lg` and up. This matches the brief
  ("desktop (lg+) stays a fixed visible w-64 column").
- No new runtime dependencies. `lucide-react` (already present) supplies the
  `Menu` and `X` icons; drawer state is plain React `useState`. No headless UI
  library is introduced.
- The dark sidebar aesthetic (`bg-gray-900 text-white`) and the existing
  Tailwind design language are preserved; only structure and responsive
  utilities change.
- The chat page's two-panel WhatsApp-style UI (`w-[340px]` list + thread) is
  the one page whose internal layout must switch between list and thread on
  mobile (it cannot show both side by side at 390px). This is in scope as a
  content-page responsive fix, not a logic change.

## Component Boundaries

The dashboard shell is composed of four independent components plus the server
layout:

| Component | File | Type | Responsibility |
|---|---|---|---|
| `DashboardLayout` | `src/app/dashboard/layout.tsx` | Server | Session check + redirect to `/login`; render the client shell with `children`. No presentation state. |
| Client shell | `src/components/dashboard/dashboard-shell.tsx` (new) | Client | Owns drawer open/close state; lays out Sidebar + (Header → main → Footer) column; passes open state + toggle to Header and Sidebar. |
| `Header` | `src/components/dashboard/header.tsx` | Client | Top bar: hamburger (mobile only), welcome text, user identity, logout. Receives `onMenuClick` + `isOpen`. |
| `Sidebar` | `src/components/dashboard/sidebar.tsx` | Client | Nav + bottom links. Fixed column at `lg+`; off-canvas drawer + overlay below `lg`. Receives `isOpen` + `onClose`. |
| `Footer` | `src/components/dashboard/footer.tsx` (new) | Client or server | Product name, copyright/year, links to `/docs` and `/privacy-policy`. |

Rationale for a dedicated client shell: `layout.tsx` must stay a server
component (it performs the session check), but the hamburger (Header) and the
drawer (Sidebar) need to share one piece of open/close state. A small client
wrapper rendered by the server layout is the cleanest seam; Header, Sidebar,
and Footer stay siblings that each do one job.

## Functional Requirements

### FR1 — Independent layout components
- FR1.1 Header, Sidebar, and a new Footer each live in their own file under
  `src/components/dashboard/` and render independently.
- FR1.2 A new `Footer` shows the product name, a copyright line with the
  current year, and links to `/docs` and `/privacy-policy`.
- FR1.3 The content column is a vertical stack: Header → scrollable `main`
  (`flex-1`) → Footer. The Footer sits at the viewport bottom when content is
  short (flex column, `main` is `flex-1`) and is pushed down naturally when
  content is tall.
- FR1.4 `layout.tsx` remains a server component doing only the session
  check/redirect and rendering the client shell.

### FR2 — Sidebar responsive behavior
- FR2.1 At `lg` and above: fixed, always-visible `w-64` dark column; current
  behavior preserved.
- FR2.2 Below `lg`: the sidebar is hidden by default and slides in from the
  left as an off-canvas drawer when the Header hamburger is tapped.
- FR2.3 A backdrop/overlay appears behind the open drawer and closes it on
  click/tap.
- FR2.4 The drawer closes automatically on route change (watch `pathname`).
- FR2.5 The drawer closes on `Escape`.
- FR2.6 Body scroll is prevented while the drawer is open and restored on
  close.
- FR2.7 All existing nav items, destinations, order, icons, and active-state
  highlighting (`usePathname`) are preserved: Dashboard, WhatsApp Numbers,
  Templates, Bulk Messages, Chat, Payments, Developer Docs (`/docs`), Settings
  (`/dashboard/settings`).

### FR3 — Header responsive behavior
- FR3.1 A hamburger button appears only below `lg`; it toggles the drawer.
- FR3.2 Welcome text and user controls shrink/stack gracefully; the long email
  is hidden on very small screens while the avatar and logout control remain
  reachable.
- FR3.3 Logout (`signOut({ callbackUrl: "/login" })`) and the bell are
  preserved.

### FR4 — Content pages stack and never overflow
Audit every page under `src/app/dashboard/**` and fix any that break below
~390px or ~768px. Specific known cases:
- FR4.1 `messages/send` — the Compose + Preview grid stacks to a single column
  on small screens (already `grid-cols-1 lg:grid-cols-2`; verify the inner
  rows, variable inputs, progress, and results list also fit 390px).
- FR4.2 `chat` — the two-panel layout (`w-[340px]` list + thread) must not show
  both panels side by side below `lg`. On mobile show the conversation list
  when no `?contact=` is selected and the thread when one is selected; the fixed
  `340px` list becomes full width on mobile. All existing behavior (polling,
  send, search, new chat, 24h notice) is unchanged.
- FR4.3 `numbers` and `templates` list rows — the `flex justify-between` card
  rows with multiple action buttons wrap or restack on mobile so buttons are
  not clipped off-screen at 390px.
- FR4.4 `messages` history — the table stays inside its `overflow-x-auto`
  container (already present); the header actions row wraps on mobile.
- FR4.5 Page header rows that use `flex items-center justify-between` with a
  title block + action buttons (`numbers`, `templates`, `messages`) wrap so
  action buttons drop below the title on small screens instead of squeezing.
- FR4.6 `dashboard`, `payments`, `settings`, `numbers/add`, `numbers/[id]`,
  `templates/new`, `templates/[id]` — verify existing responsive grids
  (`grid-cols-1 md:… lg:…`, `max-w-*`) hold at 390px; fix any fixed widths,
  side-by-side button rows, or horizontal overflow found during the audit.
- FR4.7 Global content padding adapts (e.g. `p-4 sm:p-6`) so content is not
  cramped at 390px nor loses the desktop spacing.

### FR5 — No functional regressions
- FR5.1 All routes, nav destinations, links (`/docs`, `/dashboard/settings`,
  `/privacy-policy`), and logout behave exactly as before.
- FR5.2 No API route, request shape, polling interval, or data displayed on any
  page changes.
- FR5.3 The app continues to build (`npm run build`) and lint
  (`npm run lint`) cleanly.

## Non-Functional Requirements

- NFR1 Accessibility: the hamburger has an `aria-label` and `aria-expanded`
  reflecting drawer state; the drawer is closable via `Escape`; the overlay is
  clickable to dismiss; focus handling is sensible (focus not lost into a
  hidden drawer).
- NFR2 Tap targets on mobile are reasonably sized (≈40px/`h-10`+ for primary
  controls); nothing is clipped off-screen at 390px.
- NFR3 Zero new runtime dependencies; Tailwind utilities + small client state
  only (`lucide-react` `Menu`/`X` reused).
- NFR4 The dark sidebar palette and existing component/design language are
  unchanged.

## Acceptance Criteria

1. At **1280px**: the sidebar is a visible fixed `w-64` dark column, the
   hamburger is NOT shown, and Header → main → Footer stack in the content
   column with the Footer resting at the bottom when a page's content is short.
2. At **390px**: the sidebar is hidden; a hamburger in the Header opens a
   left slide-in drawer with a dimming overlay behind it.
3. At 390px, tapping the overlay, pressing `Escape`, or navigating to another
   route each closes the drawer; while it is open the page body does not scroll.
4. The hamburger exposes `aria-label` and an `aria-expanded` value that is
   `true` when the drawer is open and `false` when closed.
5. A Footer renders inside the dashboard on every dashboard route, showing the
   product name, the current year in a copyright line, and working links to
   `/docs` and `/privacy-policy`.
6. At 390px, no horizontal page scroll is introduced on any
   `src/app/dashboard/**` route; the message-history table scrolls inside its
   own container rather than widening the page.
7. At 390px, `messages/send` shows Compose above Preview in a single column;
   all inputs, the variables section, progress bar, and the results list fit
   within the viewport width.
8. At 390px, the `chat` route shows one panel at a time: the conversation list
   when no contact is selected and the message thread (with a way back to the
   list) when a contact is selected; at 1280px both panels show side by side as
   today.
9. At 390px, the `numbers` and `templates` list cards show their status badges
   and action buttons without any button being clipped off the right edge
   (rows wrap or restack).
10. Active-state highlighting still marks the current nav item in both the
    desktop sidebar and the mobile drawer.
11. Logout from the Header still signs the user out and redirects to `/login`.
12. `npm run build` and `npm run lint` both succeed with no new errors.

## Out of Scope / Non-Goals

- No changes to API routes, server actions, Prisma schema, auth logic, or any
  business/data behavior.
- No redesign or re-theming beyond what responsiveness requires; the dark
  sidebar and current look are kept.
- No new UI/animation libraries or other runtime dependencies.
- No feature additions to any page (no new filters, columns, settings, etc.).
- Public marketing/auth pages (landing, login, register) are not restructured;
  they are touched only for an obvious, minimal mobile-break fix if one is
  found. `docs`/`privacy-policy` already use a centered responsive layout and
  are left as-is apart from being valid Footer link targets.
- The unrelated template-per-tenant syncing concern raised earlier in the
  conversation is not part of this layout/responsive task.

## Change log

- 2025-02-14 — Initial requirements for the dashboard layout refactor and
  mobile-responsive pass, based on an audit of `src/app/dashboard/**`,
  `Sidebar`, and `Header`.
