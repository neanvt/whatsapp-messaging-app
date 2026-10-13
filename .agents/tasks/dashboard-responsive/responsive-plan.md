# Dashboard Layout Refactor + Mobile Responsiveness — Implementation Plan

Last updated: 2025-02-14

Derived from the approved design (`responsive-design.md`, rev 3) and
requirements (`responsive-requirements.md`), verified against the current code
(`layout.tsx`, `sidebar.tsx`, `header.tsx`, `chat/page.tsx`, `button.tsx`, and
the dashboard page tree). This is a presentation-only refactor: **no file under
`src/app/api/**`, no server action, no `lib/`, no Prisma schema, no auth
config, no fetch call, no polling interval, and no rendered data changes.**

Conventions used below:
- **Build command:** `npm run build` (runs `prisma generate && next build`).
- **Lint command:** `npm run lint` (`next lint`).
- **Breakpoint switch:** `lg` (1024px). Below `lg` = drawer shell; `lg+` =
  fixed sidebar. Reference widths: **390px** and **1280px**.
- "Verify build" means `npm run build` completes with no new errors/warnings
  attributable to this change (the pre-existing chat `useSearchParams`
  Suspense/CSR-bailout warning, if present, is out of scope — do not attribute
  it to this work).

The order below is dependency-first: new leaf components → the shell that
composes them → the server layout that renders the shell → responsive fixes to
Header/Sidebar → the chat page (depends on `main` being a flex column) → the
remaining content pages → the full verification gate. Every item leaves the
tree in a buildable state.

---

## Implementation Plan

- [ ] 1. Create the `Footer` presentational component.
      Add `src/components/dashboard/footer.tsx` as a `"use client"` component
      rendering `© {new Date().getFullYear()} WhatsApp Business. All rights
      reserved.` and a single `next/link` to `/docs` (do NOT link
      `/privacy-policy` — that route does not exist; confirmed by search).
      Use exactly the classes from the design: outer
      `footer` = `border-t bg-white px-4 py-4 text-sm text-gray-500 sm:px-6`;
      inner wrapper = `flex flex-col items-center justify-between gap-2
      sm:flex-row`; the Docs link = `hover:text-gray-900 hover:underline`.
      Files: `src/components/dashboard/footer.tsx` (new).
      Verify: `npm run build` succeeds (component compiles even before it is
      wired in).

- [ ] 2. Add responsive + drawer props to `Header`.
      Change the signature to `Header({ isOpen, onMenuClick }: { isOpen:
      boolean; onMenuClick: () => void })`. Add a `Menu` import from
      `lucide-react`. Insert, as the first child of a new left cluster
      (`<div className="flex min-w-0 items-center gap-2">`), a `Button
      variant="ghost" size="icon"` with `className="lg:hidden"`,
      `aria-label="Toggle navigation menu"`, `aria-expanded={isOpen}`,
      `onClick={onMenuClick}`, wrapping `<Menu className="h-5 w-5" />`. Keep the
      welcome `h2` but make it `truncate text-base font-semibold sm:text-lg`.
      Update the `header` element classes to
      `flex h-16 items-center justify-between gap-2 border-b bg-white px-4
      sm:px-6`. In the right cluster use `flex items-center gap-2 sm:gap-4`;
      make the email span `hidden text-sm font-medium md:inline`; add
      `aria-label="Log out"` to the existing logout `Button`. Do NOT change the
      `signOut({ callbackUrl: "/login" })` call or the bell button.
      Files: `src/components/dashboard/header.tsx`.
      Verify: `npm run build` — Header has unused-prop/type errors expected ONLY
      if the shell (item 4) is not yet wired; so build is deferred to item 4.
      Interim check: `npm run lint` reports no new lint errors in this file
      (TypeScript "declared but never used" on props is resolved by item 4).

- [ ] 3. Convert `Sidebar` to an overlay + off-canvas drawer that stays a fixed
      column at `lg+`.
      Change the signature to `Sidebar({ isOpen, onClose }: { isOpen: boolean;
      onClose: () => void })`. Wrap the current content in a fragment with two
      elements: (a) a backdrop `<div onClick={onClose} aria-hidden="true"
      className={cn("fixed inset-0 z-30 bg-black/50 transition-opacity
      lg:hidden", isOpen ? "opacity-100" : "pointer-events-none opacity-0")} />`;
      (b) the panel — move the existing root `div`'s content into a panel
      `<div className={cn("fixed inset-y-0 left-0 z-40 flex w-64 flex-col
      bg-gray-900 text-white", "transition-transform duration-200 ease-in-out",
      isOpen ? "translate-x-0" : "-translate-x-full", "lg:static lg:z-auto
      lg:min-h-screen lg:translate-x-0")}>`. Keep the `cn` import.
      **Preserve verbatim:** the `navigation` array (6 items, same order/icons),
      the `isActive = pathname === item.href || pathname.startsWith(item.href +
      "/")` logic and its styling, the `WhatsApp Business` `h1`, and the two
      bottom links (Developer Docs → `/docs`, Settings → `/dashboard/settings`)
      under the `border-t` group. Do NOT add `onClose` to nav `Link`s — the
      shell closes the drawer on pathname change.
      Files: `src/components/dashboard/sidebar.tsx`.
      Verify: deferred to item 4's build (needs the shell to pass props); meanwhile
      `npm run lint` shows no new lint errors in this file.

- [ ] 4. Create the client shell `DashboardShell` that owns drawer state and
      composes Sidebar + Header + main + Footer.
      Add `src/components/dashboard/dashboard-shell.tsx` as `"use client"` with
      `useState` drawer `open`, `usePathname`, and the three effects from the
      design verbatim: (a) close on `pathname` change (`setOpen(false)`);
      (b) Escape-to-close + body-scroll-lock guarded by
      `window.matchMedia("(min-width: 1024px)")` early-return and restoring the
      previous `document.body.style.overflow` in cleanup; (c) a mount-time
      `matchMedia("(min-width: 1024px)")` `change` listener that forces
      `setOpen(false)` when crossing into `lg+`. Render:
      `<div className="flex min-h-screen bg-gray-50">` → `<Sidebar isOpen={open}
      onClose={() => setOpen(false)} />` + `<div className="flex min-w-0 flex-1
      flex-col">` containing `<Header isOpen={open} onMenuClick={() =>
      setOpen((v) => !v)} />`, `<main className="flex min-w-0 flex-1 flex-col
      p-4 sm:p-6">{children}</main>`, and `<Footer />`. Import Sidebar, Header,
      Footer from `@/components/dashboard/*`.
      Files: `src/components/dashboard/dashboard-shell.tsx` (new).
      Verify: `npm run build` AND `npm run lint` both succeed — this is the first
      point where items 1–3 are fully wired, so the whole shell type-checks.

- [ ] 5. Reduce `layout.tsx` to the auth gate + shell delegation.
      Keep `getServerSession(authOptions)` and `if (!session) redirect("/login")`
      exactly as they are. Replace the inline `<div>…<Sidebar/>…<Header/>…
      <main/>` markup with `return <DashboardShell>{children}</DashboardShell>;`.
      Remove the now-unused `Sidebar`/`Header` imports and add
      `import { DashboardShell } from "@/components/dashboard/dashboard-shell";`.
      Keep `layout.tsx` a server component (no `"use client"`).
      Files: `src/app/dashboard/layout.tsx`.
      Verify: `npm run build` succeeds; manually load any dashboard route and
      confirm it renders with sidebar + header + footer (the full shell is now
      live). `npm run lint` clean.

- [ ] 6. Make the chat page single-panel below `lg` with a back control and the
      flex-height fix.
      In `src/app/dashboard/chat/page.tsx`: add `cn` import from `@/lib/utils`
      and `ArrowLeft` to the existing `lucide-react` import. Change the root
      `div` className from `flex h-[calc(100vh-0px)] bg-[#111B21] text-[#E9EDEF]
      overflow-hidden` to `flex min-h-0 flex-1 bg-[#111B21] text-[#E9EDEF]
      overflow-hidden`. Change the list wrapper from `w-[340px] min-w-[280px]
      flex flex-col border-r border-[#2A3942]` to
      `cn("flex flex-col border-r border-[#2A3942] w-full lg:w-[340px]
      lg:min-w-[280px]", contactParam ? "hidden lg:flex" : "flex")`. On the
      `!contactParam` placeholder branch wrapper, change
      `flex-1 flex flex-col items-center justify-center …` to
      `hidden lg:flex flex-1 flex-col items-center justify-center bg-[#222E35]
      text-center p-8`. Leave the thread branch wrapper as
      `flex-1 flex flex-col bg-[#0C1317] min-w-0`. In the chat-header `flex`
      row, insert as the FIRST child (before the avatar) a back button:
      `<button onClick={() => router.push("/dashboard/chat")}
      className="lg:hidden p-2 rounded-full hover:bg-[#2A3942] transition-colors
      flex-shrink-0" aria-label="Back to conversations"><ArrowLeft
      className="w-5 h-5 text-[#AEBAC1]" /></button>`. Keep the Refresh button
      and ALL logic (polling, send, search, new-chat, 24h notice, `?contact=`,
      `router`) unchanged.
      Files: `src/app/dashboard/chat/page.tsx`.
      Verify: `npm run build` succeeds. Manual: at 390px with no `?contact=`,
      only the full-width list shows; selecting a contact shows the thread with
      a visible back arrow that returns to the list; at 1280px both panels show
      side by side and the back arrow is hidden; the footer rests below the
      chat without the page scrolling horizontally.

- [ ] 7. Fix the `numbers` list page header row and card action clusters.
      In `src/app/dashboard/numbers/page.tsx`: change the page header row (the
      `flex items-center justify-between mb-6` title+Add row) to
      `flex flex-col gap-4 mb-6 sm:flex-row sm:items-center sm:justify-between`.
      Change each card's `CardContent` from `flex items-center justify-between
      p-6` to `flex flex-col gap-4 p-6 sm:flex-row sm:items-center
      sm:justify-between`. Keep the LEFT info cluster `flex items-center
      space-x-4` as-is. Change the RIGHT action cluster (status badge + optional
      badge + Cancel + View) from `flex items-center space-x-4` to
      `flex flex-wrap items-center gap-2`. No data/handler changes.
      Files: `src/app/dashboard/numbers/page.tsx`.
      Verify: `npm run build` succeeds. Manual at 390px: title + Add stack, and
      every card's status badge and action buttons wrap without any button
      clipped off the right edge.

- [ ] 8. Fix the `templates` list page header row and card action clusters.
      In `src/app/dashboard/templates/page.tsx`: change the page header row
      (`flex items-center justify-between mb-6`) to `flex flex-col gap-4 mb-6
      sm:flex-row sm:items-center sm:justify-between`; add `flex-wrap` to the
      sync/create button group. Change each card's `CardContent` from
      `flex items-center justify-between p-6` to `flex flex-col gap-4 p-6
      sm:flex-row sm:items-start sm:justify-between`. Change any per-card action
      cluster using `space-x-*` (Send/View/Duplicate/Delete) to
      `flex flex-wrap items-center gap-2`. Leave the `line-clamp-2` body as-is.
      No template-sync or data logic changes.
      Files: `src/app/dashboard/templates/page.tsx`.
      Verify: `npm run build` succeeds. Manual at 390px: header stacks and every
      template card's badge + action buttons wrap, none clipped.

- [ ] 9. Fix the `messages` history page header actions row.
      In `src/app/dashboard/messages/page.tsx`: change the page header row
      (`flex items-center justify-between`) to `flex flex-col gap-4 sm:flex-row
      sm:items-center sm:justify-between`, and make the Refresh/Send cluster
      `flex flex-wrap items-center gap-2`. Confirm the history table remains
      inside its existing `overflow-x-auto` container (do not remove it). No
      data/column changes.
      Files: `src/app/dashboard/messages/page.tsx`.
      Verify: `npm run build` succeeds. Manual at 390px: header actions wrap and
      the table scrolls inside its own container without widening the page.

- [ ] 10. Fix the number-detail page grid and action row.
      In `src/app/dashboard/numbers/[id]/page.tsx`: keep the `max-w-lg` card.
      Change the detail block `grid grid-cols-2 gap-4` to
      `grid grid-cols-1 gap-4 sm:grid-cols-2`. Ensure the action-button row is
      `flex flex-wrap gap-2`. No data changes.
      Files: `src/app/dashboard/numbers/[id]/page.tsx`.
      Verify: `npm run build` succeeds. Manual at 390px: label/value pairs stack
      one per row; action buttons wrap without clipping.

- [ ] 11. Fix the template `new` page crowded grids/rows.
      In `src/app/dashboard/templates/new/page.tsx`: keep the `max-w-2xl`
      container. Change inner `grid grid-cols-2 gap-2` button/field pairs that
      crowd at 390px to `grid grid-cols-1 gap-2 sm:grid-cols-2`. Add
      `flex-wrap gap-2` to any `flex items-center justify-between` row where a
      control + helper risks clipping. No form-state or submit logic changes.
      Files: `src/app/dashboard/templates/new/page.tsx`.
      Verify: `npm run build` succeeds. Manual at 390px: no horizontal overflow;
      all inputs and buttons reachable.

- [ ] 12. Fix the template-detail page grids/rows (mirror of item 11).
      In `src/app/dashboard/templates/[id]/page.tsx`: keep `max-w-2xl`. Change
      `grid grid-cols-2` → `grid grid-cols-1 sm:grid-cols-2` and
      `grid grid-cols-3` → `grid grid-cols-1 sm:grid-cols-3`; add `flex-wrap
      gap-2` to crowded header/action rows. No data changes.
      Files: `src/app/dashboard/templates/[id]/page.tsx`.
      Verify: `npm run build` succeeds. Manual at 390px: no overflow; grids
      stack and widen at `sm`.

- [ ] 13. Allow the `settings` tab bar to wrap.
      In `src/app/dashboard/settings/page.tsx`: keep `max-w-3xl mx-auto`. Add
      `flex-wrap` to the tab-bar container (`flex space-x-1`). No form or
      account-info grid changes (it is already `grid-cols-1 sm:grid-cols-2`).
      Files: `src/app/dashboard/settings/page.tsx`.
      Verify: `npm run build` succeeds. Manual at 390px: the three tabs wrap
      cleanly instead of overflowing.

- [ ] 14. Audit the verify-only pages and apply the small `payments` balance-row
      fix if it crowds.
      Open each of `src/app/dashboard/page.tsx`,
      `src/app/dashboard/payments/page.tsx`,
      `src/app/dashboard/numbers/add/page.tsx`,
      `src/app/dashboard/numbers/[id]/verify/page.tsx`, and
      `src/app/dashboard/messages/send/page.tsx`. These are expected to already
      hold at 390px (existing `grid-cols-1 md:/lg:/xl:` grids and `max-w-*`
      cards). Make a change ONLY if the manual 390px pass finds overflow. The
      one pre-approved optional tweak: in `payments/page.tsx`, if the balance
      row (`flex items-center justify-between`) crowds, change it to
      `flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between` so the
      Refresh button drops below the balance. On `messages/send/page.tsx` only
      add `min-w-0`/`break-words` to the error banner if an overflow is actually
      observed; the outer `grid-cols-1 lg:grid-cols-2` already stacks correctly.
      Files (only if overflow found): `src/app/dashboard/payments/page.tsx`,
      `src/app/dashboard/messages/send/page.tsx`, and/or the others.
      Verify: `npm run build` succeeds. Manual at 390px: none of these five
      routes introduce horizontal page scroll; `messages/send` shows Compose
      above Preview in one column with all inputs, the variables section, the
      progress bar, and the results list fitting the viewport.

- [ ] 15. Run the full regression gate and the required manual viewport pass.
      Run `npm run build` and `npm run lint`; both must succeed with no new
      errors. Then perform the required manual viewport pass at **390px** and
      **1280px** across every `src/app/dashboard/**` route, explicitly checking:
      (a) 1280px — sidebar is a visible fixed `w-64` dark column, hamburger NOT
      shown, Header → main → Footer stack with the Footer at the bottom on short
      pages; (b) 390px — sidebar hidden, hamburger opens a left slide-in drawer
      with a dimming overlay; (c) 390px — tapping the overlay, pressing Escape,
      and navigating a nav link each close the drawer, and the page body does
      not scroll while open; (d) hamburger `aria-label` present and
      `aria-expanded` toggles true/false; (e) Footer shows product name + current
      year + a working `/docs` link on every route; (f) no horizontal page
      scroll on any dashboard route at 390px; (g) chat single-panel switch and
      the chat-header four-item row (back + avatar + name + Refresh) not
      overflowing at 390px; (h) numbers/templates card buttons wrap, none
      clipped; (i) active-state highlighting still marks the current nav item in
      both the desktop sidebar and the mobile drawer; (j) logout from the Header
      signs out and redirects to `/login`.
      Files: none (verification only).
      Verify: `npm run build` and `npm run lint` pass; the manual 390px/1280px
      checklist above all holds. This manual pass is NOT optional (jsdom cannot
      verify layout).

---

## Preservation checklist (must remain true after every item)

- All six nav items, their order, icons, destinations, and active highlighting
  are unchanged; `/docs` and `/dashboard/settings` bottom links intact.
- Logout = `signOut({ callbackUrl: "/login" })`, unchanged.
- No file under `src/app/api/**`, no server action, no `lib/`, no Prisma
  schema/migration, no auth config touched.
- No fetch call, request/response shape, polling interval (chat 5000ms), or
  rendered page data changed.
- No new runtime dependency (`lucide-react` `Menu`/`X`/`ArrowLeft` reused; no
  headless-UI or animation library).
- The dark sidebar palette (`bg-gray-900 text-white`) and existing design
  language preserved.

## Notes / assumptions

- `/privacy-policy` has no route (confirmed by search); per the design the
  Footer links only to `/docs`. The pre-existing broken `/privacy-policy` links
  in login/register are out of scope and left untouched.
- The chat page's pre-existing `useSearchParams` Suspense/CSR-bailout warning,
  if emitted by `next build`, is pre-existing and out of scope — do not treat
  it as a regression from this change.
- `Button size="icon"` is already `h-10 w-10` (≈40px), meeting the tap-target
  NFR without change.
