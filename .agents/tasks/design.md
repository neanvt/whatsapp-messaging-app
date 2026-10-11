# Technical Design — Per-Tenant Credentials for Template-Management Routes

Last updated: 2025-02-14
Status: Design (revision 2 — addresses design-review findings 1–6)
Requirements: `.agents/tasks/requirements.md`
Review addressed: `.agents/tasks/design-review.md` / `design-review.json` (verdict CHANGES_REQUESTED)

> Revision note: this is a revision pass. The design review
> (`.agents/tasks/design-review.md`) raised 1 HIGH, 2 MEDIUM, and 3 NIT findings
> against the template-route design. All HIGH/MEDIUM findings are resolved in the
> body below and the NITs are addressed; see the "Review responses" section at the
> end for a per-finding disposition.

## 1. Overview

Three template-management API routes still read a single hardcoded env pair
(`META_WABA_ID` + `META_ACCESS_TOKEN`) when calling the Meta Graph API:

- `POST   /api/templates/[id]/submit` — creates a template on Meta
- `POST   /api/templates/sync`        — pulls templates from Meta
- `DELETE /api/templates/[id]`        — best-effort delete on Meta

In a multi-tenant SaaS this is wrong: every tenant's submit/sync/delete hits the
same shared WABA. The send paths were already migrated to per-tenant credentials
via `resolveSendCredentials(number)` in `src/lib/whatsapp.ts`, which decrypts each
`WhatsAppNumber`'s own stored `accessToken` and uses its own `phoneNumberId`, with
**no env fallback**. This design does the equivalent for the template routes at the
**WABA** level: it adds a sibling resolver `resolveWabaCredentials` to
`src/lib/whatsapp.ts`, rewires all three routes to resolve `{ wabaId, accessToken }`
from a verified `WhatsAppNumber` owned by `session.user.id`, and removes the env
reads from these three files.

The only thing that changes is the **source** of `wabaId` + `accessToken`. Every
piece of preserved business logic — `buildComponents`, Meta name sanitization, the
1024-char body guard, the `status:'submitted'` / `metaTemplateId` / `submittedAt`
write-back, `mapMetaStatus`, dedup-by-name, Meta-only import, the best-effort
non-fatal delete, and the `META_TOKEN_EXPIRED` (code 190) branch — stays byte-for-byte
intact.

## 2. Technology stack (locked)

- **Language / framework:** TypeScript, Next.js 14 App Router route handlers
  returning `NextResponse`.
- **Auth:** `getServerSession(authOptions)` from `next-auth` (unchanged).
- **DB:** Prisma client (default export from `@/lib/db`) against Turso/libSQL
  (`sqlite` provider, `env("TURSO_DATABASE_URL")`).
- **Crypto:** existing `encrypt` / `decrypt` from `@/lib/crypto` (AES-256-GCM,
  `ENCRYPTION_KEY`). No new crypto.
- **Meta Graph API:** `https://graph.facebook.com/v19.0/...` (unchanged version).
- **New dependencies:** none. This is a pure rewire plus one new exported helper.

## 3. The shared resolver — `resolveWabaCredentials`

### 3.1 Why a WABA-level sibling to `resolveSendCredentials`

The send path needs `{ phoneNumberId, accessToken }` because it calls
`POST /{phoneNumberId}/messages`. The template routes call
`POST|GET|DELETE /{wabaId}/message_templates`, so they need `{ wabaId, accessToken }`.
Rather than overload `resolveSendCredentials` or duplicate the `decrypt` call in
each route (which requirement FR-1 / AC-1 forbid), we add a focused sibling that
mirrors the existing one's shape and semantics exactly.

### 3.2 Signature and return shape

```ts
// src/lib/whatsapp.ts
// Resolve the per-tenant WABA credentials used to call Meta's
// /{wabaId}/message_templates endpoints. Mirrors resolveSendCredentials: no env
// fallback — a row without a stored wabaId + encrypted accessToken resolves to
// nulls so callers raise a clear "number not connected" error. decrypt() may
// throw on a bad key / tampered ciphertext; callers wrap this call and treat a
// throw as a credential error (never log the token or ciphertext).
export function resolveWabaCredentials(number: {
  wabaId: string | null;
  accessToken: string | null;
}): { wabaId: string | null; accessToken: string | null } {
  if (number.wabaId !== null && number.accessToken !== null) {
    return {
      wabaId: number.wabaId,
      accessToken: decrypt(number.accessToken),
    };
  }
  return { wabaId: null, accessToken: null };
}
```

Decisions and justification:

- **Accepts a row-shaped object, not a `numberId`.** It mirrors
  `resolveSendCredentials` (which takes the row) and keeps the resolver pure and
  synchronous — the DB lookup / ownership filter stays in the route where the
  session is available, so the resolver never needs `prisma` or `session`. This is
  the established pattern; deviating would be gratuitous.
- **Returns nulls, does not throw, for "no stored creds."** Again mirrors
  `resolveSendCredentials`. The only throw path is `decrypt()` on bad/tampered
  ciphertext, which the caller catches (see §7). This cleanly separates
  "not connected" (nulls → 4xx) from "credential error" (throw → 500).
- **No logging.** The function performs no `console.*`. `decrypt` itself never
  logs its inputs (verified in `src/lib/crypto.ts`).

This resolver is the single owner of template-route decrypt logic; no route file
will contain its own `decrypt` call (satisfies AC-1).

## 4. Template → WABA mapping decision (submit & delete)

This is the central decision. A `WhatsAppNumber` is "connected/usable" when it has
`verificationStatus === "verified"` **and** non-null stored `wabaId` **and**
non-null stored `accessToken` — identical to the send route's definition.

### 4.1 Resolution order for submit & delete

For a given template owned by `session.user.id`, pick the number as follows:

1. **Template's own `whatsappNumberId`, if set.** `Template.whatsappNumberId`
   already exists in the schema and establishes an explicit template→number
   binding. If set, load that `WhatsAppNumber` **scoped to the same userId** and
   require it to be usable. This is the most precise mapping and avoids ambiguity
   entirely when present.
2. **Else, the user's connected verified numbers.** Query
   `WhatsAppNumber` where `userId = session.user.id`,
   `verificationStatus = "verified"`, `wabaId != null`, `accessToken != null`.
   - **Exactly 0** usable numbers → clear 4xx (see §4.2). Never 500, never env.
   - **Exactly 1** → use it. This is the common SaaS case (one number per tenant).
     Auto-resolving the sole number is a deliberate ergonomic for the template
     routes: it keeps the current zero-`numberId` frontend submit contract working
     for the typical one-number tenant without any UI change. (Note: this does
     *not* mirror the send route — `src/app/api/messages/send/route.ts` requires an
     explicit `numberId` and never auto-picks. The template routes intentionally
     diverge because their current frontend sends no `numberId`.)
   - **>1 and none specified / none bound on the template** → clear 4xx asking the
     caller to specify which number (see §4.3). We do **not** silently pick one.

Justification for choosing "explicit binding → single → disambiguate" over a
documented default (e.g. "newest number"): a silent default on a multi-WABA tenant
would submit a template to, or delete it from, the wrong business account — a
cross-WABA correctness bug that is invisible until a template lands in the wrong
place. An explicit 4xx forces the caller to be unambiguous, which is the safe
default for a security/correctness-sensitive multi-tenant operation. When the
template already carries a `whatsappNumberId`, there is no ambiguity, so the common
flows stay single-call.

### 4.2 Zero connected numbers (submit & delete)

- **Submit:** return **409 Conflict** (state precondition unmet) with
  `{ error: "Connect a WhatsApp number before managing templates" }`. Meta is never
  called. (Requirement AC-6 accepts 400 or 409; 409 is chosen because the request
  is well-formed but the account state blocks it. Either is compliant.)
- **Delete:** delete is **best-effort** on Meta — zero usable creds is not an error.
  The Meta `DELETE` is simply skipped (same effect as today's
  `if (metaTemplateId && env creds)` guard that now becomes
  `if (metaTemplateId && resolved creds)`), a line is logged
  (`"[Template delete] no connected number — skipping Meta delete"`, no token), and
  the local `prisma.template.delete` still runs. The DELETE response is unchanged
  (`200 { message: "Template deleted successfully" }`).

### 4.3 Multiple numbers, none specified (submit)

Return **400 Bad Request** with
`{ error: "Multiple WhatsApp numbers connected — specify which number to submit this template from", code: "AMBIGUOUS_NUMBER" }`.
To let the caller resolve this, **submit accepts an optional `numberId` in the
request body** (see §5). Resolution precedence for submit becomes:

1. `numberId` from the request body (validated: must be a usable number owned by
   the user) — if provided. If the explicitly chosen number is not usable, that is
   a **400 `NUMBER_NOT_CONNECTED`** (the caller named a specific number; there is no
   ambiguity, the chosen one simply is not connected). This code is distinct from
   `AMBIGUOUS_NUMBER` so a frontend can branch correctly.
2. else `template.whatsappNumberId` (if set and usable).
3. else the user's single usable number.
4. else (0 usable) → 409 (§4.2); (>1 usable, none chosen) → 400 `AMBIGUOUS_NUMBER`.

For **delete**, which is non-fatal and takes no body today, we keep it simple: use
`template.whatsappNumberId` if set+usable, else the single usable number; if 0 or
ambiguous, **skip the Meta delete** (best-effort) and still delete locally. We do
not add a body param to delete — forcing the caller to disambiguate a best-effort
cleanup would be worse UX than a skipped remote delete, and the local row is the
source of truth.

### 4.4 Capturing `whatsappNumberId` on submit

When submit resolves a number (via explicit `numberId` or the single-number case),
it **sets `whatsappNumberId` on the template** as part of the existing success
write-back, if the template does not already have one. This:

- records which WABA the template was submitted to, so a later sync/delete can reuse
  the exact binding (eliminating future ambiguity for that template), and
- is a no-op when the template was already bound.

This is an **additive write to an existing nullable column** — no schema change
(see §8). The write-back `data` for the success case becomes:

```ts
data: {
  status: "submitted",
  metaTemplateId: metaData.id ?? null,
  submittedAt: new Date(),
  // bind the template to the number it was submitted from, if not already bound
  ...(template.whatsappNumberId ? {} : { whatsappNumberId: resolvedNumberId }),
}
```

### 4.5 Frontend impact (submit)

Today the frontend submit calls (`src/app/dashboard/templates/new/page.tsx` and
`src/app/dashboard/templates/[id]/page.tsx`) POST `{ sampleValues }` with no
`numberId`. For a **single-number tenant** (the overwhelmingly common case and the
app's current reality) the backend resolves the one usable number automatically, so
**no frontend change is required for existing single-number users** — the new 400
`AMBIGUOUS_NUMBER` only triggers for a tenant with 2+ connected numbers.

The additive, optional frontend change (so multi-number tenants aren't blocked): the
submit UI MAY pass a selected `numberId` in the POST body. This is **optional and
additive** — specified here so the implementer knows the contract, but it is only
required to *unblock* multi-number tenants, not to keep current behavior working.
The template editor already loads the user's numbers elsewhere; wiring a selector is
a small additive change the implementer can include. Recommended: include it, since
leaving multi-number tenants with only a 400 is a dead-end UX. Mark the selector
optional in the UI and default to the sole number when only one exists.

## 5. Submit route — detailed design

File: `src/app/api/templates/[id]/submit/route.ts`

Imports add: `import { resolveWabaCredentials } from "@/lib/whatsapp";`
Imports remove: nothing (keeps prisma, auth).

Flow (unchanged steps marked *same*):

1. *same* — auth guard (401 if no session).
2. *same* — load template with `findFirst({ where: { id: params.id, userId: session.user.id } })`; 404 if missing. (Ownership scoping, AC-5/AC-11.)
3. *same* — status gate (`draft`/`rejected` only, else 400).
4. **changed** — parse request body **once**. `request.json()` drains the body
   stream and can be called only once; the existing code already does a single
   `const reqBody = await request.json()` inside a try/catch to read `sampleValues`.
   Read `numberId` from that **same `reqBody` object** — do **not** add a second
   `await request.json()` (a second read throws "body already read", which the
   existing catch would swallow, silently dropping both `sampleValues` and
   `numberId`). Inside the existing try block:

   ```ts
   let sampleValues: string[] = [];
   let numberId: string | undefined;
   try {
     const reqBody = await request.json(); // single read
     if (Array.isArray(reqBody?.sampleValues)) {
       sampleValues = reqBody.sampleValues.map(String);
     }
     numberId =
       typeof reqBody?.numberId === "string" && reqBody.numberId.length > 0
         ? reqBody.numberId
         : undefined;
   } catch {
     // No body or invalid JSON — proceed without sample values / numberId
   }
   ```

   Validation: `numberId`, if present, must be a non-empty string; any other type is
   treated as not provided, consistent with the existing lenient body parse.
5. *same* — 1024-char body guard (400, no Meta call). Runs before credential
   resolution so an over-long body still short-circuits exactly as today (AC-2 #4).
6. **changed** — resolve the number (replaces the `env.META_WABA_ID/ACCESS_TOKEN`
   block):
   - Determine the target number per §4.3 precedence. Each candidate lookup is a
     `prisma.whatsAppNumber.findFirst` scoped by `userId: session.user.id`,
     `verificationStatus: "verified"`, with `wabaId` and `accessToken` not null.
     - If `numberId` provided: `findFirst({ where: { id: numberId, userId, verificationStatus: "verified", wabaId: { not: null }, accessToken: { not: null } } })`. If not found → 400 `{ error: "Selected WhatsApp number is not connected", code: "NUMBER_NOT_CONNECTED" }` (it was explicitly requested, so there is no ambiguity — the chosen number is simply not connected).
     - Else if `template.whatsappNumberId`: `findFirst({ where: { id: template.whatsappNumberId, userId, verificationStatus: "verified", wabaId: { not: null }, accessToken: { not: null } } })`. If the bound number is no longer usable, fall through to the "user's numbers" branch (the binding is stale).
     - Else: `findMany({ where: { userId, verificationStatus: "verified", wabaId: { not: null }, accessToken: { not: null } } })`; 0 → 409 not-connected; 1 → use it; >1 → 400 `AMBIGUOUS_NUMBER`.
   - Resolve creds: `let wabaId, accessToken; try { ({ wabaId, accessToken } = resolveWabaCredentials(number)); } catch { return 500 "credential error" }` (see §7). After this, `wabaId` and `accessToken` are guaranteed non-null because the query already filtered on them; the resolver nulls path cannot be hit here, but we still guard defensively and treat null as 409 not-connected.
7. *same* — Meta name sanitization (lowercase / underscore collapse) — unchanged (AC-2 #5).
8. *same* — build `requestBody` with `buildComponents(template, sampleValues)` — unchanged.
9. *same* — `POST https://graph.facebook.com/v19.0/${wabaId}/message_templates` with `Authorization: Bearer ${accessToken}` — only `wabaId`/`accessToken` source changed.
10. *same* — on `!metaRes.ok`: the `META_TOKEN_EXPIRED` (code 190 / "Session has expired") → 401 branch is preserved verbatim; other errors → 400 with `error_user_title`/`message` + `detail` (AC-8 #15).
11. **changed (additive)** — success write-back adds the `whatsappNumberId` binding per §4.4; `status/metaTemplateId/submittedAt` unchanged (AC-2 #3).
12. *same* — outer `try/catch` → 500 "Internal server error".

### 5.1 Error contract (submit)

| Condition | Status | Body | Meta called? | Logged? |
|---|---|---|---|---|
| No session | 401 | `{ error: "Unauthorized" }` | no | no |
| Template not owned/missing | 404 | `{ error: "Template not found" }` | no | no |
| Status not draft/rejected | 400 | existing message | no | no |
| Body > 1024 | 400 | existing char-limit message | no | no |
| Explicit `numberId` not usable | 400 | `{ error: "Selected WhatsApp number is not connected", code: "NUMBER_NOT_CONNECTED" }` | no | info line, no token |
| 0 usable numbers | 409 | `{ error: "Connect a WhatsApp number before managing templates" }` | no | info line, no token |
| >1 usable, none chosen/bound | 400 | `{ error, code: "AMBIGUOUS_NUMBER" }` | no | info line, no token |
| `decrypt()` throws | 500 | `{ error: "credential error" }` | no | `console.error("[Template submit] credential resolution failed (encryption/config)")` — **no token/ciphertext** |
| Meta 190 / session expired | 401 | `{ error, code: "META_TOKEN_EXPIRED" }` | yes | existing |
| Other Meta error | 400 | existing `error`/`detail` | yes | existing |
| Success | 200 | updated template | yes | existing |

## 6. Sync route — detailed design

File: `src/app/api/templates/sync/route.ts`

### 6.1 WABA selection decision — iterate all the user's connected verified WABAs

Candidates were: (a) explicit `wabaId`/`numberId` param, (b) iterate all of the
user's connected verified WABAs, (c) a single selected number. **Chosen: (b) iterate
all usable numbers, deduped by `wabaId`.**

Justification: sync is a bulk reconciliation whose job is to make the local DB
reflect Meta. The current contract takes **no params** (`POST()` with empty body)
and the frontend calls it with no body (`fetch("/api/templates/sync", { method: "POST" })`).
Requiring a param now would be a breaking change to a working button. A tenant may
legitimately have more than one WABA, and the user expects "sync" to reconcile *all*
of their templates, not an arbitrarily chosen one. Iterating all usable WABAs:

- keeps the zero-param frontend contract intact (no UI change),
- correctly reconciles multi-WABA tenants,
- degenerates to exactly today's behavior for a single-WABA tenant.

To avoid redundant calls when several numbers share a WABA, **dedupe the resolved
list by `wabaId`** and fetch each distinct WABA once. Keep a map `wabaId → numberId`
(first number encountered for that WABA) so imports can be bound to a concrete number
(§6.3).

### 6.2 Flow

1. *same* — auth guard (401).
2. **changed** — resolve usable numbers and build the WABA map. Query all usable
   numbers, then populate a typed `Map<wabaId, { numberId, accessToken }>` with
   explicit decrypt-throw and null handling (addresses design-review finding 3):

   ```ts
   const numbers = await prisma.whatsAppNumber.findMany({
     where: {
       userId: session.user.id,
       verificationStatus: "verified",
       wabaId: { not: null },
       accessToken: { not: null },
     },
   });
   if (numbers.length === 0) {
     return NextResponse.json(
       { error: "Connect a WhatsApp number before managing templates" },
       { status: 409 }, // AC-6 #13 — Meta not called
     );
   }

   // wabaId → { numberId, accessToken }, first number wins per WABA
   const wabaMap = new Map<string, { numberId: string; accessToken: string }>();
   for (const number of numbers) {
     let creds: { wabaId: string | null; accessToken: string | null };
     try {
       creds = resolveWabaCredentials(number);
     } catch {
       // AC-7 — a single bad ciphertext aborts the whole sync with a clean 500,
       // no partial state, no token/ciphertext logged.
       console.error(
         "[Template sync] credential resolution failed (encryption/config)",
       );
       return NextResponse.json(
         { error: "credential error" },
         { status: 500 },
       );
     }
     // Defensive: the findMany already filters wabaId/accessToken not-null, so
     // this branch is effectively unreachable, but guard anyway (consistent with
     // submit's defensive null guard). Skip rather than 500 — a null here means a
     // row slipped through the filter, not a crypto failure.
     if (!creds.wabaId || !creds.accessToken) continue;
     if (!wabaMap.has(creds.wabaId)) {
       wabaMap.set(creds.wabaId, {
         numberId: number.id,
         accessToken: creds.accessToken,
       });
     }
   }
   if (wabaMap.size === 0) {
     return NextResponse.json(
       { error: "Connect a WhatsApp number before managing templates" },
       { status: 409 },
     );
   }
   ```

   The decrypt-throw path is a hard 500 (AC-7); the null-creds path is a defensive
   `continue` because the query already guarantees non-null and a null therefore
   indicates a filtered row slipping through, not a credential error. If every row
   is somehow skipped, the trailing `wabaMap.size === 0` guard returns the same 409
   as the no-numbers case.
3. **changed** — iterate the distinct WABAs. Declare the accumulator with a widened
   element type and initialize it to `[]` (addresses design-review finding 1 — the
   live `metaTemplates` is declared `= metaData.data ?? []` with a fixed inline
   element type that has no `__sourceNumberId` field):

   ```ts
   type MetaTemplate = {
     id: string;
     name: string;
     status: string;
     category: string;
     language: string;
     components?: Array<{ type: string; text?: string; format?: string }>;
     __sourceNumberId: string; // transient: source WhatsAppNumber id for this WABA
   };
   const metaTemplates: MetaTemplate[] = []; // was: = metaData.data ?? []
   ```

   For each `[wabaId, { accessToken }]` entry in `wabaMap`, run the existing
   `GET .../v19.0/${wabaId}/message_templates?fields=...&access_token=${accessToken}`
   fetch and push its results (tagged with the source number) into `metaTemplates`:

   ```ts
   for (const [wabaId, { numberId, accessToken }] of wabaMap) {
     const metaRes = await fetch(/* existing URL, per-WABA wabaId + accessToken */);
     if (!metaRes.ok) {
       /* token-expired / other-error handling below */
     }
     const metaData = await metaRes.json();
     for (const t of (metaData.data ?? []) as Omit<MetaTemplate, "__sourceNumberId">[]) {
       metaTemplates.push({ ...t, __sourceNumberId: numberId });
     }
   }
   ```

   Error handling per fetch:
   - `!metaRes.ok` → inspect for token-expired (code 190 / "Session has expired").
     If expired → return **401** `{ error, code: "META_TOKEN_EXPIRED" }` (AC-8 #15,
     newly applied in sync). Other non-ok → return **400** with the Meta message,
     exactly as today. (Sync aborts on the first failing WABA rather than silently
     importing a partial set — consistent with the current single-WABA "return 400
     on Meta error" behavior.)
4. *same* — everything downstream is **byte-for-byte unchanged**: `mapMetaStatus`,
   `sanitize`, `byId`/`byName` lookup maps, the per-user `findMany` of local
   templates, dedup-by-sanitized-name (`deleteMany` of duplicates), the update loop,
   and the Meta-only import loop. All scoped to `session.user.id` (AC-3 #7,
   AC-5 #11). Note the import `create` already uses `userId: session.user.id`.
5. **changed (additive)** — in the import `create`, set `whatsappNumberId` to the
   `numberId` recorded for that Meta template's source WABA (§6.3), so imported
   Meta-only templates are associated with the number/WABA they came from.
6. *same* — response shape unchanged: `{ synced, updated, imported, duplicatesRemoved }` (AC-3 #8).
7. *same* — outer catch → 500.

### 6.3 Binding imported templates to their source number

Since templates are fetched per WABA, we know which WABA each Meta template came
from. The tagging and accumulation are shown in §6.2 step 3: `metaTemplates` is
declared `MetaTemplate[]` (the **widened** element type that *includes*
`__sourceNumberId: string`) and initialized to `[]`, and each per-WABA fetch pushes
`{ ...t, __sourceNumberId: numberId }`. This is the concrete fix for design-review
finding 1 — the live code's inline element type (no `__sourceNumberId`) and
`= metaData.data ?? []` initializer are both replaced.

`__sourceNumberId` is a transient in-memory field (not persisted as-is). In the
Meta-only **import `create`**, set `whatsappNumberId: meta.__sourceNumberId`.
Because `whatsappNumberId` is a real optional column on `Template`, the existing
`satisfies Prisma.TemplateUncheckedCreateInput` on the `create` data object stays
valid once `whatsappNumberId` is added. (The type that needed widening was the
`metaTemplates` array element type — now `MetaTemplate` — not the create input.)

Local-update rows (the update loop) are left as-is — we do **not** rebind an
already-local template on sync, to avoid stomping an explicit binding a user set via
submit. The update loop reads from `byId`/`byName`, which are now built over the
`MetaTemplate[]` accumulator; those lookups ignore `__sourceNumberId`, so the
widened type is transparent to the unchanged update path.

### 6.4 Error contract (sync)

| Condition | Status | Body | Logged? |
|---|---|---|---|
| No session | 401 | `{ error: "Unauthorized" }` | no |
| 0 usable numbers | 409 | `{ error: "Connect a WhatsApp number before managing templates" }` | info, no token |
| `decrypt()` throws | 500 | `{ error: "credential error" }` | `console.error("[Template sync] credential resolution failed (encryption/config)")` — no token |
| Meta 190 / expired on any WABA | 401 | `{ error, code: "META_TOKEN_EXPIRED" }` | existing |
| Other Meta non-ok | 400 | existing Meta message | existing |
| Success | 200 | `{ synced, updated, imported, duplicatesRemoved }` | existing |

## 7. Delete route — detailed design

File: `src/app/api/templates/[id]/route.ts` (DELETE handler only; GET/PUT untouched).

Imports add: `import { resolveWabaCredentials } from "@/lib/whatsapp";`

Flow:

1. *same* — auth (401), load template scoped by `userId` (404 if missing).
2. **changed** — replace the `template.metaTemplateId && env.META_WABA_ID && env.META_ACCESS_TOKEN` guard with per-tenant resolution:
   - Only attempt a Meta delete if `template.metaTemplateId` is set.
   - Resolve the number: `template.whatsappNumberId` (scoped by userId, usable) if
     set; else the user's single usable number; else (0 or ambiguous) → **skip** the
     Meta delete (best-effort), log an info line (no token), proceed to local delete.
   - If a number resolves, wrap credential resolution:
     ```ts
     let wabaId: string | null = null, accessToken: string | null = null;
     try {
       ({ wabaId, accessToken } = resolveWabaCredentials(number));
     } catch {
       console.warn("[Template delete] credential error — skipping Meta delete");
       // best-effort: do NOT fail the request; fall through to local delete
     }
     if (wabaId && accessToken) {
       await fetch(`.../v19.0/${wabaId}/message_templates?hsm_id=${template.metaTemplateId}&name=${template.name}`,
         { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
       ).catch((e) => console.warn("Meta delete warning:", e));
     }
     ```
   - **Scope note (design-review finding 6):** `template.name` is interpolated into
     the DELETE query string **unencoded**. This is carried forward verbatim from the
     current code — it is pre-existing, not a regression introduced here, and encoding
     it is **out of scope** for this task. The implementer must leave it as-is (do not
     "clean it up"); only the `wabaId`/`accessToken` source changes on this line.
   - Note delete deliberately diverges from submit/sync on decrypt-throw: because
     delete is **best-effort and non-fatal** (AC-4 #10), a decrypt throw here is
     caught and the Meta step skipped rather than returning 500. The local delete
     must never be blocked by a credential problem.
3. *same* — `await prisma.template.delete({ where: { id: params.id } })` always runs
   after the best-effort Meta step (AC-4 #10).
4. *same* — response `200 { message: "Template deleted successfully" }`; outer catch → 500.

### 7.1 Token-expired in delete

Since the Meta delete uses `.catch(...)` and ignores the response body (it does not
even `await metaRes.json()` today), a 190/expired response is already swallowed as a
non-fatal warning. We keep that: applying explicit `META_TOKEN_EXPIRED` surfacing in
a best-effort cleanup would contradict its non-fatal contract. This satisfies AC-8's
"where sensible" qualifier — delete's sensible behavior is to stay silent and still
delete locally.

### 7.2 Error contract (delete)

| Condition | Status | Body | Local delete runs? |
|---|---|---|---|
| No session | 401 | `{ error: "Unauthorized" }` | no |
| Template not owned/missing | 404 | `{ error: "Template not found" }` | no |
| No metaTemplateId / 0 usable number / ambiguous | 200 | success | **yes** (Meta skipped) |
| decrypt throws | 200 | success | **yes** (Meta skipped, warn logged, no token) |
| Meta DELETE fails | 200 | success | **yes** (warn logged) |
| Success | 200 | `{ message: "Template deleted successfully" }` | yes |

## 8. Schema

**No schema change is required.** `Template.whatsappNumberId String?` and its
`whatsappNumber WhatsAppNumber?` relation already exist in `prisma/schema.prisma`,
and `WhatsAppNumber` already carries `wabaId`, `accessToken` (ciphertext), and
`verificationStatus`. The design reuses these columns:

- submit sets `whatsappNumberId` (write to an existing nullable column — additive at
  the data level, not the schema level),
- sync sets `whatsappNumberId` on imported rows,
- delete reads `whatsappNumberId`.

Because no column is added, there is **no migration script and no `db push`**. (If a
future change ever required a column, it would be nullable/additive and applied via
an idempotent `@libsql/client` script under `scripts/` mirroring
`scripts/add-meta-onboarding-columns.mjs`; `prisma db push` is not usable here —
Prisma CLI 5.22 rejects `libsql://` with P1012. This design does not need that.)

## 9. Multi-tenant isolation (security invariant)

- Every template lookup uses `findFirst({ where: { id, userId: session.user.id } })` — unchanged, already correct.
- Every `WhatsAppNumber` lookup (explicit `numberId`, bound `whatsappNumberId`, or
  the "user's numbers" list) is filtered by `userId: session.user.id`. A number
  bound to a template but owned by another user can never resolve because every
  candidate query carries the `userId` filter. (AC-5 #11, #12.)
- `resolveWabaCredentials` only ever receives a row the route already fetched under
  the `userId` filter, so no cross-tenant WABA can reach a Meta call.
- No route reads `META_WABA_ID` / `META_ACCESS_TOKEN` after this change (AC-10 #17).

## 10. Error handling summary (cross-route invariants)

- **Not connected (0 usable numbers):** submit → 409, sync → 409, delete → skip Meta
  + local delete. Message: "Connect a WhatsApp number before managing templates".
  Never a 500, never an env fallback (AC-6).
- **Decrypt throw:** submit/sync → 500 `{ error: "credential error" }`; delete →
  caught, Meta skipped, local delete proceeds. In all cases the token/ciphertext is
  never logged or returned; the only log is a fixed string with no secret (AC-7).
- **Token expired (190 / "Session has expired"):** preserved in submit (401 +
  `META_TOKEN_EXPIRED`); newly applied in sync (401 + `META_TOKEN_EXPIRED`); in
  delete left non-fatal/silent per its best-effort contract (AC-8).

## 11. Validation rules for external inputs

| Input | Where | Required? | Type | On failure |
|---|---|---|---|---|
| `params.id` | all three | required | string (route param) | 404 via scoped `findFirst` |
| `sampleValues` | submit body | optional | `unknown[]` → `String`-mapped | existing: ignored if not array |
| `numberId` | submit body | optional | string | read from the single `request.json()` call (same `reqBody` as `sampleValues`); non-string/empty ignored (treated as absent); provided-but-not-usable → 400 `NUMBER_NOT_CONNECTED` |
| session | all three | required | next-auth session | 401 |

Sync takes no body; its only "input" is the authenticated user's set of numbers.

## 12. Testability

- **Unit-testable (pure):** `resolveWabaCredentials` — three cases: both fields set →
  `{ wabaId, decrypt(accessToken) }`; either null → `{ null, null }`; tampered
  ciphertext → throws. The repo has no formal test runner (per prior review); follow
  the established `.mjs` script convention under `scripts/` if a smoke test is
  wanted (e.g. `scripts/test-resolve-waba.mjs`), encrypting a known value and
  asserting round-trip, mirroring the existing crypto smoke pattern. No new test
  dependency.
- **Integration (requires session + Turso):** the three routes' mapping branches
  (0 / 1 / >1 numbers, explicit `numberId`, bound `whatsappNumberId`, decrypt throw,
  Meta 190). These are best exercised against a seeded dev DB; document the matrix
  in the plan. The design keeps each branch as an early return, which keeps the
  routes shallow and the branches independently reachable.
- The resolver being pure and synchronous (no `prisma`, no `session`) is the key
  testability choice — it isolates the only crypto-touching logic from the route's
  async/auth concerns.

## 13. Files touched

| File | Change |
|---|---|
| `src/lib/whatsapp.ts` | **add** exported `resolveWabaCredentials` (sibling to `resolveSendCredentials`) |
| `src/app/api/templates/[id]/submit/route.ts` | rewire creds, add optional `numberId`, bind `whatsappNumberId` on success, remove env reads |
| `src/app/api/templates/sync/route.ts` | rewire to iterate usable WABAs, bind imports, apply 190 detection, remove env reads |
| `src/app/api/templates/[id]/route.ts` (DELETE) | rewire best-effort delete to per-tenant creds, remove env reads |
| `src/app/dashboard/templates/new/page.tsx` & `.../[id]/page.tsx` | **optional/additive** — pass selected `numberId` to unblock multi-number tenants (not required for single-number tenants) |
| `scratchpad.md` | update per the project scratchpad rule (routes now per-tenant; env pair no longer read here; new resolver; mapping rules; multi-number submit requires `numberId`) |

No new dependencies; no schema change; no migration script.

## 14. Edge cases

- **Template bound to a now-unusable number:** submit falls through to the user's
  numbers (stale binding tolerated); delete skips Meta (best-effort). Neither 500s.
- **Several numbers sharing one WABA (sync):** deduped by `wabaId`, fetched once;
  imports bound to the first number seen for that WABA.
- **Explicit `numberId` for a number owned by another user:** `findFirst` with the
  `userId` filter returns null → 400 `NUMBER_NOT_CONNECTED` (indistinguishable from
  "your own number isn't connected" — cannot leak whether the other tenant's number
  exists).
- **Over-1024 body with no connected number:** 1024 guard runs first → 400 char
  limit, before any number resolution (preserves AC-2 #4 ordering).
- **Single-number tenant, no frontend change:** submit/sync/delete all resolve the
  sole number automatically — zero behavioral regression for today's users.

## 15. Assumptions

- "Connected/usable" = `verificationStatus === "verified"` AND `wabaId != null` AND
  `accessToken != null`, consistent with the send route. (Requirements Assumption.)
- The common tenant has exactly one connected number; multi-number is the exception
  the `AMBIGUOUS_NUMBER` / `numberId` path serves.
- Env vars `META_WABA_ID` / `META_ACCESS_TOKEN` remain in `.env`/`.env.example` for
  other code paths (out of scope to remove); this task only stops the three routes
  from reading them.

## 16. Review responses (revision 2)

Dispositions for every finding in `.agents/tasks/design-review.json`
(verdict: CHANGES_REQUESTED). All are **addressed** in the body above.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | HIGH | Sync `metaTemplates` fixed-shape type can't hold `__sourceNumberId`; initializer must change from `= metaData.data ?? []` to `= []`. | **Addressed.** §6.2 step 3 now declares `type MetaTemplate` (widened to include `__sourceNumberId: string`), initializes `const metaTemplates: MetaTemplate[] = []`, and pushes per-WABA results cast to `Omit<MetaTemplate, "__sourceNumberId">`. §6.3 restated to point at the widened array element type (not the create input) and notes `byId`/`byName`/update loop are transparent to it. |
| 2 | MEDIUM | Submit `numberId` must come from the single `request.json()` call that already reads `sampleValues`; a second read throws and is swallowed. | **Addressed.** §5 step 4 now shows one `request.json()` inside the existing try block reading both `sampleValues` and `numberId` (`typeof reqBody?.numberId === "string" && reqBody.numberId.length > 0 ? ... : undefined`); explicitly forbids a second body read. §11 row updated. |
| 3 | MEDIUM | Sync `wabaMap` value shape, first-wins population, decrypt-throw vs null handling underspecified. | **Addressed.** §6.2 step 2 now shows the typed `Map<string, { numberId: string; accessToken: string }>`, decrypt-throw → 500 "credential error" (no token logged), null-creds → defensive `continue` (query already filters non-null), first-number-per-`wabaId` wins, and a trailing `wabaMap.size === 0` → 409 guard. |
| 4 | NIT | `AMBIGUOUS_NUMBER` reused for the explicit-but-unusable case (misleading for frontend branching). | **Addressed.** §4.3, §5 step 6, §5.1 table, §11 table, and §14 now use `NUMBER_NOT_CONNECTED` for an explicitly selected unusable number; `AMBIGUOUS_NUMBER` is reserved for ">1 usable, none chosen." |
| 5 | NIT | §4.1 wrongly claims single-number auto-resolution "matches the send route's ergonomics" (send route requires explicit `numberId`). | **Addressed.** §4.1 reworded: auto-resolution is justified by keeping the zero-`numberId` frontend contract working for the common one-number tenant, and explicitly states it does *not* mirror the send route (which requires an explicit `numberId`). |
| 6 | NIT | Delete `name` interpolated unencoded into the Meta DELETE URL — pre-existing, out of scope. | **Addressed (left as-is, on record).** §7 step 2 adds a scope note: the unencoded `template.name` is carried forward verbatim, is not a new regression, and must not be "cleaned up" in this task; only the creds source changes on that line. |
