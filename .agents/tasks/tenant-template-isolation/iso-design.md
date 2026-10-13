# Technical Design — Tenant Template Isolation

Last updated: 2025-02-16
Status: Revision 3 (resolves design review `iso-design-review.md` rev 2: 1 HIGH, 2 MEDIUM, 3 NIT)
Requirements: `.agents/tasks/tenant-template-isolation/iso-requirements.md`
Review: `.agents/tasks/tenant-template-isolation/iso-design-review.md` /
`.agents/tasks/tenant-template-isolation/iso-design-review.json`

## Overview

Surshyam (`userId cmv321v6j0000hjwlr4cxp7w5`) can see Utkranti's
(`userId cmn1cinmh0000jmdn4fs17kn1`) WhatsApp message templates. The list query
is already correct — `GET /api/templates` filters on `session.user.id` — so this
is not a read-side leak. Utkranti's templates were **physically written** as
`Template` rows under Surshyam's `userId` by the sync-import path, because
Surshyam's manually-connected number stores a `wabaId` (`989050294147122`) that
is not a real WABA, yet the Meta Graph call under Surshyam's token still returned
Utkranti's templates.

This design covers four code artifacts and one data decision, all additive and
within the locked stack: **TypeScript, Next.js 14 App Router (`NextResponse`
handlers), Prisma 5.x client over a libSQL/Turso datasource, `@libsql/client`
for DB migration/cleanup scripts, AES-256-GCM via `@/lib/crypto`.** No new
runtime dependencies, no schema column added to `Template` or `WhatsAppNumber`,
no change to `npm run db:push` (which cannot speak `libsql://`).

The guard scheme chosen is **positive-ownership-only import at sync time via a
WABA→number tie-check, combined with a write-site source guard** (Option B
below). The crucial change in this revision: a `wabaId` is imported from **only**
when a live `GET /{wabaId}/phone_numbers` probe returns `ok` AND lists a phone id
the tenant owns. Every other probe outcome — not-a-WABA, foreign, transient,
permission, 5xx, network, or an unevaluable owned-phone set — results in a
**SKIP, never an import**. This closes the HIGH-1 re-leak path that the previous
revision's "trust the stored `wabaId`" fallback left open. The cleanup predicate
is a **`metaTemplateId` cross-tenant match** that deletes only Surshyam rows
whose `metaTemplateId` also appears under a different `userId`. The Surshyam
bad-WABA row is cleared by a **separate sibling script**.

### Required run order (MEDIUM-2)

The three deliverables are **sequenced**, and the sync change does not assume any
`WhatsAppNumber` row is clean:

1. **§4 cleanup** — remove the already-leaked Utkranti rows from under Surshyam.
2. **§5 flag** — clear the bad `wabaId = 989050294147122` on Surshyam's number
   (sets it to `NULL` + `verificationStatus = 'pending'`), so it leaves the sync
   `findMany` entirely.
3. **§2 / §3 deploy** — ship the hardened sync gate and manual-connect
   classifier.

This ordering is belt-and-suspenders. §2's gate is written so that it enforces
isolation **independently** of whether §4/§5 have run: even if the bad
`989050294147122` row still existed and were probed, §2 would SKIP it (it can
never return a positive owned-phone match), so no import occurs. §5 is still run
first so the bad row stops appearing in the tenant's number list and the tenant
gets a clear signal to reconnect; it is not a correctness precondition for §2.

### What changed in this revision (review response summary)

| Finding | Resolution |
|---|---|
| HIGH-1 | §2 gate redesigned to **positive-match-only import**. The two "trust stored `wabaId`" IMPORT branches (transient/permission probe, and empty `ownedPhoneNumberIds`) are **removed** — both now SKIP. The only path to IMPORT is a live `ok` probe whose returned phone list contains a `phoneNumberId` the tenant owns. A stored `wabaId` that has never been positively matched to an owned phone id is NEVER imported on a non-`ok` (or unevaluable) probe. The FR6 tolerance tradeoff (an under-scoped token now imports nothing until it can list its own phones) is acknowledged explicitly below. |
| MEDIUM-1 | §3 capture step promoted to a **design-closing prerequisite** (§3 + §6 step 0). The committed `isNotAWabaError` must be confirmed to return `true` for the exact observed shape of `989050294147122`; if the observed status is not 400, the classifier is widened to the observed status for bad-object signals — never a bare `code 100`. |
| MEDIUM-2 | Explicit run order added (above, §2, §7). The "trust stored `wabaId`" safety language is removed; §2 now states it does not assume any `WhatsAppNumber` row is clean. |
| NIT-1 | Ownership match narrowed to the specific `phoneNumberId` stored on the number carrying the probed `wabaId` (branch-(a) semantics), not any tenant phone. |
| NIT-2 | §1 notes the `resolveWabaCredentials(number)` full-row call is intentional (structural typing); the implementer must not narrow it. |
| NIT-3 | §5 states its idempotency reason inline, mirroring §4. |

---

## 1. Confirmed import mechanism (root cause, grounded in code)

### Where the rows are created

`src/app/api/templates/sync/route.ts`, in the **"Import templates that exist on
Meta but not locally"** loop (`for (const meta of metaTemplates)` near the end).
The row is created by (verbatim from the current code):

```ts
await prisma.template.create({
  data: {
    userId: session.user.id,          // ← stamped with the CURRENT tenant (Surshyam)
    name: meta.name,
    category: meta.category.toLowerCase(),
    language: language,
    body: bodyText,
    headerType,
    headerContent,
    footerContent,
    status: mapMetaStatus(meta.status),
    metaTemplateId: meta.id,          // ← Utkranti's Meta template id
    whatsappNumberId: meta.__sourceNumberId,  // ← non-null (Surshyam's bad number)
    submittedAt: new Date(),
    reviewedAt: new Date(),
  } satisfies Prisma.TemplateUncheckedCreateInput,
});
```

`meta.__sourceNumberId` is stamped earlier in the fetch loop
(`metaTemplates.push({ ...t, __sourceNumberId: numberId })`), where `numberId`
is the Surshyam `WhatsAppNumber.id` resolved from `wabaMap`. (Confirmed in the
current code: the fetch loop iterates `for (const [wabaId, { numberId,
accessToken }] of wabaMap)` and pushes each returned template tagged with that
`numberId`.)

### Exact reason Utkranti's templates landed under Surshyam

1. Surshyam connected `919720996300` via `POST /api/numbers/manual` with
   `wabaId = 989050294147122` (a Meta **messaging-account** id, not a WABA id).
   The three-way tie-check's branch **(c)** — the `else { console.warn(...) }`
   when `GET /{wabaId}/phone_numbers` is **not** `ok` — treated that failed WABA
   read as **non-fatal** and let the row persist as a `verified`
   `WhatsAppNumber` carrying the wrong `wabaId`. (Confirmed in
   `numbers/manual/route.ts`: the health check in step 1 is `GET /{phoneNumberId}`
   and is independent of the WABA list, so a valid phone+token with a bad
   `wabaId` persists today.)
2. On `POST /api/templates/sync`, that number passed the `findMany` filter
   (`verificationStatus: "verified"`, `wabaId: { not: null }`,
   `accessToken: { not: null }`), so `resolveWabaCredentials(number)` produced
   `989050294147122` + Surshyam's decrypted token. The sync then called
   `GET https://graph.facebook.com/v19.0/989050294147122/message_templates?...&access_token=<token>`.
   **That call returned Utkranti's templates** — under Surshyam's token the
   id/token combination resolved to a context from which Utkranti's WABA
   templates were readable (the token had read access across a shared Meta
   app/BM context). The handler imported every returned template under
   `session.user.id` = Surshyam.

Note (per review Unverified-Assumption #3): the exact Meta-side mechanism of
step 2 ("the id/token resolved to Utkranti's context") is a claim about live
Graph behavior, not something verifiable from the repo. The fix does **not**
depend on the exact mechanism — a positive owned-phone ownership match at sync
(§2) plus rejecting non-WABA ids at connect (§3) blocks this leak class
regardless of how Meta resolved the foreign context. `989050294147122` can never
return a phone id Surshyam owns, so the §2 positive-match gate SKIPs it.

### What the current code already does right (do NOT re-derive as missing)

- The brief's claim "imports set `whatsappNumberId=null`" is **stale for new
  imports.** New imports already stamp `whatsappNumberId: meta.__sourceNumberId`
  (non-null). So the hardening target is **ownership verification of the WABA**,
  not null-stamping.
- Sync already **dedupes verified numbers by `wabaId`** (`wabaMap`): a WABA
  shared by multiple numbers is fetched once; "first number per WABA owns
  imports." (The `findMany` currently has no `orderBy`, so "first" is Turso's
  return order; `__sourceNumberId` attribution between two numbers under the SAME
  real WABA is nondeterministic — harmless for isolation since both belong to the
  tenant. No `orderBy` change is required for correctness; see NIT-1 note in §2
  for why ownership is now matched per-`wabaId` rather than per-tenant.)
- `GET /api/templates` is already `userId`-scoped (confirmed in
  `src/app/api/templates/route.ts`: `findMany({ where: { userId:
  session.user.id } })`), and `POST /api/templates` dedupes names per user. No
  change (AC8).
- `resolveWabaCredentials` destructures only `{ wabaId, accessToken }`
  (confirmed in `src/lib/whatsapp.ts`); the sync passes the full `number` row and
  it compiles via structural typing (NIT-2). **This full-row call is
  intentional** — the implementer must not "fix" it by narrowing the argument.

### State of the already-leaked DB rows

The leaked rows were written **before** the current `__sourceNumberId` stamping
existed on the import path (or via a prior code path). Per the requirements,
those rows **may have `whatsappNumberId = null`** even though the current import
path now stamps it. The cleanup script (§4) therefore must **not** rely on
`whatsappNumberId` being null or non-null — it keys on `metaTemplateId`
cross-tenant collision, which holds regardless of the `whatsappNumberId` value.

---

## 2. Sync hardening design

### Decision: Option B — positive-ownership-only import + write-site source guard (CHOSEN)

Three guard schemes were viable:

- **Option A — Schema stamp (`Template.sourceWabaId`) + constraint.** Add a
  column recording the WABA each row was imported from and reject mismatches.
  Rejected: requires a schema migration (Out of Scope) and still would not have
  stopped the original leak, because the bad WABA id was itself trusted. It
  fixes auditing, not the trust gap.
- **Option B — At fetch time, verify each `wabaId` is a real WABA the tenant
  owns by probing `GET /{wabaId}/phone_numbers` and requiring the returned phone
  list to contain the specific `phoneNumberId` stored on the number that carried
  that `wabaId`. Import ONLY on that positive match; SKIP on every other outcome.
  Plus a defensive `__sourceNumberId` guard at every write site.** CHOSEN.
- **Option C — Trust manual-connect validation alone (§3) and change nothing in
  sync.** Rejected: defense-in-depth. §3 stops *future* bad connects, but sync
  is the component that actually writes cross-tenant rows; it must enforce the
  invariant itself so a bad row already in `WhatsAppNumber` (such as the live
  `989050294147122`) cannot leak again.

Option B reuses the **exact Graph edge already used in `numbers/manual/route.ts`**
(`GET /{wabaId}/phone_numbers` with the `Authorization: Bearer` header), so it
introduces no new integration pattern, no new dependency, and no schema change.

### The enforced invariant (positive-match only — HIGH-1 resolution)

> A `Template` row for tenant X with a non-null `metaTemplateId` is only ever
> created/updated from a `wabaId` that is (1) stored on one of X's own
> `verified` `WhatsAppNumber` rows, AND (2) **positively proven at sync time** to
> be a real WABA X owns — a live `GET /{wabaId}/phone_numbers` under X's token
> returned `ok` and the returned phone list contains the `phoneNumberId` stored
> on the number that carried that `wabaId`.

There is **no trust fallback.** A stored `wabaId` that has never been positively
matched to an owned phone id in the current run is **never imported from** on a
non-`ok` probe, on a `foreign` probe, or on a probe whose owned-phone set cannot
be evaluated. This directly closes the HIGH-1 re-leak path: the previous
revision's "trust the stored `wabaId` because §3 rejects non-WABA ids at write
time" premise is **false for `989050294147122`**, which is already persisted
today and which §3 (a future-only write guard) never validated. The gate below
does not rely on that premise at all.

The design explicitly removes the "trust stored `wabaId`" language that MEDIUM-2
flagged as circular. §2 enforces isolation **independently** and does not assume
any `WhatsAppNumber` row is clean.

### Per-WABA gate decision table (sync)

For each `wabaId` in `wabaMap`, run the ownership probe
`GET /{wabaId}/phone_numbers` with the `Authorization: Bearer` header, then
decide using the `phoneNumberId` stored on the source number for that `wabaId`
(call it `ownedPhoneId`):

| Probe result | Owned-phone match? | Decision | Reason recorded |
|---|---|---|---|
| `ok` | returned list contains `ownedPhoneId` (and `ownedPhoneId != null`) | **IMPORT** (positive proof of ownership — the only import path) | — |
| `ok` | list does not contain `ownedPhoneId`, OR `ownedPhoneId` is null | **SKIP** | `foreign-waba` |
| `!ok` + §3 not-a-WABA signal | n/a | **SKIP** (invalid id; AC4/AC12 signal) | `not-a-waba` |
| `!ok` + transient / permission / 5xx / network (§3 non-fatal class) | n/a | **SKIP** (ownership unprovable; never trust an unverified id) | `probe-unverifiable` |

This is the whole gate. Positive owned-phone match is the **only** path to
IMPORT. Every ambiguous or failed outcome SKIPs. `989050294147122` cannot pass
row 1 under any Graph behavior (it will never list a phone id Surshyam owns), so
it is skipped as `foreign-waba` (if the probe is `ok` and returns a foreign/empty
list), `not-a-waba` (if it returns the bad-object 400 signal), or
`probe-unverifiable` (any transient/permission failure) — never imported.

### FR6 / AC7 tolerance tradeoff (stated explicitly)

Removing the tolerant branches is a deliberate tradeoff that this design
**accepts and documents** per the review's HIGH-1 option 1:

- A tenant whose token legitimately owns a WABA but **cannot list that WABA's
  phone numbers** (token missing `whatsapp_business_management`, a transient Meta
  5xx/429, or a network blip at probe time) will now **import 0 templates** from
  that WABA for that run and see it in `skippedWabas` with reason
  `probe-unverifiable`. This is a behavior change from "import anyway" to "skip
  and surface."
- A tenant all of whose numbers have `phoneNumberId = null` (schema allows it)
  can never produce a positive match and will likewise import nothing.

This is the correct safety posture: the primary requirement (FR1/AC5 — "create
zero new cross-tenant `Template` rows") outranks the convenience of importing
under an unverifiable WABA. The user is given an actionable signal
(`skippedWabas` with a reason) rather than a silent partial result, and a retry
once the token can list its own phones (or the transient clears) imports
normally. The status-update path for templates the tenant **already has locally**
is unaffected when those templates were previously imported from a now-skipped
WABA only to the extent that no fresh Meta data is fetched for that WABA this
run; this is acceptable because stale status is strictly less harmful than a
re-leak, and a later successful probe refreshes it.

### Precise validation flow (edits to `sync/route.ts`)

The hardening is inserted **between** building `wabaMap` and the fetch loop.
`wabaMap` is extended to carry the source number's `phoneNumberId` so ownership
can be matched per-`wabaId` (NIT-1), not against the whole tenant.

1. Extend the `wabaMap` value type and population to include the source number's
   `phoneNumberId`:
   ```ts
   const wabaMap = new Map<
     string,
     { numberId: string; accessToken: string; phoneNumberId: string | null }
   >();
   // ... inside the existing loop, when first seeing a wabaId:
   wabaMap.set(creds.wabaId, {
     numberId: number.id,
     accessToken: creds.accessToken,
     phoneNumberId: number.phoneNumberId, // from the WhatsAppNumber row
   });
   ```
   (`number` is the existing `findMany` row; `phoneNumberId` is already selected
   because the current `findMany` has no `select`, so the full row is returned.)

2. For each `wabaId` in `wabaMap`, before fetching `message_templates`, run the
   ownership probe. **Auth mode (unchanged elsewhere):** the probe uses the
   `Authorization: Bearer` header to match the manual-connect handler. The
   pre-existing `message_templates` fetch keeps its `&access_token=` query-param
   form **unchanged** (AC7) — the two auth modes coexist deliberately and must
   not be "unified."
   ```ts
   const ownedPhoneId = wabaMap.get(wabaId)!.phoneNumberId;
   const phonesRes = await fetch(
     `https://graph.facebook.com/v19.0/${encodeURIComponent(wabaId)}/phone_numbers`,
     { headers: { Authorization: `Bearer ${accessToken}` } },
   );
   const phonesData = await phonesRes.json().catch(() => ({}));

   let decision: "import" | "skip";
   let reason: "foreign-waba" | "not-a-waba" | "probe-unverifiable" | undefined;

   if (phonesRes.ok) {
     const list: Array<{ id?: string }> = phonesData?.data ?? [];
     if (ownedPhoneId && list.some((p) => p.id === ownedPhoneId)) {
       decision = "import"; // positive proof of ownership — the ONLY import path
     } else {
       decision = "skip"; reason = "foreign-waba";
     }
   } else if (isNotAWabaError(phonesRes.status, phonesData?.error)) {
     decision = "skip"; reason = "not-a-waba"; // AC4 / AC12 signal
   } else {
     decision = "skip"; reason = "probe-unverifiable"; // transient/permission -> NEVER trust
   }

   if (decision === "skip") {
     skippedWabas.push({ wabaId, reason: reason! });
     continue; // do not fetch message_templates for this wabaId
   }
   ```
   Only `decision === "import"` WABAs proceed into the existing fetch →
   `metaTemplates` accumulation. The `message_templates` fetch, its error
   handling (token-expired → 401, other → 400), and the `metaTemplates.push({
   ...t, __sourceNumberId: numberId })` tagging are all **unchanged**.

3. Everything downstream (byId/byName maps, dedupe, update loop, import loop) is
   unchanged, preserving AC7 (`mapMetaStatus`, local name dedupe, the
   `existingMetaIds` `.filter(Boolean)` set).

4. **Write-site source guard (AC3):** add `if (!meta.__sourceNumberId) continue;`
   at the top of BOTH write paths — in the update loop (before
   `prisma.template.update`, keyed via the matched `meta`) and in the import loop
   (before `prisma.template.create`). `__sourceNumberId` is always a
   `WhatsAppNumber.id` from `wabaMap` for an imported template, so this guard is
   defensive: it guarantees AC3 at the write site even if a future refactor of
   the gate reintroduced a null-source template, and it keeps every
   imported/updated row's `whatsappNumberId` **non-null** and bound to the owning
   verified number (FR2/AC2). For the update loop, a local row matched to a
   `meta` whose `__sourceNumberId` is missing is skipped rather than updated
   (prevents cross-tenant status bleed, AC10).

### Response shape and skipped WABAs (NIT-3 of prior review)

The response **keeps the existing shape** `{ synced, updated, imported,
duplicatesRemoved }` (AC7) and adds one **additive, non-breaking** field:

```ts
skippedWabas: Array<{
  wabaId: string;
  reason: "foreign-waba" | "not-a-waba" | "probe-unverifiable";
}>
```

This is purely additive (existing consumers ignore unknown fields) and gives the
user something actionable when a WABA is skipped (a reason, not a bare count).
Only `wabaId` and a reason string are included — never the token.

If **every** WABA is skipped, `metaTemplates` is empty: the update loop finds no
Meta matches and the import loop imports nothing, so the handler returns
`{ synced: <local count>, updated: 0, imported: 0, duplicatesRemoved: <n>,
skippedWabas: [...] }` with HTTP 200 — a clean, non-500 result (AC4 "skip
without importing").

### Error handling (sync)

| Operation | Failure condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|---|
| `resolveWabaCredentials` | decrypt throws (bad key/tampered) | fatal | 500 `{"error":"credential error"}` | generic line, **no token/ciphertext** (AC6, NFR2) — unchanged |
| `GET /{wabaId}/phone_numbers` (ownership) | not-a-WABA Graph error (§3 classifier) | recoverable (skip WABA) | WABA in `skippedWabas` reason `not-a-waba`; 200 | `[Template sync] skipping non-WABA <wabaId>` (id only) |
| `GET /{wabaId}/phone_numbers` (ownership) | transient / permission / 5xx / network | recoverable (skip WABA) | WABA in `skippedWabas` reason `probe-unverifiable`; 200 | `[Template sync] skipping unverifiable waba <wabaId> (<status>)` (id + status only) |
| `phonesRes.ok` + no owned-phone match (or null `ownedPhoneId`) | foreign/unprovable WABA | recoverable (skip WABA) | WABA in `skippedWabas` reason `foreign-waba`; 200 | `[Template sync] skipping foreign waba <wabaId>` |
| `GET /{wabaId}/message_templates` | token expired (code 190) | fatal for run | 401 `META_TOKEN_EXPIRED` (**unchanged**) | existing `console.error("Meta sync error", ...)` |
| `GET /{wabaId}/message_templates` | other non-ok | fatal for run | 400 with Meta message (**unchanged**) | existing |

The `message_templates` fetch error handling is **unchanged** — hardening only
adds a gate in front of it, and the gate now never passes an unverified WABA
through to that fetch.

### Testability

- **Unit-testable** (pure, no network): (a) the ownership predicate — given a
  `phonesData.data` array, `phonesRes.ok`, the error object, and an
  `ownedPhoneId`, returns the decision table above; and (b) the §3
  `isNotAWabaError` classifier over a Graph error object. Both are extracted as
  small exported helpers.
- **Integration-testable** (mock `fetch`): `ok` + foreign phone list → 0
  imports, WABA in `skippedWabas` reason `foreign-waba` (AC5); `ok` + owned
  phone present → imports with non-null `whatsappNumberId` (AC2); not-a-WABA
  400 → skip reason `not-a-waba` (AC4); transient 500 probe → skip reason
  `probe-unverifiable` (HIGH-1 non-releak); null `ownedPhoneId` → skip reason
  `foreign-waba`.

---

## 3. Manual-connect WABA validation

### The bug in the current tie-check

In `numbers/manual/route.ts`, branch **(c)** collapses **every** non-ok
`GET /{wabaId}/phone_numbers` response into a single non-fatal `console.warn`
that logs only `phonesRes.status` (confirmed in the current code). For
`wabaId = 989050294147122`, that call fails with a Graph error meaning *the
object is not a WABA* — but branch (c) swallowed it and let the row persist.

**Would the current tie-check have caught `989050294147122`? No.** The health
check (step 1, `GET /{phoneNumberId}`) succeeds because the phone-number id and
token are individually valid, and branch (c) treats the WABA read failure as
non-fatal. So the wrong id was saved as a `verified` row. The fix is to split
branch (c) by error classification.

### MEDIUM-1: the error body for `989050294147122` must be captured and confirmed before close

The review correctly flagged that the design cannot *assume* `isNotAWabaError`
catches `989050294147122` — the entire fix (both the §3 connect rejection and the
§2 `not-a-waba` skip) hinges on this id being classifiable. The only existing log
(branch (c)) records just `phonesRes.status`, never the error body, so the body
cannot be reconstructed from the repo.

**This is now a design-closing prerequisite, not an implementation afterthought
(§6 step 0):** before the classifier is committed, run the one-off call

```
GET https://graph.facebook.com/v19.0/989050294147122/phone_numbers
Authorization: Bearer <Surshyam's stored token>
```

(or temporarily log `JSON.stringify(phonesData?.error)` — never the token — in
branch (c) for one real connect), record the observed **HTTP status** +
`code` / `type` / `error_subcode` in this section, and confirm the committed
`isNotAWabaError` returns `true` for that exact shape. If the observed status is
**not 400**, widen the classifier to the observed status for the bad-object
signals (see below) — do **not** fall back to a bare `code 100` rule.

> **Capture result (to be filled at implementation time, blocks ship):**
> `989050294147122/phone_numbers` → HTTP `____`, error `{ code: ___, type:
> "____", error_subcode: ___, message: "____" }`. Classifier returns `true`: ___.

### Not-a-WABA classifier (shared, pure helper)

Add an exported pure helper in `src/lib/whatsapp.ts` so sync §2 reuses it:

```ts
// A Graph error that PROVES the given id is not a usable WhatsApp Business
// Account (so manual-connect must reject and sync must hard-skip). Only an
// HTTP 400 (or the status observed for 989050294147122 at capture time, if it
// differs — recorded in §3) that identifies a bad object/edge is fatal.
// Everything else — rate limits, 5xx, network, and plain permission/scoping
// (including a bare code 100 with no bad-object subcode) — is treated as
// transient/non-fatal so a valid-but-unlistable WABA is never rejected at
// connect (AC13 / A5).
export function isNotAWabaError(
  httpStatus: number,
  err:
    | { code?: number; type?: string; error_subcode?: number; message?: string }
    | undefined,
): boolean {
  // 5xx / 429 / network (non-400 unless the capture step records otherwise)
  // -> transient, never fatal.
  if (httpStatus !== 400) return false;
  if (!err) return true; // 400 with no parseable error object -> treat as bad id

  // (1) Unsupported get on a non-WABA object class. Graph returns
  //     type "GraphMethodException" when /{id}/phone_numbers is not a valid
  //     edge for the object's class — the hallmark of a non-WABA id.
  if (err.type === "GraphMethodException") return true;

  // (2) Nonexistent / unreachable object: code 100 WITH error_subcode 33
  //     ("Object does not exist, cannot be loaded due to missing permission,
  //     or does not support this operation"). The subcode is what distinguishes
  //     a bad object from a plain scoping error that also uses code 100.
  if (err.code === 100 && err.error_subcode === 33) return true;

  // (3) Alias/object-not-found.
  if (err.code === 803) return true;

  // Everything else at 400 — notably a BARE code 100 with no error_subcode 33
  // (generic permission/edge-scoping on a possibly-valid WABA), code 10 /
  // 200-299 (permission), code 190 (token) — stays NON-fatal.
  return false;
}
```

Why this satisfies both ACs:

- **AC12 (reject `989050294147122`).** A messaging-account id does not expose the
  `phone_numbers` edge, so Meta returns one of the fatal shapes above
  (`GraphMethodException`, or `code 100`+`error_subcode 33`, or `803`), and even
  a bare 400 with no parseable error object is caught by the `!err` fallback. The
  §6 step-0 capture confirms which shape and, if the status is not 400, widens
  the first guard accordingly. The design must **show, not assume**, the known id
  is classified not-a-WABA — hence the blocking capture step.
- **AC13 / A5 (keep valid-but-unlistable non-fatal).** A real WABA whose token
  merely lacks `whatsapp_business_management` returns a **bare** `code 100`
  (no `error_subcode 33`) or a `code 10`/200-series permission error — none of
  which match the fatal set — so it stays non-fatal and the connect proceeds.
  5xx/429/network are non-400 and short-circuit to non-fatal immediately.

Interaction with §2: because sync now imports **only on a positive owned-phone
match**, the correctness of the §2 leak-block does **not** depend on
`isNotAWabaError` catching `989050294147122` — even if the classifier returned
`false` for it, §2 would still SKIP it as `probe-unverifiable` or `foreign-waba`
and never import. The classifier matters for the §3 **connect** rejection (AC12)
and to give the cleaner `not-a-waba` skip reason at sync. This removes the
circular dependency MEDIUM-2 flagged: §2's isolation guarantee stands on the
positive match alone.

### Precise branch rewrite (`numbers/manual/route.ts`)

Replace the current `if (phonesRes.ok) { ... } else { console.warn(...) }` with:

```ts
if (phonesRes.ok) {
  const list: Array<{ id?: string }> = phonesData?.data ?? [];
  const present = list.some((p) => p.id === phoneNumberId);
  if (!present) {
    // (b) list OK and phone absent -> fatal, nothing saved (UNCHANGED)
    return NextResponse.json(
      { error: "This phone number is not under the provided WhatsApp Business Account" },
      { status: 400 },
    );
  }
  // (a) list OK and present -> proceed (UNCHANGED)
} else if (isNotAWabaError(phonesRes.status, phonesData?.error)) {
  // (c-fatal) the id is not a WABA -> reject before any DB write (AC12)
  return NextResponse.json(
    { error: "Invalid WhatsApp Business Account ID" },
    { status: 400 },
  );
} else {
  // (c-nonfatal) transient / permission / unlistable -> proceed (AC13, UNCHANGED intent)
  console.warn(
    `[ManualConnect] Could not list phone numbers for waba ${wabaId} (non-fatal): ${phonesRes.status}`,
  );
}
```

No token or ciphertext is logged in any branch (AC15, NFR2). No DB write occurs
on the fatal branch because it returns before `upsertNumberForUser` (AC12 "no DB
write"). The health check (step 1), the "phone absent" rejection (branch b,
AC14), and the non-fatal `subscribed_apps` call are unchanged.

### Validation rules for the external inputs (manual connect)

Input validation is unchanged (`bodySchema` zod): `wabaId` string 1–100,
`phoneNumberId` string 1–100, `accessToken` string 10–5000, `label` optional.
The new behavior is purely in how the **downstream Graph response** is
classified. Behavior on failure: fatal → 400 with the fixed message
`Invalid WhatsApp Business Account ID`; transient → proceed (persist) exactly as
today.

### Testability

`isNotAWabaError` is a pure function → unit tests over representative Graph
error objects: `{type:"GraphMethodException"}`@400 → true; `{code:100,
error_subcode:33}`@400 → true; `{code:803}`@400 → true; `undefined`@400 → true;
`{code:100}`@400 (bare) → **false**; `{code:10}`@400 → false; `{code:190}`@400 →
false; any error @500/@429 → false. Handler-level: mock `fetch` so the WABA read
returns a fatal shape → expect 400 and **no** `upsertNumberForUser` call; return
500/network → expect 201 persisted.

---

## 4. Cleanup script design

New file: `scripts/cleanup-leaked-templates.mjs`, modeled exactly on
`scripts/add-tenant-meta-app-table.mjs` (manual `.env` parse → `createClient`
with `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` → try/catch → non-secret error →
`process.exit(1)` → `client.close()` in `finally`). No Prisma, no `db push`
(NFR3, AC21, AC22).

**Safety envelope (MEDIUM-2 of prior review):** this script touches **only** the
`Template` table and reads only `id`, `userId`, `name`, `metaTemplateId`. It
never reads or writes `WhatsAppNumber` and never touches any column carrying
ciphertext, so no `accessToken` can ever surface in its output or error prints.
The Surshyam bad-WABA `WhatsAppNumber` mutation lives in a **separate** script
(§5), keeping this guarantee intact.

### Hard-coded tenant ids (per Out of Scope — targets only this known pair)

```js
const SURSHYAM = "cmv321v6j0000hjwlr4cxp7w5"; // leaked-into tenant
const UTKRANTI  = "cmn1cinmh0000jmdn4fs17kn1"; // true owner — never touched
```

### Exact selection predicate

A Surshyam row is **leaked** iff its `metaTemplateId` is non-null **and** the
same `metaTemplateId` exists on at least one row under a **different** `userId`
(specifically Utkranti). Expressed as a parameterized `@libsql/client` query:

```sql
SELECT t.id, t.userId, t.name, t.metaTemplateId
FROM Template t
WHERE t.userId = ?                         -- SURSHYAM
  AND t.metaTemplateId IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM Template o
    WHERE o.metaTemplateId = t.metaTemplateId
      AND o.userId = ?                     -- UTKRANTI (a DIFFERENT userId)
  );
```
args: `[SURSHYAM, UTKRANTI]`.

Why this is safe (reviewer checklist):

- **Never touches Utkranti rows** — the outer filter is `t.userId = SURSHYAM`;
  the Utkranti match is only in a read-only `EXISTS` subquery (AC17/AC18).
- **Never deletes name-only local drafts** — `t.metaTemplateId IS NOT NULL`
  plus the `metaTemplateId` equality in `EXISTS` means a Surshyam draft with a
  null or distinct `metaTemplateId` can never match, even if it shares a `name`
  (AC19, A3).
- **Idempotent** — after the first delete, no Surshyam row satisfies the
  predicate, so the second run selects 0 rows and deletes nothing (AC20).
- **Dry-run first** — the script runs the SELECT and prints every candidate
  (id, userId, name, metaTemplateId) before any mutation (AC16).

### Dry-run vs real run

Default = **dry run** (report only). The real delete runs only when invoked with
an explicit `--apply` flag:

```js
const APPLY = process.argv.includes("--apply");
```

Delete step (only when `APPLY`), scoped by the exact same predicate so it cannot
drift from the dry-run selection:

```sql
DELETE FROM Template
WHERE userId = ?
  AND metaTemplateId IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM Template o
    WHERE o.metaTemplateId = Template.metaTemplateId
      AND o.userId = ?
  );
```
args: `[SURSHYAM, UTKRANTI]`. The script prints `result.rowsAffected`.

### Before/after verification queries (printed by the script)

```sql
-- Surshyam total templates
SELECT COUNT(*) FROM Template WHERE userId = 'cmv321v6j0000hjwlr4cxp7w5';
-- Surshyam leaked candidates (should be N before, 0 after)
SELECT COUNT(*) FROM Template
  WHERE userId = 'cmv321v6j0000hjwlr4cxp7w5'
    AND metaTemplateId IS NOT NULL
    AND EXISTS (SELECT 1 FROM Template o
                WHERE o.metaTemplateId = Template.metaTemplateId
                  AND o.userId = 'cmn1cinmh0000jmdn4fs17kn1');
-- Utkranti total (MUST stay 7 before and after)
SELECT COUNT(*) FROM Template WHERE userId = 'cmn1cinmh0000jmdn4fs17kn1';
```

Expected: Surshyam leaked-count = 7 before, 0 after; Utkranti count = 7
unchanged. The script prints all three counts in both the dry-run and the
post-apply phase so a reviewer sees Utkranti=7 is invariant.

### Error handling (script)

Any thrown error → `console.error("Cleanup failed:", err)` (a libSQL/driver
error, never a secret) → `process.exit(1)`; `client.close()` in `finally`
(AC21). The non-secret guarantee holds unconditionally because the script reads
only `Template` ids/names/metaIds and never `WhatsAppNumber`/ciphertext.

### Testability

The predicate is a single SQL statement verifiable by running the dry-run
against the live DB and reading the printed candidate list before applying.
Idempotency is verified by a second dry-run showing 0 candidates after apply.

---

## 5. Surshyam bad-WABA row decision — separate script

**Decision: FLAG by clearing the connection's WABA binding, in a SEPARATE
sibling script, do not guess a replacement.**

The row `WhatsAppNumber(phoneNumber=919720996300, wabaId=989050294147122)` holds
a provably invalid WABA id. Leaving it `verified` with a bad `wabaId` means every
future sync re-skips it (harmless after §2, which SKIPs it) but the tenant has no
signal to reconnect, and the stale `verified` status is misleading.

New file: `scripts/flag-surshyam-bad-waba.mjs`, same mechanics as the cleanup
script (manual `.env` parse, `createClient`, try/catch → `process.exit(1)` →
`client.close()` in `finally`, default dry-run, `--apply` to mutate). It is a
**separate** script from §4 precisely so the Template cleanup keeps its
"no `WhatsAppNumber`, no ciphertext" safety envelope.

**Dry-run SELECT (AC16) — explicitly excludes `accessToken`:**

```sql
SELECT id, phoneNumber, wabaId, verificationStatus
FROM WhatsAppNumber
WHERE userId = 'cmv321v6j0000hjwlr4cxp7w5'
  AND wabaId = '989050294147122';
```

The script prints only these four columns. It MUST NOT `SELECT *` and MUST NOT
print the full row, so `accessToken` ciphertext can never appear in output. Any
error print uses a fixed non-secret message (`"Flag bad-WABA failed:"` + the
driver error), never the row.

**Mutation (only when `--apply`):**

```sql
UPDATE WhatsAppNumber
SET wabaId = NULL,
    verificationStatus = 'pending'
WHERE userId = 'cmv321v6j0000hjwlr4cxp7w5'
  AND wabaId = '989050294147122';
```

Rationale:
- Setting `wabaId = NULL` removes the invalid id without inventing a correct one
  (A4/AC24 — the correct WABA is unknown; the number is Pending on Meta).
- `verificationStatus = 'pending'` drops it out of the sync `findMany`
  (which requires `wabaId: { not: null }` and `verified`), so it cannot
  participate in any sync until the tenant reconnects with a real WABA via the
  now-hardened manual-connect path (§3). This satisfies AC23 ("clear or flag so
  the tenant reconnects") beyond the documentation minimum.
- It is reversible and non-destructive — no row deleted, token ciphertext left
  intact in case the tenant re-verifies the same number. The ciphertext is never
  read by the script.

**Idempotency (NIT-3):** the mutation sets `wabaId = NULL`, and both the dry-run
SELECT and the UPDATE key on `wabaId = '989050294147122'`. After a successful
first `--apply`, that `wabaId` is `NULL`, so a second run's `WHERE wabaId =
'989050294147122'` matches **0 rows** — the SELECT prints nothing and the UPDATE
reports `rowsAffected = 0`. The script is therefore safe to re-run (mirrors §4's
idempotency property).

The scoping `WHERE userId = '<SURSHYAM>' AND wabaId = '989050294147122'` touches
exactly the one known bad row; no other number can match.

---

## 6. Verification plan

0. **MEDIUM-1 capture (design-closing prerequisite — do this FIRST):** run the
   one-off `GET https://graph.facebook.com/v19.0/989050294147122/phone_numbers`
   with Surshyam's stored token (or a one-time non-secret body log in
   manual-connect branch (c)), record the observed HTTP status +
   `code`/`type`/`error_subcode` in §3's capture box, and confirm the committed
   `isNotAWabaError` returns `true` for that exact shape. If the status is not
   400, widen the classifier to that status for the bad-object signals (never a
   bare `code 100`). This blocks ship.
1. **Build gate:** `npm run build` (= `prisma generate && next build`) MUST pass
   with the edited `sync/route.ts`, `numbers/manual/route.ts`, and
   `src/lib/whatsapp.ts` (new `isNotAWabaError` export). TypeScript must compile
   with no new errors.
2. **Run order (MEDIUM-2):** execute §4 cleanup → §5 flag → then deploy §2/§3.
3. **Cleanup dry run:** `node scripts/cleanup-leaked-templates.mjs` → prints 7
   Surshyam leaked candidates, Utkranti count = 7, deletes nothing.
4. **Cleanup real run:** `node scripts/cleanup-leaked-templates.mjs --apply` →
   deletes 7, prints Surshyam leaked-count 0 after, Utkranti count still 7.
5. **Cleanup idempotency:** re-run `--apply` → selects 0, deletes 0 (clean
   no-op, AC20).
6. **Flag dry run / apply / idempotency:**
   `node scripts/flag-surshyam-bad-waba.mjs` prints the one row (id,
   phoneNumber, wabaId, verificationStatus — no token); `--apply` sets
   `wabaId=NULL, verificationStatus='pending'`; a second `--apply` matches 0 rows
   (idempotent) and prints no ciphertext in any run.
7. **Isolation re-check:** `GET /api/templates` as Surshyam returns only
   Surshyam-owned rows (leaked ones gone); as Utkranti returns the same 7.
   Confirm the handler is still `userId`-scoped (unchanged, AC8).
8. **Connect regression (manual):** mock/replay a connect with a non-WABA id →
   400 "Invalid WhatsApp Business Account ID", no `WhatsAppNumber` row written;
   a connect with a valid WABA still succeeds (201); a transient/permission probe
   failure still succeeds (201).
9. **Sync regression (HIGH-1 non-releak):** (a) a sync whose only number resolves
   to an unowned/foreign WABA (`ok` + no owned-phone match) imports 0 rows,
   returns 200 with `skippedWabas` reason `foreign-waba` (AC5); (b) a sync whose
   probe returns a transient 500/429/network error imports 0 rows, returns 200
   with reason `probe-unverifiable` (the previous revision would have re-imported
   here — this is the leak this revision closes); (c) a sync whose probe returns
   the not-a-WABA signal imports 0 rows, reason `not-a-waba`; (d) a sync with a
   genuinely owned WABA whose probe lists the owned `phoneNumberId` imports with
   non-null `whatsappNumberId` (AC2) and no `skippedWabas` entry.
10. **Scratchpad:** the implementation step MUST update `scratchpad.md` with a
    dated change-log entry covering the new `isNotAWabaError` export, the sync
    positive-match ownership gate + `skippedWabas` field, the manual-connect
    branch split, and the two new scripts.

Clean up any temporary verification scripts/files and remove any temporary
error-body logging added for step 0.

---

## 7. What must NOT change

- **Status mapping** — `mapMetaStatus` and its APPROVED/ACTIVE→approved,
  PENDING/IN_REVIEW/IN_APPEAL/PENDING_DELETION→submitted,
  REJECTED/PAUSED/DISABLED/FLAGGED→rejected logic (AC7).
- **Local name de-duplication** — the `seenNames` / `duplicateIds` dedupe and
  `duplicatesRemoved` count in sync, and the existing `existingMetaIds`
  `.filter(Boolean)` set (AC7).
- **The `message_templates` fetch auth mode** — stays `&access_token=` query
  param; only the new ownership probe uses `Authorization: Bearer` (MEDIUM-1).
- **Per-tenant WABA resolution for submit/delete** — the precedence
  `explicit numberId → template binding → sole number` in
  `templates/[id]/submit/route.ts` (and the matching delete handler) is
  untouched (AC25, FR6).
- **The `#131008` send fix** — no change to the send path (FR6, AC26).
- **Credits accounting** — untouched (FR6, AC26).
- **Superadmin behavior** — untouched (FR6, AC26).
- **`resolveWabaCredentials` / `@/lib/crypto`** — all Graph credential
  resolution continues through these; the `resolveWabaCredentials(number)`
  full-row call is kept as-is (structural typing — NIT-2); no env fallback is
  introduced (NFR2).
- **`GET /api/templates`** — remains `userId`-scoped, unchanged (AC8).
- **Core response shape of sync** — `{ synced, updated, imported,
  duplicatesRemoved }` preserved; `skippedWabas` is additive only (AC7).
- **`Template` / `WhatsAppNumber` schema** — no new column; `whatsappNumberId`
  stays optional in the model, enforced non-null only by the import/update code
  paths (Out of Scope).
- **Run-order independence of §2** — the sync gate enforces isolation by positive
  owned-phone match alone; it does NOT assume §4/§5 have run or that any
  `WhatsAppNumber` row is clean (MEDIUM-2).

---

## Design decisions summary

- **Guard scheme (chosen):** Option B — at sync time, probe each `wabaId` via
  `GET /{wabaId}/phone_numbers` (`Authorization: Bearer`) and **IMPORT only on a
  positive owned-phone match** (the `ok` probe lists the `phoneNumberId` stored
  on the number that carried that `wabaId`). SKIP on every other outcome
  (`foreign-waba`, `not-a-waba`, `probe-unverifiable`), each surfaced in
  `skippedWabas`. No trust fallback. Plus a defensive
  `if (!meta.__sourceNumberId) continue;` at both write sites. No schema change.
- **Not-a-WABA signal:** HTTP 400 (or the status captured for `989050294147122`
  if different) AND (`type GraphMethodException` OR `code 100` WITH
  `error_subcode 33` OR `code 803` OR no parseable error object). A bare
  `code 100`, permission codes (10/200-series), token `code 190`, and all
  5xx/429/network stay non-fatal. Shared pure helper `isNotAWabaError` used by
  manual-connect (reject → 400) and sync (skip reason `not-a-waba`). The error
  body for `989050294147122` is captured once as a design-closing prerequisite
  (§6 step 0). Note: §2's leak-block does not depend on this classifier — a
  positive match is required to import regardless.
- **Cleanup predicate:** delete `Template` rows where
  `userId = cmv321v6j0000hjwlr4cxp7w5` AND `metaTemplateId IS NOT NULL` AND that
  `metaTemplateId` also exists under `userId = cmn1cinmh0000jmdn4fs17kn1`;
  dry-run by default, `--apply` to delete, idempotent, Utkranti rows never
  touched, `Template`-only (no ciphertext).
- **Surshyam bad-WABA row:** a SEPARATE script clears `wabaId` → NULL and sets
  `verificationStatus = 'pending'` (reversible flag, no guessed id), idempotent,
  with a four-column dry-run SELECT that never reads `accessToken`.
- **Run order:** §4 cleanup → §5 flag → deploy §2/§3; §2 is correct independently
  of this order.

---

## Review responses (iso-design-review.md rev 2)

- **HIGH-1 — RESOLVED.** The two "trust stored `wabaId`" IMPORT branches
  (decision-table rows 4 and 5 of the prior revision) are removed. §2 now imports
  **only** on a live `ok` probe whose returned phone list contains the
  `phoneNumberId` stored on the number carrying the probed `wabaId`. A stored
  `wabaId` that has never been positively matched is NEVER imported on a
  non-`ok`/foreign/unevaluable probe — stated explicitly in §2's invariant box
  and decision table. This closes the re-leak path for the pre-existing
  `989050294147122` under transient/permission/5xx/network conditions. The FR6
  tolerance tradeoff (under-scoped tokens now import nothing until they can list
  their own phones, surfaced via `skippedWabas` reason `probe-unverifiable`) is
  acknowledged in the new "FR6 / AC7 tolerance tradeoff" subsection. This adopts
  review HIGH-1 **option 1** (positive-only gate); option 2 was declined because
  it requires a `wabaOwnershipVerifiedAt` schema stamp, which the requirements
  place Out of Scope.
- **MEDIUM-1 — RESOLVED.** The `989050294147122` error-body capture is promoted
  to a design-closing prerequisite (§3 capture box + §6 step 0): the implementer
  must run the one-off probe, record the observed status + code/type/subcode, and
  confirm the committed classifier returns `true` for that exact shape, widening
  to the observed status (never a bare `code 100`) if it is not 400. §2
  additionally no longer depends on the classifier for its leak-block (positive
  match is required to import), so even a classifier miss cannot cause a re-leak.
- **MEDIUM-2 — RESOLVED.** An explicit required run order (§4 → §5 → §2/§3) is
  added to the Overview, §6, and §7. The circular "trust stored `wabaId`" safety
  language is removed; §2 states it enforces isolation independently and assumes
  no `WhatsAppNumber` row is clean. The §2↔§3 dependency is explicitly broken:
  §2 relies on positive ownership proof, not on §3's rejection or §5's clearing.
- **NIT-1 — ADOPTED.** `wabaMap` now carries the source number's `phoneNumberId`,
  and the ownership match checks the probed WABA's phone list for *that* phone id
  (branch-(a) semantics) rather than any tenant phone id.
- **NIT-2 — ACKNOWLEDGED.** §1 and §7 note the `resolveWabaCredentials(number)`
  full-row call is intentional (structural typing); the implementer must not
  narrow it.
- **NIT-3 — ADOPTED.** §5 now states its idempotency reason inline (after apply
  `wabaId` is NULL so the `WHERE wabaId = '989050294147122'` predicate matches 0
  rows), mirroring §4.
