# Dashboard Layout Refactor + Mobile Responsiveness — Design

Last updated: 2025-02-14 (revision 3 — resolves rev-2 review findings 1–5:
`/privacy-policy` dead-route, chat-header 390px fit, Suspense note, Footer
palette/contrast, product-name literal)

## Overview

The dashboard shell today is a server `layout.tsx` that renders a fixed
`w-64` `Sidebar` next to a column of `Header` + `main`. There is no footer, the
sidebar is always visible (unusable below ~1024px because it steals the full
left column), and the `Header` offers no way to reach navigation on a phone.
Several content pages also use fixed widths or multi-column rows that overflow
below `lg`.

This design keeps the server `layout.tsx` as the auth boundary and introduces a
single **client shell** (`dashboard-shell.tsx`) that owns the drawer open/close
state and arranges the four presentation components: `Sidebar`, `Header`,
`main` (children), and a new `Footer`. Below `lg` the sidebar becomes a
left slide-in off-canvas drawer with a backdrop; at `lg` and up it is the
existing fixed dark column and the hamburger disappears. Every content page
under `src/app/dashboard/**` gets a targeted responsive pass. This is strictly a
presentation change — no API route, server action, data fetch, polling
interval, or business logic is touched.

**Technology stack (locked):** Next.js 14 App Router, React 18, TypeScript,
Tailwind CSS with the project's default breakpoints (`sm` 640 / `md` 768 /
`lg` 1024 / `xl` 1280 — `tailwind.config.ts` extends only colors and radius, so
defaults apply), `lucide-react` for icons (already a dependency), and the
existing `cn()` helper (`clsx` + `tailwind-merge`) from `src/lib/utils`. No new
runtime dependency, no headless-UI or animation library, no new Tailwind
plugin.

## Component Boundaries

Five pieces compose the shell. Only `dashboard-shell.tsx` and `footer.tsx` are
new; `layout.tsx`, `sidebar.tsx`, and `header.tsx` are modified in place.

| Component | File | Type | Responsibility |
|---|---|---|---|
| `DashboardLayout` | `src/app/dashboard/layout.tsx` | Server (unchanged role) | `getServerSession` → `redirect("/login")` if no session; render `<DashboardShell>{children}</DashboardShell>`. Holds **no** presentation state. |
| `DashboardShell` | `src/components/dashboard/dashboard-shell.tsx` (**new**) | Client (`"use client"`) | Owns `open` drawer state; renders `Sidebar` + content column (`Header` → `main` → `Footer`); wires toggle/close callbacks; owns the pathname/Escape/scroll-lock/resize effects. |
| `Header` | `src/components/dashboard/header.tsx` | Client | Top bar: hamburger (below `lg` only), welcome text, user identity, logout. Receives `onMenuClick` + `isOpen`. |
| `Sidebar` | `src/components/dashboard/sidebar.tsx` | Client | Nav + bottom links. Fixed column at `lg+`; off-canvas panel + overlay below `lg`. Receives `isOpen` + `onClose`. |
| `Footer` | `src/components/dashboard/footer.tsx` (**new**) | Client (`"use client"`) presentational component | Product name, copyright with current year, link to `/docs` (the only existing target; `/privacy-policy` is a dead route and is intentionally not linked — see Footer section / Finding 1). |

### `layout.tsx` (modified)

```tsx
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  return <DashboardShell>{children}</DashboardShell>;
}
```

The session check and redirect stay exactly as they are — the layout remains a
server component so the auth gate runs on the server before any client code. It
simply delegates all layout/markup to the client shell.

### `Footer` component classification (resolves Finding 7)

The previous revision described `Footer` as a server component that "ships zero
JS." That rationale was **inaccurate** and is dropped. `Footer` is imported and
rendered **directly inside** `DashboardShell`, which is a `"use client"` module.
In the App Router, any module imported by a client module becomes part of the
client bundle regardless of whether it carries `"use client"`; it does not
remain a server component in that position. There is therefore no "zero JS"
benefit to claim.

`Footer` is a plain presentational component (static markup, two `Link`s, and
`new Date().getFullYear()` evaluated at render — all client-safe). It is marked
`"use client"` for honesty about where it runs. This has no functional impact.

## Drawer State Sharing — lifted state in the shell (chosen)

The hamburger lives in `Header` and the drawer/overlay lives in `Sidebar`;
these are siblings. Two options were considered:

- **A — React Context provider** around both children.
- **B — Lifted `useState` in `DashboardShell`, passed down as props.**

**Chosen: B (lifted state).** There is exactly one consumer on each side
(`Header` reads `isOpen` + calls `onMenuClick`; `Sidebar` reads `isOpen` +
calls `onClose`), both are direct children of the shell, and the tree is
shallow. Context would add a provider, a hook, and an extra module for a single
boolean shared one level down — more indirection with no benefit. Context only
earns its keep when state must cross many levels or reach deeply nested
descendants, which is not the case here. The shell owns the boolean and the
side effects (pathname/Escape/scroll-lock/resize) in one place, keeping `Header`
and `Sidebar` as thin presentational components.

### Shell contract (resolves Findings 1 and 4)

```tsx
"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Header } from "@/components/dashboard/header";
import { Footer } from "@/components/dashboard/footer";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on route change (FR2.4)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape-to-close (FR2.5) + body scroll lock (FR2.6) — only while open AND
  // only below lg (Finding 4). Never lock scroll at lg+, where no overlay is
  // shown and the desktop page must scroll as today (AC1).
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    if (mq.matches) return; // at lg+ the drawer is irrelevant; do not lock

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Resize guard (Finding 4): if the user opens the drawer below lg and then
  // widens past lg, force the drawer closed so `open` cannot linger as `true`
  // at desktop (which would otherwise keep the scroll lock stale on the next
  // narrow toggle, and keeps aria-expanded honest). matchMedia change fires
  // only on the boundary crossing, so this is cheap.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar isOpen={open} onClose={() => setOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header isOpen={open} onMenuClick={() => setOpen((v) => !v)} />
        <main className="flex min-w-0 flex-1 flex-col p-4 sm:p-6">
          {children}
        </main>
        <Footer />
      </div>
    </div>
  );
}
```

Props contracts:

```ts
// header.tsx
interface HeaderProps { isOpen: boolean; onMenuClick: () => void; }
// sidebar.tsx
interface SidebarProps { isOpen: boolean; onClose: () => void; }
```

**`main` is a flex column (resolves Finding 1).** The previous revision left
`main` as `flex-1 p-4 sm:p-6` (not a flex container) while telling the chat page
to use `min-h-0 flex-1` on its root — which is inert unless the parent is a flex
container along the main axis. This revision commits to **Option A** from the
review: `main` is `flex min-w-0 flex-1 flex-col p-4 sm:p-6`. It is a vertical
flex container that is itself `flex-1` inside the content column, so its single
page child can claim bounded height via `flex-1 min-h-0` (used by the chat page;
see the audit). This is safe for every other page: a page is normally a single
block child of `main`, and in a flex column a lone child with its natural height
simply sits at the top exactly as before — making `main` a column does not
change the visual flow of non-flex pages. The padding (`p-4 sm:p-6`) is retained
on `main` and the chat page accounts for it (see chat row).

The content column and `main` both carry `min-w-0` so a wide child (the
message-history table, the chat panels) cannot force the flex column to overflow
the viewport — a long-standing flexbox gotcha that is the simplest guard against
horizontal page scroll (AC6).

## Breakpoint Strategy

`lg` (1024px) is the single switch between "mobile shell" (drawer) and "desktop
shell" (fixed sidebar), matching the requirements' definition of mobile. The
reference acceptance widths are **390px** (below `lg` → drawer) and **1280px**
(≥ `lg` → fixed sidebar; `xl` grids may also expand). The intermediate `md`
(768px) tablet width stays on the drawer shell and must not break.

Per-component class strategy:

- **Shell container** — `flex min-h-screen bg-gray-50`; content column
  `flex min-w-0 flex-1 flex-col`.
- **`main`** — `flex min-w-0 flex-1 flex-col p-4 sm:p-6` (FR4.7): a flex column,
  tighter padding at 390px, full desktop spacing from `sm` up.
- **Sidebar** — two visual modes driven by `lg:` utilities (details below).
- **Header hamburger** — `lg:hidden` so it only renders below `lg` (FR3.1).
- **Content grids** — stack-first, widen up: the existing
  `grid-cols-1 md:grid-cols-2` / `lg:grid-cols-*` / `xl:grid-cols-6` patterns
  are already correct and are preserved; audit fixes add `flex-col`→`sm:flex-row`
  wrapping and `flex-wrap` to header/action rows rather than new column counts.

## Sidebar — Off-Canvas Drawer Mechanics

The sidebar renders the same nav content in both modes; only the wrapper's
positioning utilities differ. The structure becomes an overlay + a positioned
panel, both controlled by `isOpen`.

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
/* icon imports unchanged */

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();
  return (
    <>
      {/* Backdrop — only below lg, only when open (FR2.3) */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-30 bg-black/50 transition-opacity lg:hidden",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Panel: off-canvas drawer below lg, static column at lg+ */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-gray-900 text-white",
          "transition-transform duration-200 ease-in-out",
          isOpen ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:z-auto lg:min-h-screen lg:translate-x-0",
        )}
      >
        {/* existing header + nav + bottom links, unchanged */}
      </div>
    </>
  );
}
```

Mechanics mapped to requirements:

- **Slide-in transform (FR2.2):** the panel is always in the DOM. Below `lg` it
  is `fixed inset-y-0 left-0 w-64` and translated off-screen with
  `-translate-x-full`; opening sets `translate-x-0`. `transition-transform
  duration-200 ease-in-out` animates the slide with pure Tailwind — no JS
  animation, no library.
- **Desktop restore (FR2.1):** `lg:static lg:translate-x-0 lg:z-auto
  lg:min-h-screen` returns it to the normal flow as the fixed visible `w-64`
  column at `lg+`, so the transform/overlay classes are inert there. The dark
  `bg-gray-900 text-white` palette and all nav markup are unchanged (NFR4).
- **Backdrop + click-to-close (FR2.3):** a sibling `fixed inset-0 z-30
  bg-black/50 lg:hidden` div sits behind the panel (`z-40`) and above content;
  clicking it calls `onClose`. It fades via `opacity` and is
  `pointer-events-none` when closed so it never blocks clicks at `lg+` or when
  hidden.
- **Close on route change (FR2.4), Escape (FR2.5), scroll lock (FR2.6):** owned
  by `DashboardShell` (see effects above), not duplicated here. Closing on
  `pathname` change means tapping a nav `Link` both navigates and dismisses the
  drawer.
- **Active state (FR2.7, AC10):** the existing
  `pathname === item.href || pathname.startsWith(item.href + "/")` logic and
  the `isActive` styling are kept verbatim, so highlighting works identically in
  the desktop column and the mobile drawer (same component, same markup).
- **Nav parity (FR2.7, resolves Finding 5):** the sidebar has **two groups** and
  both are preserved in order: (1) the six-item `navigation` array — Dashboard,
  WhatsApp Numbers, Templates, Bulk Messages, Chat, Payments — rendered in the
  `flex-1` nav region; and (2) two divider-separated bottom links below a
  `border-t` — Developer Docs (`/docs`) and Settings (`/dashboard/settings`).
  Docs/Settings are **not** members of the `navigation` map; they stay as the
  distinct bottom-link group. Icons, destinations, and order are unchanged.

Why no portal: the overlay and panel are `fixed`-positioned, so they escape the
flex layout visually regardless of DOM location; a React portal would add
complexity for no behavioral gain and risks hydration edge cases. `z-30`
(overlay) / `z-40` (panel) sit above typical content; no dashboard content uses
a higher stacking context, so these are sufficient.

## Header — Responsive Behavior

```tsx
"use client";
import { useSession, signOut } from "next-auth/react";
import { Bell, LogOut, Menu, User } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Header({ isOpen, onMenuClick }: HeaderProps) {
  const { data: session } = useSession();
  return (
    <header className="flex h-16 items-center justify-between gap-2 border-b bg-white px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Toggle navigation menu"
          aria-expanded={isOpen}
          onClick={onMenuClick}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <h2 className="truncate text-base font-semibold sm:text-lg">
          Welcome back, {session?.user?.name}
        </h2>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <Button variant="ghost" size="icon">
          <Bell className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200">
            <User className="h-4 w-4 text-gray-500" />
          </div>
          <span className="hidden text-sm font-medium md:inline">
            {session?.user?.email}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => signOut({ callbackUrl: "/login" })}
          aria-label="Log out"
        >
          <LogOut className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
```

Mapped to requirements:

- **Hamburger below `lg` only (FR3.1, AC2):** the `Menu` button carries
  `lg:hidden`; `onMenuClick` toggles the shell state. At 1280px it is not
  rendered (AC1).
- **Accessibility (NFR1, AC4):** `aria-label="Toggle navigation menu"` and
  `aria-expanded={isOpen}` (literal `true`/`false`). Because the shell's resize
  guard forces `open` to `false` when crossing to `lg+`, `aria-expanded` can
  never be a stale `true` on a desktop where the control is hidden.
- **Graceful shrink (FR3.2):** welcome text `truncate` + `min-w-0` on its
  wrapper so it ellipsizes instead of pushing controls off-screen; the email
  is `hidden md:inline` (shown from tablet up, hidden at 390px); avatar and
  logout always remain. Header padding `px-4 sm:px-6` matches `main`.
- **Logout + bell preserved (FR3.3, AC11):** `signOut({ callbackUrl: "/login" })`
  unchanged; `aria-label="Log out"` added for the icon-only control.
- **Tap targets (NFR2):** the `Button size="icon"` variant is `h-10 w-10`
  (≈40px), already meeting the target size.

## Footer

```tsx
"use client";
import Link from "next/link";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t bg-white px-4 py-4 text-sm text-gray-500 sm:px-6">
      <div className="flex flex-col items-center justify-between gap-2 sm:flex-row">
        <p>© {year} WhatsApp Business. All rights reserved.</p>
        <nav className="flex items-center gap-4">
          <Link href="/docs" className="hover:text-gray-900 hover:underline">
            Docs
          </Link>
        </nav>
      </div>
    </footer>
  );
}
```

- **Bottom placement (FR1.3, AC1):** the shell content column is a flex column
  with `main` as `flex-1`; the footer is the last child, so it rests at the
  viewport bottom on short pages and is pushed down naturally on tall ones.
- **Content (FR1.2, AC5):** product name "WhatsApp Business" (matching the
  sidebar title and root metadata), copyright with the current year, and a
  **working `/docs` link**. Stacks vertically at 390px (`flex-col`) and spreads
  horizontally from `sm` up (`sm:flex-row`).
- **Link targets (resolves Finding 1 — `/privacy-policy` is a dead route).**
  There is **no** `/privacy-policy` route anywhere under `src/app`
  (`file_search`/`grep` confirm only `<Link href="/privacy-policy">` usages in
  the existing `login`/`register` pages, which 404 today). AC5 requires
  **working** Footer links, so the Footer links **only to `/docs`** (which does
  exist, `src/app/docs/page.tsx`). The pre-existing broken `/privacy-policy`
  links in login/register are **out of scope** for this layout/responsive task
  and are left untouched; this design neither relies on nor propagates that
  404. See the Requirements Reconciliation note below for the FR1.2/AC5 wording
  correction, since the requirements doc incorrectly assumed the page already
  exists.
- **Palette (resolves Finding 4):** text uses `text-gray-500` with
  `hover:text-gray-900` rather than the `text-muted-foreground` /
  `hover:text-foreground` theme tokens. Both are valid, but matching the
  Header's existing gray palette keeps one palette on the white footer and
  guarantees WCAG-AA small-text contrast (gray-500 `#6B7280` on white ≈ 4.6:1).
- **Product name (Finding 5):** the literal `"WhatsApp Business"` is kept inline
  intentionally — it matches the root metadata `title` and the sidebar `h1`
  verbatim. It is not sourced from a shared constant because no such constant
  exists today and introducing one is out of scope for a presentation refactor;
  if a shared `APP_NAME` is later introduced, the Footer should consume it.
- **Classification:** `"use client"` (see Component Boundaries → Finding 7). The
  marker is for honesty; the component uses no client-only APIs beyond
  render-time `Date`.

### Requirements Reconciliation (FR1.2 / AC5 — `/privacy-policy`)

The requirements doc (FR1.2, AC5, and the Out-of-Scope note) assumes
`/privacy-policy` "already uses a centered responsive layout" and must be a
"working Footer link target." That assumption is **factually wrong**: the route
does not exist. Resolving per the review's **preferred** option (keep the task
presentation-only, do not expand scope by adding a new page):

- The Footer links **only to `/docs`**. The product name + copyright + one
  working link still satisfy FR1.2's intent (product name, copyright/year,
  link(s) to real pages) and AC5's intent (a Footer with the product name, the
  current year, and **working** links).
- Effective wording correction: AC5 is read as "working link(s) to existing
  routes (`/docs`)"; the `/privacy-policy` clause is dropped because the page
  does not exist. Adding `src/app/privacy-policy/page.tsx` was the alternative
  but is explicitly **not** chosen here — it would introduce a new route/page,
  expanding beyond the presentation-only scope the requirements and Out-of-Scope
  section commit to. If the product owner later wants a Privacy link in the
  Footer, authoring that page is a separate, in-scope-defined task.

## Per-Page Responsive Audit

No page's data, fetching, or logic changes — only className/structure. Each
entry lists the concrete fix.

| Route | File | Current issue below `lg`/`md` | Fix |
|---|---|---|---|
| Dashboard | `dashboard/page.tsx` | Stat grid already `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6`; Quick Actions / Getting Started already `grid-cols-1 lg:grid-cols-2`. | Verify only; no change expected. Confirm the `text-3xl` stat value fits at 390px (it does inside a `grid-cols-1` card). |
| Numbers list | `numbers/page.tsx` | Header row `flex items-center justify-between` (title + Add) squeezes; each card `CardContent className="flex items-center justify-between p-6"` has a left cluster `flex items-center space-x-4` and a right action cluster `flex items-center space-x-4` (status badge, optional 2nd badge, Cancel, View) that clip at 390px (FR4.3/FR4.5). | Header row → `flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`. Card `CardContent` → `flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between`. **Right action cluster** `flex items-center space-x-4` → `flex flex-wrap items-center gap-2` (resolves Finding 6 — `space-x-*` does not combine with wrapping, so it must become `flex-wrap` + `gap-2`). **Left info cluster** keeps `flex items-center space-x-4` (single row of avatar + text, no wrap needed). |
| Numbers add | `numbers/add/page.tsx` | `Card` is `max-w-lg`; buttons are `w-full`. Already fits. | Verify only; the `max-w-lg` card and full-width buttons are safe at 390px. No change expected. |
| Number detail | `numbers/[id]/page.tsx` | `max-w-lg` card; detail block `grid grid-cols-2 gap-4`; action `Button` row. | Keep `max-w-lg`. Change detail `grid-cols-2` → `grid-cols-1 sm:grid-cols-2` so label/value pairs stack at 390px. Ensure the action button row is `flex flex-wrap gap-2`. |
| Number verify | `numbers/[id]/verify/page.tsx` | No fixed-width/side-by-side rows found in audit. | Verify only; no change expected. |
| Templates list | `templates/page.tsx` | Header row + per-card action cluster (status badge, Send, View, Duplicate, Delete) overflow at 390px (FR4.3/FR4.5). | Header row → `flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`; sync/create buttons already in a `flex gap-2` group — add `flex-wrap`. Card `CardContent` → `flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between`; any action cluster using `space-x-*` → `flex flex-wrap items-center gap-2`. The `line-clamp-2` body already truncates. |
| Template new | `templates/new/page.tsx` | `max-w-2xl` container; several inner `flex items-center justify-between` and `grid grid-cols-2 gap-2` rows. | Keep `max-w-2xl`. For inner `grid-cols-2` button/field pairs that crowd at 390px, use `grid-cols-1 sm:grid-cols-2`. Keep label/toggle `justify-between` rows but add `flex-wrap gap-2` where a control + helper risk clipping. |
| Template detail | `templates/[id]/page.tsx` | Same `max-w-2xl` + `grid grid-cols-2`/`grid-cols-3` + `justify-between` patterns as `new`. | Mirror the `new` fixes: `grid-cols-2`→`grid-cols-1 sm:grid-cols-2`, `grid-cols-3`→`grid-cols-1 sm:grid-cols-3`; `flex-wrap gap-2` on crowded header/action rows. |
| Messages history | `messages/page.tsx` | Header row `flex items-center justify-between` (title + Refresh + Send) crowds (FR4.4/FR4.5); table is already in `overflow-x-auto`. | Header row → `flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between`; the Refresh/Send cluster → `flex flex-wrap items-center gap-2`. Keep the table inside `overflow-x-auto`; the content column's / `main`'s `min-w-0` prevents the table from widening the page (AC6). |
| Messages send | `messages/send/page.tsx` | Outer grid already `grid-cols-1 lg:grid-cols-2` (stacks correctly, AC7). Inner risks: recipient-mode toggle, variable inputs, progress row, results list, submit+reset row. | Keep the outer grid. Verify inner rows fit 390px: the `Send …`/`Reset` row is `flex gap-2` with a `flex-1` submit — keep. The recipient Manual/CSV toggle (`flex gap-1 border rounded-md`) fits. Variable `Input`s are full-width — fine. Results list uses `max-h-64 overflow-y-auto` with `flex items-center justify-between` rows and `font-mono` phone — fine at 390px. Add `min-w-0`/`break-words` only if an overflow is observed on the error banner. No structural change expected beyond confirming (treat as part of the manual 390px gate below). |
| **Chat** | `chat/page.tsx` | Two fixed panels side by side: list `w-[340px] min-w-[280px]` + thread `flex-1`. At 390px both cannot fit (FR4.2, AC8). The root is `flex h-[calc(100vh-0px)] ... overflow-hidden` which ignores the new Header/Footer and `main` padding. | See the detailed **Chat page** section below (resolves Findings 1, 2, 3). |
| Payments | `payments/page.tsx` | Package grid already `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`; Meta-billing sub-grid already `grid-cols-1 sm:grid-cols-3`; balance row `flex items-center justify-between`. | Verify only. Optionally make the balance row `flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between` so the Refresh button drops below the balance at 390px; low risk, apply if it crowds. |
| Settings | `settings/page.tsx` | `max-w-3xl mx-auto`; tab bar `flex space-x-1`; account-info grid already `grid-cols-1 sm:grid-cols-2`; forms already full-width. | Keep `max-w-3xl`. Allow the 3-tab bar to wrap at 390px: add `flex-wrap` to the tab container (the three tabs with icons fit two rows cleanly). No form changes. |

Audit principle: the fix is always "stack first, widen at `sm`/`md`/`lg`" via
`flex-col` → `sm:flex-row` and `flex-wrap`, or `grid-cols-1` →
`sm:grid-cols-*`. Existing correct responsive grids are left untouched to avoid
churn.

### Chat page — single-panel switch, back control, and height (resolves Findings 1, 2, 3)

The chat page keeps **all** logic unchanged: the `?contact=` search param
(`contactParam = searchParams.get("contact")`), `router` navigation, 5000ms
polling, optimistic send, search filter, new-chat, and 24h notice are untouched.
Only className/structure and one new icon import change. The page keeps its
existing **ternary** shape — a `!contactParam` placeholder branch and a
`contactParam` thread branch (not converted to always-rendered siblings) — so
the visibility rules below are written for that ternary.

**1. Root container height (Finding 1 — Option A chosen).** Because `main` is now
`flex min-w-0 flex-1 flex-col p-4 sm:p-6` (see shell contract), the chat root is
the single flex child of a flex column and can take bounded height with
`flex-1 min-h-0`. Change the root:

- From: `className="flex h-[calc(100vh-0px)] bg-[#111B21] text-[#E9EDEF] overflow-hidden"`
- To: `className="flex min-h-0 flex-1 bg-[#111B21] text-[#E9EDEF] overflow-hidden"`

Dropping the fixed `100vh` height lets the chat fill exactly the space `main`
gives it (viewport minus Header, minus Footer, minus `main` padding), so the
Footer rests correctly (FR1.3/AC1) and nothing overflows the page (AC6). The
existing `overflow-hidden` is kept so the two inner panels manage their own
`overflow-y-auto` regions as today. This is the single committed approach — the
brittle `h-[calc(100vh-4rem)]` alternative is explicitly **not** used.

**2. List wrapper (Finding 2).** Current:
`<div className="w-[340px] min-w-[280px] flex flex-col border-r border-[#2A3942]">`.
Replace with a `cn()` call keyed off `contactParam`, and **remove the bare
`min-w-[280px]`** (scope it to `lg` so a `w-full` mobile list has no stale 280px
floor):

```tsx
import { cn } from "@/lib/utils";
// ...
<div
  className={cn(
    "flex flex-col border-r border-[#2A3942] w-full lg:w-[340px] lg:min-w-[280px]",
    contactParam ? "hidden lg:flex" : "flex",
  )}
>
```

- No contact selected → list is `flex` (visible, full width) at every width.
- Contact selected → list is `hidden` below `lg`, `lg:flex` at desktop.
- The static `flex flex-col` is folded into the base string; `w-full` is the
  mobile width, `lg:w-[340px] lg:min-w-[280px]` restores the desktop fixed
  column.

**3. Placeholder branch — `!contactParam` (Finding 2).** This branch renders the
"WhatsApp Business Chat" empty state. Since the list is full-screen on mobile
when no contact is selected, the placeholder must be hidden on mobile and shown
only at `lg+`. Change its wrapper:

- From: `className="flex-1 flex flex-col items-center justify-center bg-[#222E35] text-center p-8"`
- To: `className="hidden lg:flex flex-1 flex-col items-center justify-center bg-[#222E35] text-center p-8"`

**4. Thread branch — `contactParam` (Finding 2).** This branch renders the active
thread. It must be visible on mobile (full width) when a contact is selected and
sit beside the list at `lg+`. Its wrapper is already
`flex-1 flex flex-col bg-[#0C1317] min-w-0`; it stays `flex` (no `hidden`
needed, because this branch is only in the DOM when `contactParam` is truthy —
which is exactly when it should show on mobile). Keep `flex-1 min-w-0` for the
`lg+` side-by-side layout. No class change is strictly required here beyond
confirming it reads `className="flex-1 flex flex-col bg-[#0C1317] min-w-0"`.

Summary of the three regions keyed off `contactParam`:

| Region | Branch in DOM when | Mobile (<`lg`) | Desktop (`lg+`) |
|---|---|---|---|
| List wrapper | always | visible if no contact (`flex`), hidden if contact (`hidden lg:flex`) | always visible fixed `w-[340px]` column |
| Placeholder (`!contactParam`) | only when no contact | `hidden` (list fills screen) | `lg:flex` beside list |
| Thread (`contactParam`) | only when contact | `flex` full width | `flex-1` beside list |

**5. Back control in the chat header (resolves Findings 2 and 3).** The
chat-header row today is `<div className="flex items-center gap-3 ...">` with
exactly **three** children in order: (1) avatar `div`
(`w-10 h-10 ... flex-shrink-0`), (2) info `div` (`flex-1 min-w-0`, name +
number), (3) Refresh `button` (`p-2 rounded-full`, icon-only). Add an
`ArrowLeft` button as the **first child** (before the avatar), visible only
below `lg`, so the resulting row is **back → avatar → name block → Refresh**:

```tsx
// Add to the lucide-react import at the top of the file:
import { Send, RefreshCw, MessageCircle, Search, ArrowLeft } from "lucide-react";

// First child of the chat-header flex row (before the avatar div):
<button
  onClick={() => router.push("/dashboard/chat")}
  className="lg:hidden p-2 rounded-full hover:bg-[#2A3942] transition-colors flex-shrink-0"
  aria-label="Back to conversations"
>
  <ArrowLeft className="w-5 h-5 text-[#AEBAC1]" />
</button>
```

**390px fit (resolves Finding 2 — four-item row).** The Refresh button is
**retained**; the back button is added before it, so at 390px the row holds four
items: back (icon, ~36px) + avatar (`w-10`, 40px, `flex-shrink-0`) + name block
(`flex-1 min-w-0`) + Refresh (icon, ~36px). The two fixed icons plus the fixed
avatar total ~112px of a 390px row; the `flex-1 min-w-0` name block absorbs **all
remaining width and shrinks/ellipsizes** (the inner `<p>`s already rely on
`min-w-0` to truncate), so the row cannot overflow horizontally. The back button
carries `flex-shrink-0` to match the avatar and never collapse. The row keeps
`gap-3`; **if** the manual 390px pass observes crowding (unlikely given the
`flex-1` absorber), drop the row to `gap-2 sm:gap-3`. The back control is
`lg:hidden`, so at 1280px the row returns to its original three items with no
change. This specific row is added to the required manual 390px checklist (see
Testability).

- Navigation is explicitly `router.push("/dashboard/chat")` (clears
  `?contact=`), **not** `router.back()` — this guarantees correct behavior for
  the deep-link / page-refresh case where there is no prior history entry.
  Clearing `contactParam` flips the ternary so the list (now full width) shows
  and the thread branch unmounts.
- `ArrowLeft` is a new import from `lucide-react` (already a dependency, so
  NFR3/zero-dep holds). It matches the existing icon-button styling in that
  header (`p-2 rounded-full hover:bg-[#2A3942]`, `text-[#AEBAC1]`).
- `aria-label="Back to conversations"` satisfies NFR1 for an icon-only control.

**`useSearchParams` Suspense (Finding 3 — pre-existing, out of scope).** The chat
page calls `useSearchParams()` (via `searchParams.get("contact")`) at the top of
a client page. Next.js 14 prefers such usage under a `<Suspense>` boundary; this
is **pre-existing** and this design does not introduce or change it. The chat
`useSearchParams` behavior is unchanged, and any existing Suspense/CSR-bailout
build warning is **out of scope** for this presentation refactor — the
implementer should not attribute a pre-existing warning to this change.

## No API / Business-Logic Changes

This refactor touches only `src/app/dashboard/layout.tsx`,
`src/components/dashboard/*`, and className/structure within
`src/app/dashboard/**/page.tsx`. It does **not** modify any file under
`src/app/api/**`, any server action, `lib/`, Prisma schema/migrations, auth
config, fetch calls, request/response shapes, polling intervals, or the data
rendered on any page (FR5.1–FR5.2). The chat single-panel switch reuses the
existing `?contact=` query param and `router` navigation already present in the
page; it adds no new network or state logic. The chat back control navigates to
a static `/dashboard/chat` path.

## Error Handling & Validation

This is a presentation refactor with no new I/O, so there are no new network
failure modes. The relevant concerns are rendering-safety invariants:

- **Drawer effects (shell):** the `keydown` listener and `body.style.overflow`
  mutation are added only while `open` is true **and only below `lg`**
  (`matchMedia("(min-width: 1024px)")` early-return), and are removed in the
  effect cleanup, including on unmount. The cleanup restores the **previous**
  `overflow` value (captured before locking) rather than hard-coding `""`, so it
  never clobbers a value another component may have set. Failure mode "listener
  leaks / scroll stays locked" is prevented by the dependency array (`[open]`)
  and cleanup; the `lg+` early-return prevents the "scroll locked on desktop,
  no overlay" regression (Finding 4). This is unit/interaction-testable.
- **Resize across `lg` (Finding 4):** a separate mount-time effect subscribes to
  `matchMedia("(min-width: 1024px)")` `change` and sets `open = false` when the
  query starts matching (crossing into `lg+`). This keeps `open`/`aria-expanded`
  honest and guarantees no stale lock survives a widen-while-open. The listener
  is removed on unmount. Recoverable: a missing/old browser without
  `addEventListener` on `MediaQueryList` is not a target (Next 14 baseline is
  evergreen); no fallback is added.
- **Route-change close:** the `[pathname]` effect sets `open` to `false`
  unconditionally; it is idempotent and safe to run on every navigation.
- **Session absent:** unchanged — the server `layout.tsx` redirects to `/login`
  before the shell renders, so the shell can assume an authenticated session.
  `session?.user?.name` / `email` already use optional chaining in `Header`, so
  a transient `undefined` during client hydration renders empty text rather
  than throwing.
- **Footer year:** `new Date().getFullYear()` cannot fail.
- **No new external input:** the components take only `isOpen: boolean`,
  `onMenuClick: () => void`, `onClose: () => void`, and `children`. These are
  internal props with compile-time TypeScript types; there is no user input to
  validate at runtime. The chat back control navigates to a static
  `/dashboard/chat` path (no interpolation), so no injection surface is added.
- **Logging:** none added or removed; existing `console.error` calls in page
  data fetches are untouched.

Invariant ownership: the single source of truth for "is the drawer open" is the
`open` state in `DashboardShell`. `Header` and `Sidebar` never hold their own
copy — they receive `isOpen` and callbacks — which guarantees the hamburger's
`aria-expanded`, the panel transform, and the overlay visibility can never
disagree. The shell also owns the viewport-boundary reset, so this single
boolean cannot drift out of sync with the active breakpoint.

## Testability

- **Unit (React Testing Library + jsdom):** render `DashboardShell` and assert
  (1) clicking the `aria-label="Toggle navigation menu"` button flips the panel
  from `-translate-x-full` to `translate-x-0` and sets `aria-expanded`;
  (2) pressing `Escape` closes it and restores `document.body.style.overflow`
  (jsdom supports `matchMedia` only via a mock — mock it to return
  `matches: false` so the sub-`lg` branch runs); (3) the overlay click handler
  calls `onClose`; (4) `Footer` renders the current year and both links with
  correct `href`s. These assert the FR2.3–2.6 / FR3.1 / AC2–AC5 behaviors
  without a browser.
- **Interaction:** route-change close (FR2.4) is testable by mocking
  `usePathname` to return a new value and asserting the panel closes. The resize
  guard (Finding 4) is testable by dispatching a `change` on a mocked
  `MediaQueryList` with `matches: true` and asserting `open` becomes false.
- **Integration / visual (manual or Playwright):** the per-page overflow checks
  at 390px and 1280px (AC1, AC6–AC9), the chat single-panel switch, and the
  footer-rests-at-bottom behavior are verified in a real viewport — jsdom has no
  layout engine, so these are integration-level checks. A Playwright viewport
  test is the recommended automated follow-up but is optional for this
  presentation change.

If the project has no existing React component test setup, do not introduce one
solely for this change unless the implementer finds it low-cost. **Regression
gate (resolves Finding 8):** `npm run build` + `npm run lint` (AC12) **plus a
required manual viewport pass at 390px and 1280px** across every
`src/app/dashboard/**` route, explicitly checking for horizontal scroll (AC6),
chat single-panel behavior (AC8), the **chat-header four-item row (back +
avatar + name + Refresh) not overflowing at 390px** (Finding 2), the
numbers/templates card button wrapping (AC9), the Footer linking only to the
real `/docs` route (Finding 1), and the footer resting at the bottom on a short
page (AC1). The manual
390px overflow pass is **not optional** — jsdom cannot verify layout, so this
pass is part of the gate, not a nice-to-have.

## Edge Cases

- **Resize across `lg` while drawer is open (resolved — Finding 4):** the
  mount-time `matchMedia` `change` listener in the shell forces `open = false`
  when the viewport crosses into `lg+`. Combined with the scroll-lock effect's
  `lg+` early-return, this means an open drawer that is resized to desktop (a) is
  closed in state, (b) never leaves the body scroll-locked, and (c) keeps
  `aria-expanded` consistent. At `lg+` the panel is also `lg:static
  lg:translate-x-0` and the overlay is `lg:hidden`, so there is no stuck or
  invisible overlay regardless.
- **Rapid toggle:** `setOpen((v) => !v)` uses the functional updater so quick
  taps cannot desync.
- **Tall sidebar content vs short viewport:** the panel is `flex flex-col` with
  the nav region `flex-1`; it already scrolls internally if needed
  (`min-h-screen` at `lg+`, `inset-y-0` below `lg`).
- **Chat with `?contact=` deep link on mobile:** because the switch keys off
  `contactParam`, landing directly on `/dashboard/chat?contact=…` at 390px
  correctly shows the thread branch (full width) with the back control; tapping
  back `router.push("/dashboard/chat")` returns to the full-width list even with
  no prior history entry.

## Files Changed Summary

- `src/app/dashboard/layout.tsx` — delegate to `DashboardShell`; keep session
  gate.
- `src/components/dashboard/dashboard-shell.tsx` — **new** client shell (drawer
  state + pathname/Escape/scroll-lock/resize effects; `main` as flex column).
- `src/components/dashboard/footer.tsx` — **new** `"use client"` presentational
  footer.
- `src/components/dashboard/header.tsx` — add hamburger + props + responsive
  classes + aria.
- `src/components/dashboard/sidebar.tsx` — add overlay + drawer transform +
  props (two-group nav preserved).
- `src/app/dashboard/chat/page.tsx` — single-panel-at-a-time below `lg`
  (list/placeholder/thread visibility), `ArrowLeft` back control, and
  `flex-1 min-h-0` height fix (drop fixed `100vh`).
- `src/app/dashboard/numbers/page.tsx`, `numbers/[id]/page.tsx`,
  `templates/page.tsx`, `templates/new/page.tsx`, `templates/[id]/page.tsx`,
  `messages/page.tsx`, `messages/send/page.tsx`, `settings/page.tsx` — className
  responsive fixes per the audit table.
- `payments/page.tsx`, `dashboard/page.tsx`, `numbers/add/page.tsx`,
  `numbers/[id]/verify/page.tsx` — verify-only; change only if an overflow is
  observed during the manual 390px pass.

## Responses to Design Review Findings (rev-2 review — current)

- **Finding 1 (HIGH) — `/privacy-policy` is a dead route; Footer must not link
  to a 404 — ADDRESSED.** Verified independently (`file_search`/`grep`): no
  `/privacy-policy` route exists under `src/app`; the only references are the
  pre-existing `login`/`register` links that 404. Per the review's **preferred**
  option, the Footer now links **only to `/docs`** (which exists) and the design
  no longer asserts a working `/privacy-policy` link. A "Requirements
  Reconciliation" note corrects the FR1.2/AC5 wording (AC5 read as "working
  link(s) to existing routes"), and the choice to **not** add a new
  `privacy-policy` page is recorded (keeps the task presentation-only; the
  pre-existing broken links in login/register are out of scope and untouched).
- **Finding 2 (MEDIUM) — chat-header four-item row 390px fit not demonstrated —
  ADDRESSED.** The back-control section now states the chat-header row's three
  existing children (avatar, `flex-1 min-w-0` name block, Refresh button),
  confirms the Refresh button is **retained** with the back button inserted
  before the avatar, and shows the arithmetic: two icon buttons + avatar ≈ 112px
  fixed, with the `flex-1 min-w-0` name block absorbing/truncating the remainder
  so the row cannot overflow at 390px. The back button gains `flex-shrink-0`; a
  `gap-2 sm:gap-3` fallback is specified if crowding appears. This row is added
  to the required manual 390px checklist.
- **Finding 3 (NIT) — `useSearchParams` Suspense boundary — ADDRESSED (noted).**
  Explicitly noted that the chat `useSearchParams` behavior is unchanged and any
  pre-existing Suspense/CSR-bailout warning is out of scope for this change.
- **Finding 4 (NIT) — Footer contrast on `bg-white` — ADDRESSED.** The Footer now
  uses `text-gray-500` / `hover:text-gray-900` (matching the Header's gray
  palette) instead of the muted theme tokens, giving ~4.6:1 contrast on white
  (WCAG-AA for small text).
- **Finding 5 (NIT) — Footer product-name literal — ADDRESSED (noted).** The
  inline `"WhatsApp Business"` literal is kept intentionally (matches root
  metadata + sidebar `h1`); no shared constant is introduced since none exists
  and it is out of scope, with a note to consume a future `APP_NAME` if one is
  added.

## Responses to Prior (rev-1) Design Review Findings

- **Finding 1 (HIGH) — chat height / `main` not a flex column — ADDRESSED.** The
  shell now renders `main` as `flex min-w-0 flex-1 flex-col p-4 sm:p-6` (Option A
  from the review). The chat root changes from `h-[calc(100vh-0px)]` to
  `flex min-h-0 flex-1 ... overflow-hidden`, so its height is bounded by the
  space `main` leaves after Header, Footer, and `main` padding. The brittle
  `100vh` calc alternative is explicitly rejected. Confirmed that making `main` a
  flex column does not change the flow of non-flex pages (a lone block child in a
  column renders as before).
- **Finding 2 (MEDIUM) — chat single-panel class ambiguity — ADDRESSED.** Exact
  classes are now given for all three regions keyed off `contactParam`: list
  wrapper `cn("flex flex-col border-r ... w-full lg:w-[340px] lg:min-w-[280px]",
  contactParam ? "hidden lg:flex" : "flex")` with the bare `min-w-[280px]`
  removed; placeholder branch gains `hidden lg:flex`; thread branch stays `flex`
  full width (only in DOM when a contact is selected). The design states the page
  keeps its existing **ternary** shape (not converted to always-rendered
  siblings) and a region table documents each branch's DOM presence and
  per-breakpoint visibility.
- **Finding 3 (MEDIUM) — back control underspecified — ADDRESSED.** Specified as
  an `ArrowLeft` button (new `lucide-react` import), placed as the first child of
  the chat-header `flex` row, `className="lg:hidden ..."`,
  `onClick={() => router.push("/dashboard/chat")}` (explicitly not
  `router.back()`), `aria-label="Back to conversations"`, with matching existing
  icon-button styling.
- **Finding 4 (MEDIUM) — scroll-lock at `lg+` — ADDRESSED.** The scroll-lock
  effect now early-returns when `matchMedia("(min-width: 1024px)").matches`, so
  it never locks at `lg+`. A second mount-time effect listens for the
  `matchMedia` `change` event and forces `open = false` on crossing into `lg+`,
  eliminating the stale-open/stale-lock regression. Exact code is in the shell
  contract.
- **Finding 5 (NIT) — nav two-group structure — ADDRESSED.** The Sidebar section
  now states the six-item `navigation` array and the two divider-separated bottom
  links (`/docs`, `/dashboard/settings`) are both preserved in order, and that
  Docs/Settings are not members of the `navigation` map.
- **Finding 6 (NIT) — numbers card `space-x-4` clusters — ADDRESSED.** The audit
  row now states the **right action cluster** `flex items-center space-x-4`
  becomes `flex flex-wrap items-center gap-2` (because `space-x-*` does not wrap
  cleanly), while the **left info cluster** keeps `space-x-4`.
- **Finding 7 (NIT) — Footer server/zero-JS rationale — ADDRESSED.** Dropped the
  inaccurate "server component / zero JS" claim; `Footer` is described as a plain
  presentational component that ships in the client bundle and is marked
  `"use client"` for honesty.
- **Finding 8 (NIT) — AC6 depends on manual pass — ADDRESSED.** The Testability
  section now defines the regression gate as build + lint **plus a required
  manual 390px/1280px viewport pass**, called out explicitly as non-optional.

## Change log

- 2025-02-14 (rev 3) — Resolved rev-2 review findings: dropped the dead
  `/privacy-policy` Footer link (link to `/docs` only, no new page added) with a
  requirements reconciliation note; demonstrated the chat-header four-item row
  fits 390px (back + avatar + `flex-1` name + Refresh, `flex-shrink-0` + gap-2
  fallback) and added it to the manual checklist; noted the pre-existing chat
  `useSearchParams` Suspense is out of scope; switched the Footer to the gray
  palette (`text-gray-500`/`hover:text-gray-900`) for AA contrast on white; kept
  the product-name literal intentionally.
- 2025-02-14 (rev 2) — Resolved all 8 design-review findings: committed to
  Option A for chat height (`main` as flex column + chat root `flex-1 min-h-0`),
  fully specified the chat single-panel visibility classes and ternary shape,
  specified the `ArrowLeft` back control, gated/reset the drawer scroll-lock
  around `lg`, documented the two-group sidebar, fixed the numbers-card cluster
  classes, corrected the Footer classification, and made the manual 390px pass a
  required gate.
- 2025-02-14 (rev 1) — Initial design for the dashboard layout refactor and
  mobile-responsive pass.
