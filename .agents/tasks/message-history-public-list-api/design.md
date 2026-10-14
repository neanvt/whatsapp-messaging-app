# Design — Message history/detail visibility + third-party message-list API

## Overview

This enhancement adds "what was actually sent + live delivery status" visibility
in three surfaces of the existing multi-tenant WhatsApp SaaS, with **no schema
change and no new runtime dependency**. (1) A new **pure** resolved-body-preview
helper substitutes the stored variable values into a template body's
`{{name}}`/`{{n}}` placeholders. (2) The session route `GET /api/messages` is
widened by four fields and the dashboard history page (`src/app/dashboard/messages/page.tsx`)
gains a per-row **expandable detail panel** plus distinct live-status chips with a
manual Refresh. (3) A new public **LIST** endpoint `GET /api/v1/messages` (API-key
auth, owner + bound-number scoped) lets an integrator list and incrementally sync
message statuses; the existing single-status route `GET /api/v1/messages/{id}` is
kept and made shape-consistent with the list. The in-app docs page
(`src/app/docs/page.tsx`) and the root `scratchpad.md` are updated in the same
change.

The design deliberately reuses the established patterns already in the repo:
`authenticateApiKey`/`unauthorized` for public auth, the identical-404
no-existence-oracle isolation of `src/app/api/v1/messages/[id]/route.ts`, the
`parseJsonColumn`-driven defensive JSON parsing and the `parseTemplateBody`
single-scan parameter model from `src/lib/template-params.ts`/`template-format.ts`,
and the `select`/`map` response-shaping pattern of
`src/app/api/v1/templates/route.ts`. The send core `src/lib/send-template.ts` is
**read, not modified**.

### Technology stack (locked)

Next.js 14 App Router route handlers (TypeScript 5), Prisma 5 over Turso/libSQL,
NextAuth v4 for the session route, Zod only where an existing route already uses it
(the public GET validates query params by hand to match the templates route's
style). UI uses the existing `Card`/`Badge`/`Button`/`Input` components and
`lucide-react` icons. No vitest/jest is configured; the regression gate is a clean
`next build`/type-check plus manual request checks (NFR6).

### Critical grounding fact that shapes the design

`sendTemplateMessage` persists the variable VALUES that were actually sent into
`Message.templateVariables` with **three distinct stored shapes** (verified in
`src/lib/send-template.ts`, and matching the already-landed prerequisite fix the
requirements call out):

```ts
templateVariables:
  namedParams && Object.keys(namedParams).length > 0
    ? JSON.stringify(namedParams)   // named-map form (public templateParams) → JSON OBJECT
    : variables?.length
      ? JSON.stringify(variables)   // positional form → JSON ARRAY
      : null,                       // neither supplied → null
```

Therefore:

- A **named** send (named-map / `templateParams`) stores a JSON **object/record**;
  a **positional** send stores a JSON **array**; a send with no variables stores
  `null`. **All three shapes occur in stored rows today** — none is a rare
  forward-compat path. The helper (§1) and the shaper (§3.7) must handle array,
  record, and null equally.
- The record case (a named send) and the `null` case (legacy rows / sends with no
  values) are both real and must both be first-class. For a named template whose
  row happens to have `null` variables (no values were sent), the resolved preview
  correctly leaves `{{name}}` placeholders intact (missing-value behavior); for the
  common named send its stored **record** resolves each `{{name}}` to its value.
  This is correct, non-throwing, and documented — it is NOT a reason to fork send
  logic (NFR5, out of scope). The dashboard detail view and the public `bodyPreview`
  both inherit this behavior.

---

## 1. The pure resolved-body preview helper

### File and signature

Add to **`src/lib/template-params.ts`** (the pure, DB/network-free module that
already owns `parseTemplateBody`/`resolveBodyParams` and the `PLACEHOLDER_RE`
single scan). Placing it here keeps the placeholder classification single-sourced
and avoids `template-format.ts` importing anything new. `template-format.ts` is for
route-facing formatting that may not live in a route module; the preview helper is
a pure primitive and belongs beside the model it reuses.

```ts
// src/lib/template-params.ts  (new export)

// Resolve a template body to a human-readable preview by substituting the stored
// variable values into {{name}}/{{n}} placeholders. PURE — no Prisma/fetch/throw.
// `templateVariables` may be: a positional string[] (numbered form, and today's
// stored form), a { name: value } record (named form), the raw JSON string of
// either, null, or malformed. Any placeholder with no resolvable value is left
// intact; extra values are ignored. Never throws (FR1.3/FR1.4, AC1–AC5).
export function resolveBodyPreview(
  body: string | null | undefined,
  templateVariables: string | string[] | Record<string, string> | null | undefined,
): string
```

### Algorithm (reusing existing primitives)

1. **Empty body short-circuit.** If `!body` return `""` (FR1.4). Otherwise keep
   working against `body`.
2. **Normalize the values** to one of `array | record | null`, without throwing,
   and **bind the result once to a variable named `values`**. From this step
   onward the algorithm refers ONLY to `values` — the pre-normalization name
   `parsed` and the ad-hoc names `arr`/`parsed` used in earlier drafts are retired
   (Finding 1). The normalization is:
   - If `templateVariables` is a string, parse it with the inline try/catch (same
     defensive contract as `parseJsonColumn`; see the circular-import note below)
     to get a `parsed: unknown`.
   - Then **collapse `parsed` to a container or null** with the exact same rule
     `shapePublicMessage` uses (§3.7), so the helper and the shaper never disagree:
     - `Array.isArray(parsed)` → `values` is that positional array (`string[]`);
     - `parsed && typeof parsed === "object"` → `values` is that record;
     - **anything else** (a parsed scalar `number`/`string`/`boolean`, `undefined`,
       or `null`) → `values = null` ("no values"). This is the explicit
       "collapse non-container to null" rule — do NOT "use a scalar directly".
   - If `templateVariables` is already an array or a plain object (the public path
     passes the already-normalized `vars` from `shapePublicMessage`), that value IS
     `values` and no parse happens.

   After this step `values` is exactly one of: `string[]`, a `Record`, or `null`.
   Nothing downstream reads `templateVariables` or `parsed` again.
   - Note: `template-format.ts` imports from `template-params.ts`, so to avoid a
     circular import the helper will **inline the same two-line try/catch** that
     `parseJsonColumn` uses rather than importing it. The behavior is identical
     (null on malformed) and keeps `template-params.ts` free of a back-edge to
     `template-format.ts`. This satisfies FR1.4's "reuse `parseJsonColumn`
     behavior" by replicating the exact defensive contract in the pure module;
     the design chooses this over introducing a circular dependency.
3. **Classify the body** with the existing `parseTemplateBody(body)` so the
   named-vs-numbered decision can never drift from the send path (FR1.2). Result is
   a `ParamModel` (`named` | `numbered` | `none`).
4. **Resolve each placeholder token against `values`** (the single normalized value
   from step 2). The three body kinds are specified exhaustively:
   - **`model.kind === "none"`**: no placeholders — return `body` unchanged.
   - **`model.kind === "numbered"`** — token `{{k}}` (1-based):
     - `values` is an array **and** `(k-1)` is in range → `String(values[k-1])`;
     - **otherwise** (`values` is `null`, `values` is a record, or the index is out
       of range) → **undefined** → leave `{{k}}` intact.

     There is no other numbered case; a record passed to a numbered body resolves
     nothing (it falls into the "otherwise" branch), and a `null` leaves every
     `{{k}}` intact.
   - **`model.kind === "named"`** — token `{{name}}`. Both the **record** sub-case
     (the common stored shape for a named send) and the `null` sub-case
     (legacy/no-values rows) are real per the grounding fact, so both are stated
     explicitly:
     - if `values` is a **record** → `values[name]` (undefined when the key is
       absent → leave `{{name}}` intact). This is the common case for a named send,
       whose stored `templateVariables` is a JSON object;
     - **if `values` is `null` → there is no lookup; every `{{name}}` is left
       intact** (a named template whose row stored no values — e.g. legacy rows or a
       send with no variables). Non-throwing and correct;
     - if `values` is an **array** (a positional array stored for a named template —
       uncommon but possible) → map by the declared order from `model.names`, i.e.
       the token `name` at declared position `i` resolves to `values[i]`, mirroring
       how `resolveBodyParams` accepts positional input for a named template. Out of
       range → undefined → leave intact.
5. **Substitute via one `String.prototype.replace`** over the same
   `PLACEHOLDER_RE` pattern (a fresh non-global or global regex literal — do not
   reuse the module-level stateful `g` regex instance across calls; use
   `body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, cb)`). In the callback, apply the
   step-4 rule for the body's `model.kind` to look the token up **in `values`**
   (numeric token → position; named token → record key or declared-order index). If
   the lookup yields a defined value, return `String(value)` (coercing a non-string
   defensively); **if the lookup is undefined, return the original matched
   placeholder unchanged** (FR1.3/AC3).
6. **Extra values** (array longer than placeholders, or record keys with no
   placeholder) are never visited by the replace callback, so they are silently
   ignored (FR1.3/AC5).
7. The function has **no `throw`** on any branch; every parse is guarded and every
   lookup tolerates `undefined`.

### Error / edge-case table (helper)

| Input condition | Behavior | AC |
|---|---|---|
| `body` null/empty | return `""` | FR1.4 |
| `body` has no placeholders | return `body` unchanged | — |
| named body + `values` is a record (common named-send shape) | each `{{name}}` → `values[name]` | AC2 |
| named body + `values` is `null` (legacy / no-values row) | every `{{name}}` left intact, no throw | AC3/FR4.5 |
| numbered body + `values` is an array | `{{k}}` → `String(values[k-1])` when in range | AC4 |
| numbered body + `values` is a record | nothing resolves — every `{{k}}` left intact | FR4.3 |
| placeholder with no resolvable value | leave `{{token}}` intact, no throw | AC3 |
| `templateVariables` null/empty/malformed JSON → `values = null` | placeholders left intact, no throw | AC4 |
| extra values with no placeholder | ignored, no throw | AC5 |
| value present but non-string | `String(value)` | — |
| named body + `values` is a positional array | map by `model.names` declared order (`name@i → values[i]`) | A2 |

### Testability

Pure, synchronous, no DB/network — unit-testable in isolation (NFR6). If a test
runner is later added, the standard choice for this Next.js/TS stack is **vitest**;
until then verification is the build/type-check and a manual dashboard spot check.
No test runner is set up as part of this change (none exists today).

---

## 2. Dashboard: detail view, status chips, refresh, session route

### 2.1 Session route `GET /api/messages` enhancement (FR2, AC5)

`src/app/api/messages/route.ts` currently does `findMany` with `include: { template: { select: { name } }, whatsappNumber: { select: { phoneNumber } } }`. Because it uses `include` (not `select`), it ships **every** `Message` scalar to
the browser — including internal foreign keys and ids (`userId`,
`whatsappNumberId`, `conversationId`, `metaMessageId`) that no requirement asks for.
Only `template.body` is additionally missing.

**Decision — switch to an explicit `select` (Finding 4 fix).** Rather than keep
`include` and silently widen the payload with internal FKs, the route is changed to
an explicit `select` of **exactly** the fields FR2.1 (pre-existing) + FR2.2
(additive) enumerate, plus the two relations. This resolves the §2.1/§2.2
inconsistency: the route's returned shape now matches the client `Message`
interface in §2.2 one-for-one, and `userId`/`whatsappNumberId`/`conversationId`/
`metaMessageId` are **no longer shipped** to the browser. The page is already
`userId`-scoped so `include` was not a cross-tenant leak, but narrowing to `select`
removes an unnecessary surface and makes the client/server contract explicit:

```ts
const messages = await prisma.message.findMany({
  where: { userId: session.user.id },
  select: {
    id: true,
    recipientPhone: true,
    status: true,
    direction: true,
    templateVariables: true,   // raw stored JSON string (parsed client-side)
    errorMessage: true,
    content: true,             // for the no-template fallback (FR1.2/FR3.2)
    sentAt: true,
    deliveredAt: true,
    readAt: true,
    createdAt: true,
    template: { select: { name: true, body: true } },
    whatsappNumber: { select: { phoneNumber: true } },
  },
  orderBy: { createdAt: "desc" },
  take: 100,
});
```

The `where userId: session.user.id`, `orderBy createdAt desc`, `take 100`, and the
401-for-unauthenticated branch are **unchanged** (FR2.1/FR2.3, AC5); the existing
`try/catch → 500` is retained. Every field the current table already consumes
(`recipientPhone`, `status`, `sentAt`, `template.name`, `whatsappNumber.phoneNumber`,
`errorMessage`) is in the `select`, so the current table is not broken (FR2.1); the
additive set from FR2.2/FR2.3/AC5 (`id`, `direction`, `templateVariables`,
`template.body`) is present. `templateVariables` is returned **raw** (the stored
JSON string or null) — the dashboard parses it client-side for display.

Edge cases: inbound/free-text rows have `templateId = null`, so `template` is
`null` and `template.body` is simply absent — handled by the detail view's fallback
(FR3.2). No new error branches; the existing `try/catch → 500` is retained.

### 2.2 Dashboard detail view — chosen approach: expandable row (A3, FR3)

**Decision:** an **expandable inline row** (progressive disclosure), not a modal or
a new route. Reasoning: the page is a single `"use client"` component that owns the
`messages` state and the 10s auto-refresh; an expandable panel keeps all data and
refresh logic in one place, needs no new route in the dashboard shell, and reuses
the existing `overflow-x-auto` table and `Card`/`Badge` components (FR1.1/A3). A modal
would duplicate state wiring and a detail route would require a second fetch and new
navigation — both heavier for no benefit here. (A3 explicitly permits a modal; the
design picks the row for cohesion with the existing shell.)

Implementation sketch:

- Align the client `Message` interface **exactly** with the §2.1 `select` (so the
  client/server shape is pinned on both ends — Finding 4):

  ```ts
  interface Message {
    id: string;
    recipientPhone: string;
    status: string;
    direction: string;
    templateVariables: string | null;      // raw JSON string
    errorMessage: string | null;
    content: string | null;                // no-template fallback (FR3.2)
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    createdAt: string;
    template: { name: string; body: string | null } | null;
    whatsappNumber: { phoneNumber: string } | null;
  }
  ```

  (Dates arrive as JSON strings over the wire.) The interface lists **only** the
  fields §2.1 selects — no `userId`/`whatsappNumberId`/`conversationId`/
  `metaMessageId`, matching the narrowed server payload.
- Add `const [expandedId, setExpandedId] = useState<string | null>(null)`.
- Make each `<tr>` clickable (add a leading chevron cell using `lucide-react`
  `ChevronRight`/`ChevronDown`, consistent with existing icon usage); clicking
  toggles `expandedId`.
- When `expandedId === message.id`, render a second `<tr>` whose single `<td
  colSpan={6}>` holds the detail panel inside a muted `div` (not a new Card, to
  avoid nesting a Card in a table). The detail panel shows:
  - Template name (or "Free-text / inbound" when `template === null`), direction,
    the status badge, `sentAt`/`deliveredAt`/`readAt` timestamps, and
    `errorMessage` (only when present, styled with the destructive text color).
  - **Variable values:** parse `templateVariables` client-side via a tiny local
    `safeParse` (try/catch → null) and render either index→value (array) or
    name→value (object) as a small key/value list; render nothing when null.
  - **Resolved body preview:** call `resolveBodyPreview(message.template?.body,
    message.templateVariables)` (the FR1 helper, imported from
    `@/lib/template-params` — it is pure and safe to import into a client
    component) and render the returned string in a `<pre>`/wrapped block. Because
    the helper never throws and leaves unresolved placeholders intact, a malformed
    or null `templateVariables` still renders (AC3, FR1.3).
  - **No-template fallback:** when `template === null`, omit template-specific
    fields and show `content` instead (FR1.2/FR3.2).

The leading chevron cell adds one `<th>`/`<td>` column; the five existing header
cells remain, so `colSpan` for the detail row is `6`.

### 2.3 Live status chips (FR3.1, AC6)

Replace the current `getStatusBadge` (which maps `read` to the same `success`
variant as `delivered` and lacks `received`) with a map that renders all live
states **distinctly**:

| status | Badge variant | label |
|---|---|---|
| `queued` | `outline` | Queued |
| `sent` | `secondary` | Sent |
| `delivered` | `success` | Delivered |
| `read` | `default` | Read |
| `failed` | `destructive` | Failed |
| `received` | `warning` | Received |

Reasoning: all six states render with a **distinct** existing `Badge` variant, so no
two live states collide (Findings 4/5). The repo's `badgeVariants` CVA config
provides exactly `default | secondary | destructive | outline | success | warning`
(verified in `src/components/ui/badge.tsx` — there is **no** blue/`info` variant):

- `read` must be visually distinct from `delivered` (today both map to `success`),
  so `read` uses the primary/`default` variant. **No new Badge variant is added** —
  the earlier "add a distinct blue variant" option is REMOVED and explicitly
  **out of scope** (Finding 5): editing the shared `badge.tsx` would widen the blast
  radius beyond this task (NFR4) and `default` already provides the needed contrast.
- `received` uses the `warning` variant so it is **not** identical to `queued`
  (`outline`) — closing the overlap flagged in Finding 4. `received` only ever
  appears on inbound rows (`direction: "inbound"`), so a distinct chip reads
  naturally as "inbound message".

The webhook writes `status`/`deliveredAt`/`readAt`/`errorMessage` by `metaMessageId`
(`updateMany`, unchanged — out of scope), so after a Refresh the chip reflects the
latest state (AC6/FR3.1), and `failed` surfaces `errorMessage` in the detail panel.

**"Sent" column precedence — stated to match the live code (Finding 3).** The
current column in `src/app/dashboard/messages/page.tsx` renders
`deliveredAt ? "Delivered …" : readAt ? "Read …" : sentAt ? … : "-"` — i.e. it checks
`deliveredAt` **before** `readAt`, so the precedence is **`deliveredAt` > `readAt` >
`sentAt`** (verified in source; a read message that also has a `deliveredAt` shows
"Delivered"). The earlier draft wrongly described this as "read > delivered > sent";
that is corrected here. This column is **left exactly as-is** — the design does NOT
reorder it. Making `read` win would be an intentional behavior change with no
requirement behind it, and FR3.2 (and the task) explicitly pin the precedence as
`deliveredAt` > `readAt` > `sentAt` and require it to stay unchanged. The new,
read-vs-delivered distinction the UX needs is delivered entirely by the status
**chip** (where `read` → `default`, `delivered` → `success`), not by this timestamp
column. §2.3 and §2.4 therefore agree: the chip map changes; the "Sent" timestamp
column is untouched.

### 2.4 Manual Refresh (FR3.3)

**No change needed** — the page already has a Refresh `Button` calling
`fetchMessages()` and a 10s `setInterval(() => fetchMessages(true), 10000)`. Both
are preserved; no new polling infrastructure is added (Out of Scope). The only
adjustment is that the detail panel reads from the same refreshed `messages` state,
so an expanded row updates in place on the next refresh. The "Sent" timestamp column
is **not** modified here either (its `deliveredAt` > `readAt` > `sentAt` precedence is
kept exactly, consistent with §2.3) — only `getStatusBadge` is replaced.

---

## 3. Public LIST endpoint `GET /api/v1/messages`

### 3.1 Location and auth

Add a `GET` handler **alongside the existing `POST`** in
`src/app/api/v1/messages/route.ts`. It authenticates with
`authenticateApiKey(request)` and returns `unauthorized()` on `null` — API-key auth
only, no session fallback (FR6.2/AC10). This mirrors the single-status route exactly.

### 3.2 Isolation (NFR1, FR6.3, AC9)

Every query is scoped to **`userId: ctx.userId` AND `whatsappNumberId: ctx.number.id`** — identical to `[id]/route.ts`. There is no code path that drops either
clause. A cursor/`after` id or a filter never widens scope; they are additive
`AND` conditions. An unknown `after` id returns an **empty page** (no 404, no
existence oracle), consistent with the identical-404 property (FR6.7/AC14).

### 3.3 Query contract

Parse `const url = new URL(request.url)` and read params by hand (matching the
templates route's style; Zod is not introduced for GET).

| Param | Rule | On invalid |
|---|---|---|
| `limit` | positive **integer**; default **50**, max **100**; `>100` clamped to 100 | non-integer / non-positive / NaN → fall back to 50 (FR6.5/AC11) |
| `status` | one of `sent\|delivered\|read\|failed\|queued` | unknown value → **400** (FR6.5/AC12) |
| `since` | **ISO 8601 instant** (`Z` or `±HH:mm` offset, optional fractional seconds); filter `createdAt > since` | fails the `ISO_RE` shape check → **400** (FR6.5/AC13) |
| `after` | message id keyset cursor | unknown / deleted / cross-tenant id → empty page, no 404 (FR6.7/AC14) |

**`limit` parsing — exact rule (Finding 6 fix).** The parse is pinned so that
positive non-integers (`25.7`), non-numeric (`abc`), zero, and negatives all fall
back to the default and only a positive integer is honored (then clamped):

```ts
const n = Number(rawLimit);               // "" / absent → NaN below via guard
const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 50;
```

So `limit=200 → 100`, `limit=25.7 → 50`, `limit=abc → 50`, `limit=0 → 50`,
`limit=-5 → 50`, absent → 50.

Validation order: `status` and `since` are validated **before** touching the DB and
return `400` with a clear message (e.g. `Invalid status. Allowed: ...`,
`Invalid 'since' timestamp ...`). The status allow-list is a
`const KNOWN_STATUS = ["queued","sent","delivered","read","failed"] as const` local
array (note: `received` is deliberately not an allowed public **filter** value —
public sends are outbound; filtering is restricted to the send-lifecycle states in
FR6.5. See §3.6/§4.1: an inbound row's `status: "received"` can still be *returned*
in an unfiltered page, it just cannot be filtered for).

**Where the local validators live (Finding 7 fix).** `parseSince`, the `ISO_RE`
regex, `KNOWN_STATUS`, and the `limit` parse are **local, non-exported** `const`/
`function` declarations inside the route file (`src/app/api/v1/messages/route.ts`).
The Next.js App Router restriction that §3.7 cites — "a route module may only
*export* HTTP method handlers" — applies to **exports only**, not to local
declarations, so these validators do not need to move to `template-format.ts`. Only
the cross-route-shared `shapePublicMessage` (used by both the LIST and the `[id]`
route) lives in `template-format.ts`; the single-route-local validators stay in the
route file.

**`since` validation — ISO 8601 shape check.** The contract
(FR6.5/AC13) says plain "ISO 8601" and "malformed → 400"; the goal is to **reject
junk** (`"2026"`, `"March 1 2026"`) without forcing one canonical serialization. A
strict `new Date(s).toISOString() === s` round-trip is **too strict** — it only
accepts the canonical UTC millisecond form and wrongly 400s legitimate ISO 8601
instants an integrator will naturally send, e.g. `2026-10-13T12:00:00Z` (no
milliseconds) and `2026-10-13T12:00:00+05:30` (offset timezone, common for an IST
caller). The design does **not** use the round-trip check and does **not** rely on
bare `Date.parse` (which silently reinterprets non-ISO input). Instead it validates
the ISO 8601 **shape** with a regex that accepts `Z` or a `±HH:mm` offset and
optional fractional seconds, then parses with `Date`:

```ts
// Accept an ISO 8601 instant: date + time, optional fractional seconds, and a
// mandatory zone designator (Z or ±HH:mm). Rejects bare years / locale strings.
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function parseSince(s: string): Date | null {
  if (!ISO_RE.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
```

A `since` value passes iff it matches `ISO_RE` **and** parses to a valid `Date`.
Anything else — a bare year, a locale date, a missing zone designator — returns
**400** `{"error":"Invalid 'since' timestamp; expected an ISO 8601 instant (e.g. 2026-10-13T12:00:00.000Z or 2026-10-13T12:00:00+05:30)"}`. The DB filter then uses
the parsed `Date`: `createdAt: { gt: since }` (not re-parsing the raw string). The
docs (§4.1) describe `since` as "an ISO 8601 instant with `Z` or a `±HH:mm` offset;
fractional seconds optional" so the contract and the check agree. `parseSince` is a
**local, non-exported** helper in the route file (see §3.3 note below).

### 3.4 Pagination model — chosen: keyset `after` as the canonical cursor, `since` as an additive filter

**Decision:** `after` is the **pagination cursor** returned as `nextCursor`;
`since` is an **incremental-sync filter** that may be combined with `after`.
Precedence when both are present: both apply as `AND` conditions (`createdAt > since`
AND the keyset condition for `after`). Reasoning: a pure timestamp cursor is unsafe
with equal `createdAt` values (cuid rows created in the same millisecond could be
skipped or duplicated); a keyset on the row's `(createdAt, id)` is stable. `since`
remains useful for "give me everything new since my last sync" without tracking an
id.

**Index reality (corrects the earlier "existing indexes" claim).** `model Message`
in `prisma/schema.prisma` has **no `@@index` at all** — there is no index on
`createdAt`, `(createdAt, id)`, `userId`, or `whatsappNumberId`. The keyset query
(scoped by `userId` + `whatsappNumberId`, `orderBy createdAt desc`, `take limit+1`)
is **correct but relies on a table scan + sort per page**; it does not use any
existing index because none exists. **Decision:** accept the scan at the current
volume rather than add an index — adding one is out of scope (NFR3 forbids
`db:push`/schema migration), the LIST is a low-frequency integrator-sync call
bounded by `take <= 100`, and no requirement asks for an index. If volume later
makes this a hotspot, the follow-up is an **idempotent `@libsql/client` script**
(never `db:push`), e.g.:

```sql
CREATE INDEX IF NOT EXISTS idx_message_scope_created
  ON Message (userId, whatsappNumberId, createdAt DESC, id DESC);
```

This is explicitly deferred, not done in this change. See the revised NFR7 note in
§3.11 and the non-regression list.

Keyset mechanics for `createdAt desc` ordering:

- Resolve the `after` row's `createdAt` with a scoped lookup:
  `prisma.message.findFirst({ where: { id: after, userId, whatsappNumberId }, select: { createdAt: true, id: true } })`. If not found (unknown id, cross-tenant
  id, **or a cursor row that has since been deleted/filtered out of scope**),
  return an **empty page** `{ data: [], nextCursor: null, hasMore: false }` (FR6.7/AC14,
  no existence oracle — the scoped lookup already enforces isolation; the
  deleted-cursor case takes the identical no-oracle empty-page path as an unknown
  id, so an integrator paging a cursor whose anchor row was deleted simply stops
  cleanly rather than erroring).
- With the anchor `{ createdAt: cAt, id: cId }`, the "rows strictly after this one
  in `createdAt desc`" condition is:
  ```
  OR: [
    { createdAt: { lt: cAt } },
    { createdAt: cAt, id: { lt: cId } },   // tie-break by id desc within same instant
  ]
  ```
  This composes with the base `AND` (owner + number [+ status] [+ since]).

**Required ordering — explicit secondary sort key (Finding 1 fix).** The keyset
`OR` predicate above assumes `id desc` tie-break *within* an equal `createdAt`.
Prisma/SQLite does **not** guarantee that tie-break unless it is stated in the
query's `orderBy`. Therefore the LIST query MUST specify a **compound** ordering
whose keys and directions exactly match the keyset predicate — never
`orderBy: { createdAt: "desc" }` alone:

```ts
const rows = await prisma.message.findMany({
  where,                                            // owner + number [+ status] [+ since] [+ keyset OR]
  orderBy: [{ createdAt: "desc" }, { id: "desc" }], // REQUIRED — matches the keyset OR predicate
  take: limit + 1,
  select: UNIFIED_SELECT,                           // §3.6
});
```

Because the sort is now `(createdAt desc, id desc)`, `rows[limit-1]` is
unambiguously the last row of the page under that total order, so the `nextCursor`
derived from it in §3.5 anchors the next page correctly with no skipped or repeated
rows at millisecond boundaries. An implementer must not drop the secondary
`{ id: "desc" }`.

### 3.5 Fetch, over-fetch for hasMore, response envelope (FR6.8/AC9)

`take: limit + 1` to detect more rows: if `rows.length > limit`, there is a next
page — slice to `limit`, set `nextCursor = rows[limit-1].id`, `hasMore = true`;
otherwise `nextCursor = null`, `hasMore = false`.

**Envelope (fixed, documented):**

```json
{ "data": [ /* items */ ], "nextCursor": "<id|null>", "hasMore": true }
```

The integrator pages by passing `?after=<nextCursor>` until `hasMore` is false.

### 3.6 Per-item shape (FR5.2, AC15) — consistent with the single route (FR6.9, AC15)

The Prisma `select` for both the list and the single route is unified. Add
`template: { select: { name: true, body: true } }` and the scalar columns:

```ts
select: {
  id: true, recipientPhone: true, templateId: true,
  status: true, metaMessageId: true, errorMessage: true,
  sentAt: true, deliveredAt: true, readAt: true, createdAt: true,
  direction: true, templateVariables: true,
  template: { select: { name: true, body: true } },
}
```

Mapped output item (shared shaping function, see 3.7):

```json
{
  "id": "msg_789",
  "recipientPhone": "15551234567",
  "templateId": "tpl_456",
  "templateName": "order_update",
  "status": "delivered",
  "metaMessageId": "wamid.XXXX",
  "errorMessage": null,
  "sentAt": "2026-10-13T12:00:00.000Z",
  "deliveredAt": "2026-10-13T12:00:03.000Z",
  "readAt": null,
  "createdAt": "2026-10-13T12:00:00.000Z",
  "direction": "outbound",
  "templateVariables": ["1234"],
  "bodyPreview": "Hi 1234, your order ... has shipped."
}
```

- `templateName` = `template?.name ?? null` (nullable; FR5.2).
- `templateVariables` is **parsed and normalized** from the stored JSON string into
  an **array or object** via `parseJsonColumn` + the §3.7 collapse rule — `null`
  when absent, malformed, or a non-container JSON scalar (so the returned field
  always honors its documented `string[] | Record<string,string> | null` type,
  never a raw number/string/boolean) — FR5.2.
- `bodyPreview` = `resolveBodyPreview(template?.body, templateVariables_parsed)`
  where `templateVariables_parsed` is the same normalized `vars`
  (A2/FR5.2). It is **included by default**: the `template` relation is already
  loaded in the same query (one join, no extra round-trip) and the helper is pure
  in-memory per returned row — bounded by `take <= 100` (NFR7). (NFR7's "existing
  indexes" wording is corrected in §3.4: `Message` has no index; the per-row
  `bodyPreview` cost is unaffected either way since it is in-memory over the <=100
  rows already fetched.) The `template.body` field is used only to compute
  `bodyPreview` and is **not** itself returned (keeps the payload to the documented
  field list).
- `template` relation object is **not** returned raw — only the derived
  `templateName` and `bodyPreview` are exposed.

### 3.7 Shared shaping helper for list/single consistency (FR5.1/FR5.2, AC15)

To guarantee the single-status route and the list use **identical field names and
identical parsing**, add a pure shaping function to **`src/lib/template-format.ts`**
(route modules may not export non-handler functions, and this module already exists
for exactly this purpose and already imports from `template-params`):

```ts
// src/lib/template-format.ts
import { resolveBodyPreview } from "@/lib/template-params";

export interface PublicMessageRow {
  id: string; recipientPhone: string; templateId: string | null;
  status: string; metaMessageId: string | null; errorMessage: string | null;
  sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null;
  createdAt: Date; direction: string; templateVariables: string | null;
  template: { name: string; body: string | null } | null;
}

export function shapePublicMessage(m: PublicMessageRow) {
  // parseJsonColumn is defined in THIS same module (template-format.ts) — no import needed.
  // parseJsonColumn returns `unknown` and never throws. A stored column could legally
  // be a JSON scalar (number/string/boolean) from a legacy/malformed write, so an
  // `as` cast is NOT safe — NORMALIZE to the documented array | record | null type
  // before BOTH returning it and feeding resolveBodyPreview (Finding 3 fix):
  const raw = parseJsonColumn(m.templateVariables);
  const vars: string[] | Record<string, string> | null =
    Array.isArray(raw)
      ? (raw as string[])
      : raw && typeof raw === "object"
        ? (raw as Record<string, string>)
        : null; // scalars / malformed / null all collapse to null
  return {
    id: m.id,
    recipientPhone: m.recipientPhone,
    templateId: m.templateId,
    templateName: m.template?.name ?? null,
    status: m.status,
    metaMessageId: m.metaMessageId,
    errorMessage: m.errorMessage,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    createdAt: m.createdAt,
    direction: m.direction,
    templateVariables: vars,
    bodyPreview: resolveBodyPreview(m.template?.body, vars),
  };
}
```

Both `src/app/api/v1/messages/route.ts` (list) and
`src/app/api/v1/messages/[id]/route.ts` (single) select the same columns and call
`shapePublicMessage`, so the shared keys and parsing are guaranteed identical
(FR6.9/AC15). This is a NON-circular import: `template-format.ts` already imports from
`template-params.ts`.

### 3.8 Single-status route update (FR5.3, AC16)

`src/app/api/v1/messages/[id]/route.ts` keeps its `authenticateApiKey` + scoped
`findFirst({ where: { id, userId, whatsappNumberId } })` + identical-404 (no
oracle) + "path id never logged" behavior **unchanged** (FR5.3/AC16). Only the
`select` is widened to the unified column set (adding `templateId`, `direction`,
`templateVariables`, `template.name`+`body`) and the response is wrapped in
`shapePublicMessage(message)` so a poller sees the same keys as a list item
(FR6.9/AC15). The returned shape thus **gains** `templateName`, `templateId`,
`direction`, parsed `templateVariables`, and `bodyPreview` on top of today's fields;
the pre-existing keys keep their names and semantics (back-compatible superset).

**Do NOT add a `try/catch` to the `[id]` route.** The live route has no error
wrapper today (an unhandled Prisma failure surfaces as the framework's 500), and
that control flow must be preserved. `shapePublicMessage`, `parseJsonColumn`, and
`resolveBodyPreview` are all non-throwing, so wrapping `message` in
`shapePublicMessage(message)` introduces no new throw path and needs no wrapper.
The ONLY changes to this route are (1) widening the `select` to the unified column
set and (2) replacing `return NextResponse.json(message)` with
`return NextResponse.json(shapePublicMessage(message))`. An implementer must not
add a `try/catch` to "match" the LIST route (§3.9) — doing so would change the
route's error surface and is out of scope.

### 3.9 Logging / secret safety (NFR2, FR6.4)

The GET handler logs **nothing** on the success path and does not echo the query
string or the key. A `try/catch` wraps the body with
`console.error("Error listing public messages:", error)` (no request object, no
key) — matching the POST handler's pattern. The `after` id is never logged. The API
key, hash, and decrypted secrets never appear in any branch (handled already by
`authenticateApiKey`, which also never logs them).

### 3.10 Error-handling table (GET /api/v1/messages)

| Condition | Recoverable? | Caller receives | Logged? |
|---|---|---|---|
| Missing/malformed/revoked/unknown key | caller fixes key | `401` via `unauthorized()` | no |
| `status` not in allow-list | caller fixes param | `400 {error}` | no |
| `since` fails `ISO_RE` shape / unparseable | caller fixes param | `400 {error}` | no |
| `limit` non-integer/non-positive/NaN | auto-handled | `200`, falls back to 50 | no |
| `after` unknown/deleted/cross-tenant | auto-handled | `200` empty page, no oracle | no |
| Prisma/DB throw | fatal for request | `500 {error:"Internal server error"}` | yes (error only, no key) |

### 3.11 Testability

The route is integration-tested with `curl` (manual): valid key returns owner+number
scoped rows; `?limit=200` returns ≤100; `?status=delivered` filters; a strict-ISO
`?since` filters, a non-ISO `?since` returns 400; `?after` pages correctly; an
unknown `after` returns empty; a bad key returns 401. The pure `resolveBodyPreview`
and `shapePublicMessage` are unit-testable without DB.

**NFR7 note (corrected).** The LIST query is bounded by `take <= 100` and keeps
`bodyPreview` resolution in-memory per returned row, but — contrary to the earlier
draft — it does **not** rely on any `Message` index because none exists (§3.4). The
scan is accepted at current volume; an index is a deferred, idempotent follow-up,
not part of this change.

---

## 4. Docs page + scratchpad

### 4.1 `src/app/docs/page.tsx` additions (FR7, AC17)

In section 6 ("Connect a third-party application"), **after** the existing
`GET /api/v1/messages/[id]` block, add a new `GET /api/v1/messages` (LIST) block
using the existing `Method`/`CodeBlock` presentational helpers. It documents:

- **Auth & scope:** API key (Bearer); returns only messages sent through the key's
  bound number (owner + number scoped).
- **Query params:** `limit` (default 50, max 100, clamped; non-integer/non-positive
  → 50), `status` (**filter** accepts only `sent|delivered|read|failed|queued`, 400
  on unknown), `since` (**ISO 8601 instant** with `Z` or a `±HH:mm` offset,
  fractional seconds optional, e.g. `2026-10-13T12:00:00.000Z` or
  `2026-10-13T12:00:00+05:30`; returns rows with `createdAt` strictly after; 400 on
  a value that is not a valid ISO 8601 instant), `after` (keyset cursor; unknown or
  deleted id → empty page). Ordering `createdAt desc`.
- **Item schema:** the full field list from §3.6 including parsed `templateVariables`
  (always an array/object or `null`) and `bodyPreview`. **Note on `status`
  (Finding 5):** the returned `status` may be any of
  `queued|sent|delivered|read|failed|received` — `received` appears only on
  **inbound** rows (`direction: "inbound"`) that fall within the key's owner+number
  scope. The `?status=` **filter** accepts only the five send-lifecycle values, so a
  consumer cannot filter *for* `received` but may still *observe* it in an
  unfiltered page; it is not an error and should be handled as a valid inbound
  state.
- **Envelope:** `{ data, nextCursor, hasMore }` and how to page with
  `?after=<nextCursor>`.
- **Example `curl` + example 200 response** (list envelope with one item).

Update the existing **`GET /api/v1/messages/[id]`** 200 example (FR7.3/AC17) to the
new superset shape (adds `templateId`, `templateName`, `direction`,
`templateVariables`, `bodyPreview`) so docs match the LIST shape (FR6.9).

Add a short **"Live-status sync pattern"** subsection (FR7.2/AC17): (1) on
`POST /api/v1/messages`, store the returned `id` (and optionally `metaMessageId`)
against your own record; (2) poll `GET /api/v1/messages/{id}` for a single record,
**or** `GET /api/v1/messages?since=<lastSyncISO>` (then page with `after`) to pull
all status changes in bulk; (3) reconcile `delivered`/`read`/`failed` +
timestamps/`errorMessage` into your own data. Note the delivery-status caveat
already documented (webhook signing secret / `messages` subscription) still applies.

Update the page's `lastUpdated` string literal to the change date, **keeping the
existing `"Month D, YYYY"` human format** (it is a string like `"March 22, 2026"`,
not a numeric/date constant — Finding 8), e.g. `const lastUpdated = "October 14, 2026"`.

### 4.2 `scratchpad.md` obligation (global scratchpad steering rule)

In the **same change**, update the root `scratchpad.md`:

- **Backend/API section:** add `GET /api/v1/messages` (API-key auth, owner+number
  scoped, `limit`/`status`/`since`/`after`, `{data,nextCursor,hasMore}` envelope);
  note the single-status route's widened consistent shape.
- Note the new **`resolveBodyPreview`** pure helper in `src/lib/template-params.ts`
  and the **`shapePublicMessage`** shaper in `src/lib/template-format.ts`.
- Note the enhanced session `GET /api/messages` fields (`template.body` added) and
  the dashboard **expandable detail view + live-status chips**.
- Refresh `Last updated: YYYY-MM-DD` and prepend a dated **Change log** entry
  (newest first). No secrets are added.

---

## 5. Explicit non-regression list (NFR4, NFR7, AC18)

The following are **read-only** in this change and must behave identically after it:

- **Public send `POST /api/v1/messages`** — untouched handler; the new `GET` is
  added to the same file without altering the `POST`, its Zod `Body`, template
  resolution, superadmin computation, or the `sendTemplateMessage` call.
- **Single-status `GET /api/v1/messages/{id}`** — isolation, identical-404 /
  no-existence-oracle, and "path id never logged" preserved; only the `select` is
  widened and the response passed through `shapePublicMessage` (back-compatible
  superset of fields).
- **Template routes** (`GET /api/v1/templates`, `/templates/[id]`) — not modified;
  `template-format.ts` only **gains** `shapePublicMessage` (and keeps
  `countVariables`/`namedParams`/`parseJsonColumn`), so existing imports are intact.
- **`#131008` handling / authentication-template OTP** — lives entirely in
  `send-template.ts`, which is not modified (NFR5).
- **Credits** — credit check/deduct/refund logic in `send-template.ts` is untouched;
  the new read-only GET never writes credits.
- **Isolation** — session route stays `session.user.id`-scoped; public routes stay
  `ctx.userId` + `ctx.number.id`-scoped on every query, including the `after`
  anchor lookup.
- **Webhook `api/webhooks/whatsapp/route.ts`** — read only; status/timestamp writes
  by `metaMessageId` are unchanged.
- **Schema** — no migration; all Message fields already exist. If a change were ever
  needed it would be an idempotent `@libsql/client` script, never `db:push` (NFR3) —
  not required here.
- **Dependencies** — none added (NFR3).

### Verification gate

`next build` / type-check must pass with no type errors; manual request checks for
the public GET (scope, limit clamp, status/since 400s, after paging, 401) and a
dashboard spot check (expand a row, confirm resolved preview + distinct chips, a
malformed-variables row does not throw). Clean up any scratch files.

---

## 6. Responses to design review

### 6c. Latest review (CHANGES_REQUESTED — 0 HIGH, 1 MEDIUM, 1 NIT)

This is the response to the most recent `design-review.json` / `design-review.md`
(verdict CHANGES_REQUESTED; 0 HIGH, 1 MEDIUM, 1 NIT). Both findings are
documentation/grounding corrections, not logic changes — the reviewer explicitly
confirmed the algorithms, isolation, pagination, validators, and shaping are all
correctly grounded and sound. **Both findings are ADDRESSED** below; neither is
backlogged or ignored, and the fixes stay within the original requirements. The
verified send behavior was re-confirmed against `src/lib/send-template.ts` before
editing.

**Finding 1 — MEDIUM — "Critical grounding fact" contradicted the actual send code
and the requirements → ADDRESSED.** The Overview's "Critical grounding fact" section
previously claimed `sendTemplateMessage` persists `templateVariables` only for the
positional form (storing `null` for the named-map form) and labeled "named + null"
as "today's dominant case". That was the pre-fix state and is false against the
current source. The section is **rewritten** to the verified behavior, quoting the
actual code: a named-map send (`templateParams`/`namedParams`) stores a JSON
**object**, a positional send stores a JSON **array**, else `null` — and **all three
shapes occur in stored rows today**, none being a rare forward-compat path.
Correspondingly, §1 step 4's named branch now leads with the **record** sub-case (the
common stored shape for a named send) followed by the `null` sub-case (legacy /
no-values rows), and the edge-case table row that read "named body + `values` is
`null` (today's dominant case)" is re-labeled "named body + `values` is `null`
(legacy / no-values row)" with a separate record row marked "common named-send
shape". The branch **logic was already correct** for all three shapes; only the
stated premise and framing changed, per the reviewer's instruction not to alter the
algorithm.

**Finding 2 — NIT — references to requirement IDs that do not exist → ADDRESSED.**
The requirements define only FR1–FR7, NFR1–NFR7, and AC1–AC18. The design previously
cited phantom IDs (`FR8`, `AC19`–`AC25`) and several mis-numbered IDs that pointed at
the wrong requirement (e.g. the public LIST route tagged with `FR5.*` ids and the
dashboard tagged with LIST ACs). Every FR/AC tag across §1–§5 was **re-labeled to the
correct real ID**:
- §2.1 session route → FR2.1/FR2.2/FR2.3, AC5 (was AC6, which is the status-chips AC).
- §2.2 expandable row → FR1.1/FR1.2/FR1.3, A3 (dropped non-existent FR3.4).
- §2.3 status chips → FR3.1, AC6; §2.4 Refresh → FR3.3 (was FR4.3).
- §3.1 auth → FR6.2/AC10; §3.2 isolation → FR6.3/AC9; §3.3 params → FR6.5 with
  limit=AC11, status=AC12, since=AC13; after → FR6.7/AC14.
- §3.5 envelope → FR6.8/AC9; §3.6/§3.7 shaper → FR5.1/FR5.2 and FR6.9, AC15.
- §3.8 single route → FR5.3/AC16; §3.9 logging → NFR2/FR6.4.
- §4.1 docs → FR7/FR7.2/FR7.3, AC17; §4.2 scratchpad → cited against the **global
  scratchpad steering rule** (not a phantom FR), as the reviewer directed.
- §5 non-regression → NFR4/NFR7, AC18.
The underlying obligations (docs, scratchpad, non-regression) were always real; only
the traceability tags were corrected.

### 6b. Prior review (earlier iteration — CHANGES_REQUESTED — 0 HIGH, 3 MEDIUM, 2 NIT)

This responded to an **earlier** review iteration (0 HIGH, 3 MEDIUM, 2 NIT) and is
retained for history; its findings are superseded by §6c above where they overlap.
**All five findings were addressed** below; none backlogged or ignored, and every
change stays within the original requirements (NFR1 isolation, NFR3 no schema
migration/`db:push`, NFR4 no regressions, NFR5 reuse-don't-fork). Each was verified
against source before editing (dashboard page, `template-params.ts`, `badge.tsx`).

**Finding 1 — MEDIUM — numbered branch referred to pre-normalization `parsed`/`arr`;
normalized value never named consistently → ADDRESSED.** §1 step 2 now **binds the
normalized value once to `values` (`string[] | Record | null`)** and the algorithm
references only `values` thereafter — `parsed`/`arr` are retired. Step 4's numbered
branch is stated exhaustively: `values` is an array and `(k-1)` in range →
`String(values[k-1])`; **otherwise** (`values` is `null`, a record, or index out of
range) → undefined → leave `{{k}}` intact. The edge-case table rows were updated to
match (including the explicit "numbered body + record → nothing resolves" row).

**Finding 2 — MEDIUM — named-body + `null` (the dominant real case) specified only
implicitly → ADDRESSED.** §1 step 4's named branch now opens with an explicit first
bullet: **if `values` is `null` there is no lookup and every `{{name}}` is left
intact — today's dominant case for named templates per the grounding fact.** The
record and positional-array sub-cases follow it. The edge-case table adds a dedicated
"named body + `values` is `null`" row.

**Finding 3 — MEDIUM — design misstated current "Sent" column precedence as
`read>delivered>sent`; live code is `delivered>read>sent`, conflicting with §2.4's
"unchanged" → ADDRESSED.** §2.3 now states the **actual** precedence verified in
`src/app/dashboard/messages/page.tsx`: **`deliveredAt` > `readAt` > `sentAt`** (it
checks `deliveredAt` first). The design keeps this column **exactly as-is** (the
lowest-risk choice the review recommended, and the precedence the task/FR3.2 pin),
and the read-vs-delivered visual distinction is delivered via the status **chip**
(`read` → `default`, `delivered` → `success`), not the timestamp column. §2.3 and
§2.4 now explicitly agree: the chip map changes; the "Sent" timestamp column is
untouched.

**Finding 4 — NIT — `queued` and `received` both mapped to `outline` (identical
render) → ADDRESSED.** The §2.3 chip table now maps `received` → **`warning`** (a
distinct existing variant), so no two live states collide. The choice is stated with
reasoning (`received` is inbound-only, so a distinct chip reads as "inbound").

**Finding 5 — NIT — design floated adding a blue Badge variant for `read`, but the
repo Badge has no blue/`info` variant and editing it widens blast radius →
ADDRESSED.** The "add a distinct blue variant" option is **removed** and marked
explicitly **out of scope** in §2.3. `read` keeps the existing `default` variant, so
the shared `src/components/ui/badge.tsx` is not modified (NFR4). The verified variant
set (`default | secondary | destructive | outline | success | warning`) is cited.

### 6a. Prior review (earlier iteration — retained for history)

The verdict below refers to an **earlier** review iteration; its numbering is
distinct from §6b above. It is retained so the resolution history is traceable.

Review verdict: **CHANGES_REQUESTED** — 1 HIGH, 3 MEDIUM, 4 NITs. **All eight
findings are addressed** below. None is backlogged or ignored, and every change
stays within the original requirements (NFR1 isolation, NFR3 no schema
migration/`db:push`, NFR4 no regressions, NFR5 reuse-don't-fork).

### Finding 1 — MEDIUM — keyset omits secondary `orderBy id desc`; `nextCursor` id-only; deleted-cursor undefined → ADDRESSED
§3.4 now pins the LIST query's ordering as the **compound**
`orderBy: [{ createdAt: "desc" }, { id: "desc" }]`, shown explicitly in a query
sketch, so the sort keys/directions exactly match the keyset `OR` predicate and no
rows are skipped or duplicated at millisecond boundaries. The design also states
that `rows[limit-1]` is unambiguously the page's last row under that total order
(so the id-only `nextCursor` anchors the next page correctly), and that an `after`
anchor lookup that finds the cursor row **deleted / out of scope** returns the same
no-oracle **empty page** as an unknown id (AC17). The implementer is explicitly told
not to write `orderBy: { createdAt: "desc" }` alone.

### Finding 2 — MEDIUM — strict round-trip ISO check wrongly rejects valid ISO 8601 (offsets, no-ms) → ADDRESSED
§3.3 replaces the `new Date(s).toISOString() === s` round-trip with an **ISO 8601
shape regex** (`ISO_RE`) that accepts `Z` or a `±HH:mm` offset and optional
fractional seconds, parsed via `parseSince`. Junk (bare year, locale string, missing
zone) still 400s per AC16, but legitimate forms like `2026-10-13T12:00:00Z` and
`2026-10-13T12:00:00+05:30` now pass. §3.10 (error table) and §4.1 (docs) were
updated to describe "an ISO 8601 instant with `Z` or an offset; fractional seconds
optional", so the contract and the check agree.

### Finding 3 — MEDIUM — `shapePublicMessage` casts `unknown` without normalizing; scalar/legacy JSON leaks under a parsed-array/object field → ADDRESSED
§3.7 replaces the `as string[] | Record<string,string> | null` cast with an explicit
**normalization**: `Array.isArray(raw)` → array; non-null `object` → record;
everything else (scalar/malformed/null) → `null`. The normalized `vars` is used
**both** for the returned `templateVariables` field (so it always honors its
documented `array | object | null` type) **and** as the input to
`resolveBodyPreview`. §1 step 2 and §3.6 now carry the same "collapse non-container
to null" rule so the helper and the shaper never disagree.

### Finding 4 — HIGH — session route `include` vs `select` inconsistency; internal FKs/`userId` leak to the browser → ADDRESSED
§2.1 now **switches the session route from `include` to an explicit `select`** of
exactly the FR2.1 (pre-existing) + FR2.2 (additive) fields plus
`template{name,body}` and `whatsappNumber{phoneNumber}`, pinning the returned shape.
`userId`, `whatsappNumberId`, `conversationId`, and `metaMessageId` are **no longer
shipped** to the browser. §2.2's client `Message` interface is rewritten to match
that `select` field-for-field, so the client/server shape is unambiguous on both
ends. The route stays `userId`-scoped, `createdAt desc`, `take 100`, 401 unchanged,
and keeps every field the current table consumes (no regression, FR2.1/AC5/AC7).

### Finding 5 — NIT — returned `status` can be `received` on inbound rows but is undocumented → ADDRESSED
§4.1 now documents that returned `status` may be any of
`queued|sent|delivered|read|failed|received` (`received` only on inbound rows within
scope), while the `?status=` filter accepts only the five send-lifecycle values —
so an integrator does not treat an observed `received` as an error. §3.3 cross-notes
the same.

### Finding 6 — NIT — `limit` parsing underspecified for non-integers / 0 → ADDRESSED
§3.3 pins the exact parse: `const n = Number(raw); const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 50;`, with a worked table
(`200→100`, `25.7→50`, `abc→50`, `0→50`, `-5→50`, absent→50), satisfying AC14.

### Finding 7 — NIT — unclear where local validators live after the "handlers-only export" note → ADDRESSED
§3.3 adds a "Where the local validators live" note: `parseSince`, `ISO_RE`,
`KNOWN_STATUS`, and the `limit` parse are **local, non-exported** declarations in the
route file; the Next.js restriction cited in §3.7 applies to *exports* only, so only
the cross-route-shared `shapePublicMessage` moves to `template-format.ts`.

### Finding 8 — NIT — docs `lastUpdated` is a human string literal, not a date constant → ADDRESSED
§4.1 now says to update the `lastUpdated` **string literal keeping the
`"Month D, YYYY"` format** (e.g. `"October 14, 2026"`), not treat it as a numeric
constant.
