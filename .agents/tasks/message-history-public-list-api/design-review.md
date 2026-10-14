# Design Review — Message history/detail visibility + third-party message-list API

Reviewed: `/.agents/tasks/message-history-public-list-api/design.md`
Against: `/.agents/tasks/message-history-public-list-api/requirements.md` and the actual source tree.
Method: every grounding claim in the design was checked against the real files listed under "Verified Assumptions". Builds/tests were not re-run per instructions.

**Verdict: APPROVED** — 0 HIGH, 0 MEDIUM, 2 NIT.

---

## Findings

1. **NIT — §2.1 session route `select` adds `content` which FR2.3 does not enumerate.**
   FR2.3 lists the additive fields as `template.body`, `templateVariables`, and
   `direction`. The design's `select` also adds `content: true` (for the
   no-template/inbound fallback the detail panel shows per FR1.2/FR3.2). This is a
   defensible, in-scope addition (the user's own message text, not an FK or `userId`),
   and it is reflected in the client `Message` interface, so there is no server/client
   drift and no leak. It is called out only because the field is not in the FR2.3
   enumeration verbatim.
   CONCRETE FIX (optional): add one line to §2.1 noting "`content` is additionally
   selected to back the FR1.2/FR3.2 no-template fallback" so the enumeration delta is
   explicit. No logic change.

2. **NIT — §3.3 `ISO_RE` makes the zone designator mandatory; FR6.5 only requires that an
   offset be ACCEPTED, not that a bare-local value be rejected.**
   The regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$`
   requires `Z` or `±HH:mm`. This satisfies the requirement (it ACCEPTS offsets and
   seconds precision, and is NOT a round-trip check), and rejecting a zone-less value is
   a reasonable, well-documented choice (§4.1 states "with `Z` or a `±HH:mm` offset"). It
   is flagged only as a design decision worth keeping visible: an integrator sending a
   zone-less `2026-10-13T12:00:00` will get a 400. The AC13 example
   (`2026-01-02T03:04:05+05:30`) passes, so this does not violate any AC.
   CONCRETE FIX (optional): keep as-is (recommended — avoids ambiguous local-time
   interpretation), or, if zone-less input must be tolerated, change the trailing group
   to `(Z|[+-]\d{2}:\d{2})?` and default a missing zone to UTC. The current choice is
   acceptable and no change is required.

No HIGH or MEDIUM findings. The algorithm specifications (helper normalization, keyset
predicate, shaper normalization, validators), the isolation model, the no-oracle 404 /
empty-page behavior, the explicit `select`, the compound `orderBy`, and the
non-regression surface are all correctly grounded in the current source.

---

## Verified Assumptions (checked against source)

- **Send persistence shape (Overview "Critical grounding fact").** `src/lib/send-template.ts`
  stores `templateVariables` as `JSON.stringify(namedParams)` (OBJECT) when a non-empty
  named map is present, else `JSON.stringify(variables)` (ARRAY) when positional values
  exist, else `null`. The design quotes this verbatim and correctly treats all three
  shapes as live. VERIFIED.
- **`Message` schema fields and NO index.** `prisma/schema.prisma` `model Message` has
  `id, userId, whatsappNumberId, templateId, template(relation), metaMessageId,
  recipientPhone, templateVariables (String?), status, errorMessage, direction
  (default "outbound"), content, conversationId, sentAt, deliveredAt, readAt, createdAt`
  and **no `@@index`**. The status comment includes `received`. Matches §3.4's "no index,
  accept scan" claim. VERIFIED.
- **Session route uses `include`, returns raw rows, `userId`-scoped, `createdAt desc`,
  `take 100`, try/catch→500.** `src/app/api/messages/route.ts` matches exactly — the
  current `include` ships all Message scalars (incl. `userId`, FKs) to the browser.
  §2.1's "switch to explicit `select`" premise is correct. VERIFIED.
- **`[id]` route: `authenticateApiKey`, `findFirst` scoped to `{ id, userId,
  whatsappNumberId }`, identical `404 {error:"Not found"}`, no id logging, NO try/catch,
  does not return `templateName`/`direction`.** `src/app/api/v1/messages/[id]/route.ts`
  matches exactly. §3.8's "widen select + wrap in shapePublicMessage, add no try/catch"
  is feasible and preserves structure. VERIFIED.
- **`api-auth.ts` exposes `authenticateApiKey` → `{ userId, apiKey, number }` | null and
  `unauthorized()` (401), never logs the key.** VERIFIED.
- **`template-format.ts` exposes `parseJsonColumn(value: string|null): unknown` (never
  throws) and re-exports `namedParams`; it imports FROM `template-params.ts`.** This is
  the circular-import root the design guards against — §1 correctly inlines the two-line
  parse in `template-params.ts` instead of importing `parseJsonColumn`, and §3.7 places
  `shapePublicMessage` in `template-format.ts` (which already imports from
  `template-params`, so `import { resolveBodyPreview }` there is NON-circular). VERIFIED.
- **`template-params.ts` exposes `parseTemplateBody` → `{kind:"named"|"numbered"|"none", ...}`
  with named `names: string[]`, numbered `count`, and the whitespace-tolerant
  `PLACEHOLDER_RE` (module-level `/g`).** §1's reliance on `parseTemplateBody` and its
  warning not to reuse the stateful global regex instance (use a fresh literal) is
  correct and grounded. No `resolveBodyPreview` exists yet. VERIFIED.
- **Dashboard `getStatusBadge`: `read` maps to `success` (same as `delivered`) and there
  is NO `received` case (falls to default `outline` "Queued").** §2.3's premise is
  correct. VERIFIED.
- **Dashboard "Sent" column precedence is `deliveredAt` > `readAt` > `sentAt`.** Source
  renders `deliveredAt ? "Delivered…" : readAt ? "Read…" : sentAt ? … : "-"`. §2.3/§2.4
  state this exactly and leave the column unchanged; the design does NOT claim
  `read>delivered>sent`. VERIFIED (matches FR3.2 and the task directive).
- **Badge variants = `default | secondary | destructive | outline | success | warning`;
  no blue/`info` variant.** `src/components/ui/badge.tsx` CVA config matches. §2.3's chip
  map (`queued→outline, sent→secondary, delivered→success, read→default, failed→destructive,
  received→warning`) uses only existing variants, renders all six distinctly, and does NOT
  edit `badge.tsx`. VERIFIED.
- **POST `/api/v1/messages` wraps its body in `try/catch` with
  `console.error("Error sending public message:", error)` and lives in
  `src/app/api/v1/messages/route.ts`.** §3.1 (add GET alongside POST) and §3.9 (GET's
  try/catch mirrors POST, logs error only, never the key/id) are grounded. VERIFIED.
- **Docs page (`src/app/docs/page.tsx`): documents `GET /api/v1/messages/[id]` with the
  OLD shape (`id,status,recipientPhone,metaMessageId,errorMessage,sentAt,deliveredAt,
  readAt,createdAt` — no `templateName`/`direction`/`templateVariables`/`bodyPreview`),
  has NO LIST section, has section 6 "Connect a third-party application", and
  `const lastUpdated = "March 22, 2026"` (human string).** §4.1's additions and the
  Finding-8 note (keep the `"Month D, YYYY"` string format) are grounded. VERIFIED.
- **Checklist items confirmed:** helper purity/no-throw + circular-import avoidance (§1);
  single `values` name in numbered + explicit named/null cases (§1 step 2/4); userId+
  number isolation + identical-404 + no-logging on LIST and [id] (§3.2/§3.8); session
  explicit `select` no FK/userId leak (§2.1); compound `orderBy [createdAt desc, id desc]`
  + id tiebreak + deleted-cursor empty page (§3.4); `?since` ISO shape regex accepting
  offset/seconds, not round-trip (§3.3); `shapePublicMessage` normalizes to array|record|
  null and is shared by both routes (§3.7); `[id]` gains no try/catch (§3.8); 'Sent'
  precedence delivered>read>sent matches code (§2.3); non-regression surface confined
  (§5); no schema change, zero new deps (§3.4/§5). ALL VERIFIED.

## Unverified / Wrong Assumptions

None. Every claim in the design that could be checked against the source was found
accurate. No claim was taken on the design's word without reading the referenced file.
