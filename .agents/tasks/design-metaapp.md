# Design — Bring-Your-Own Meta App (Model B) with shared-app fallback (Model A)

## Overview

This feature lets each tenant optionally supply their **own** Meta app (App ID, App Secret, Embedded Signup Config ID) so their WhatsApp onboarding, OAuth code exchange, and inbound-webhook signature verification run under *their* app instead of the platform's single shared app. When a tenant has not supplied their own app, every path falls back to the platform's env-level app — i.e. today's exact behavior. The rule is **per-tenant overrides platform; platform env is the default**, and a tenant with no own-app row must be byte-for-byte unchanged from today (no regression).

The work breaks into four grounded pieces, all built on existing infrastructure (`src/lib/crypto.ts`, `src/lib/db.ts`, `src/lib/whatsapp.ts`, `getServerSession(authOptions)`):

1. A new `TenantMetaApp` Prisma model + an idempotent `@libsql/client` migration script (because `prisma db push` is rejected over `libsql://`).
2. A new shared resolver `resolveMetaAppCredentials(userId)` in a new `src/lib/meta-app.ts`.
3. Rewiring `POST /api/numbers/embedded-signup` and `POST /api/webhooks/whatsapp` to use the resolver (the webhook using a bounded candidate-secret set to stay fail-closed).
4. A new `/api/meta-app` CRUD route, a new `/dashboard/settings` UI, and a runtime effective-config fetch on the connect page replacing the build-time `NEXT_PUBLIC_*` reads.

**Technology stack (locked):** Next.js 14 App Router, TypeScript, Prisma 5.x with `@prisma/adapter-libsql` over Turso/libSQL, next-auth v4 (`getServerSession`), `zod` for input validation, Node `crypto` (AES-256-GCM via `src/lib/crypto.ts`) and `fetch`. No new runtime dependency is introduced; the per-tenant app credentials live in the DB, encrypted. Graph API base stays `https://graph.facebook.com/v19.0`.

---

## 1. Schema — `TenantMetaApp`

### Prisma model

Add to `prisma/schema.prisma`. The model follows the per-tenant one-row convention of `UserCredits` (cuid id, `userId @unique`, `onDelete: Cascade`) and the full timestamp pair of `WhatsAppNumber` (`createdAt` + `updatedAt`). (Note, verified: `UserCredits` itself has only `updatedAt`, no `createdAt`; `WhatsAppNumber` has both. `TenantMetaApp` intentionally carries both, matching `WhatsAppNumber`.)

```prisma
model TenantMetaApp {
  id            String   @id @default(cuid())
  userId        String   @unique
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  metaAppId     String   // plaintext — Meta App ID is not a secret
  metaAppSecret String   // AES-256-GCM ciphertext at rest — never plaintext, never logged, never returned
  configId      String?  // optional Embedded Signup Configuration ID — not a secret
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

And the back-relation on `User` (added alongside the existing relations such as `credits UserCredits?`):

```prisma
  tenantMetaApp TenantMetaApp?
```

Column choices grounded in the model: `metaAppId` and `configId` are identifiers Meta exposes publicly in the client (the connect page already ships `NEXT_PUBLIC_META_APP_ID`/`NEXT_PUBLIC_META_CONFIG_ID` to the browser), so they are stored plaintext. `metaAppSecret` is the only secret and is stored exactly like `WhatsAppNumber.accessToken` — AES-256-GCM ciphertext from `encrypt()`. `userId @unique` enforces one-app-per-tenant (matching the Out-of-Scope "multiple Meta apps per tenant" exclusion). `onDelete: Cascade` matches every other `User`-owned model so deleting a tenant through Prisma drops their app row; this cascade is enforced by the Prisma client (see the migration-script subsection — the hand-written SQLite table deliberately omits a DB-level FK because libSQL does not enforce FKs without `PRAGMA foreign_keys = ON`, matching how every existing table was created).

### Migration script (idempotent, `@libsql/client`)

`prisma db push` cannot connect over `libsql://` (P1012), so the table is created on live Turso by a new script `scripts/add-tenant-meta-app-table.mjs`.

**What the script reuses from the proven pattern (`scripts/add-meta-onboarding-columns.mjs`) vs. what is net-new (and why).** Verified against the repo: `add-meta-onboarding-columns.mjs` (and every other `scripts/*.mjs`) does only `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN`. A grep across `scripts/**/*.mjs` finds **no** `CREATE TABLE`, **no** `FOREIGN KEY`, and **no** `DEFAULT CURRENT_TIMESTAMP` anywhere — the existing tables were all created by Prisma, not by these scripts. So this script reuses the *mechanics* of the proven pattern (manual `.env` parse with the same regex, `createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })`, try/catch → non-secret error → `process.exit(1)`, `client.close()` in `finally`, run via `node scripts/add-tenant-meta-app-table.mjs` with no npm script) but necessarily introduces `CREATE TABLE IF NOT EXISTS` because it creates a whole table rather than adding columns. That is new territory for the repo, so the two SQLite-specific constructs the review flagged are decided explicitly below rather than claimed to "mirror the pattern."

**Decision: no `FOREIGN KEY` clause, columns `TEXT`, no `DEFAULT CURRENT_TIMESTAMP`.** Rationale, grounded in how libSQL/SQLite and Prisma actually behave here:

- **FK dropped.** SQLite/libSQL does not enforce foreign keys unless `PRAGMA foreign_keys = ON` is set per connection, and the proven script never sets it. The existing `User`-owned tables were made by Prisma and we have no evidence the live DB enforces FKs at the row level at all. A hand-written `FOREIGN KEY ... ON DELETE CASCADE` would therefore be **decorative** — not actually enforced — and would diverge from how every other table in this DB was created. The `onDelete: Cascade` guarantee the feature relies on is **Prisma's**, declared in `schema.prisma` and emulated by the Prisma client when a `User` is deleted through a Prisma relation. Verified the app deletes users only through Prisma (no raw user-delete script exists in `scripts/`), so the Prisma-level cascade is the real enforcement and the DB-level FK is unnecessary. Dropping it keeps the DDL honest and consistent with the proven script. (Trade-off: a `User` row deleted by raw SQL outside Prisma would orphan a `TenantMetaApp` row. That path does not exist in this codebase; if one is ever added it must go through Prisma, same as every other `User`-owned table today.)
- **Timestamps as plain `TEXT`, no SQL default.** Every write goes through the Prisma client, which supplies `@default(now())` / `@updatedAt` itself; the raw script never inserts rows. A SQLite `DEFAULT CURRENT_TIMESTAMP` would be unverified territory (its `YYYY-MM-DD HH:MM:SS` text may not round-trip identically through the libSQL adapter's `DateTime` decoding for a hypothetical non-Prisma insert), and since no such insert exists it buys nothing. Declaring the columns `TEXT` (SQLite has no native `DATETIME` affinity anyway — `DATETIME` is just `NUMERIC`/`TEXT` affinity) with no default keeps the table minimal and avoids relying on an unverified adapter behavior. Prisma reads/writes these columns through the client exclusively.

Exact DDL the script executes:

```sql
CREATE TABLE IF NOT EXISTS TenantMetaApp (
  id            TEXT PRIMARY KEY NOT NULL,
  userId        TEXT NOT NULL,
  metaAppId     TEXT NOT NULL,
  metaAppSecret TEXT NOT NULL,
  configId      TEXT,
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);
```

Followed by the unique constraint on `userId` (SQLite expresses Prisma's `@unique` as a unique index; `IF NOT EXISTS` keeps the second run a no-op):

```sql
CREATE UNIQUE INDEX IF NOT EXISTS TenantMetaApp_userId_key ON TenantMetaApp (userId);
```

Notes grounded in the codebase:
- The index name `TenantMetaApp_userId_key` matches Prisma's own naming convention (`<Model>_<field>_key`) for the `sqlite` provider (confirmed `datasource` is `provider = "sqlite"`), so the live schema and the generated Prisma client agree on the unique-index name.
- `createdAt`/`updatedAt` are `TEXT NOT NULL` with **no** SQL default — Prisma supplies both values on every write (`@default(now())` and `@updatedAt`), and the raw script never inserts rows, so a DB-side default would never fire. This matches the "all writes go through Prisma" reality rather than inventing an unverified SQL default.
- `id` is `TEXT PRIMARY KEY` with the value supplied by Prisma's `cuid()` on insert — no autoincrement, matching every other table.
- The script logs only table/index creation status (`"TenantMetaApp table created."` / `"TenantMetaApp table already exists. Skipping."`), never any row data.

**Edge case:** a second run must be a clean no-op. `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` guarantee that. The script wraps execution in try/catch, logs a non-secret error, and `process.exit(1)` on failure, exactly like the existing migration. (To report "created" vs. "already exists" the script may first `PRAGMA table_info(TenantMetaApp)` and branch the log line, mirroring the existing script's "already exists. Skipping." messaging; the `IF NOT EXISTS` DDL is the actual idempotency guarantee regardless.)

**On the Prisma `onDelete: Cascade` vs. the hand-written table.** The Prisma model keeps `onDelete: Cascade` (the generated client enforces it on `User` deletes through Prisma, as it does for every other `User`-owned model). The hand-written DDL deliberately omits the DB-level FK, as decided above; the two are not in conflict because enforcement lives at the Prisma layer, not the SQLite layer, consistent with the rest of this database.

After the schema edit, `prisma generate && next build` regenerates the client exposing `prisma.tenantMetaApp`.

---

## 2. Resolver — `resolveMetaAppCredentials(userId)`

### Location

New module `src/lib/meta-app.ts` (not appended to `src/lib/whatsapp.ts`). Rationale: `whatsapp.ts` is about per-*number* send/WABA credential resolution and number upserts; the Meta-*app* resolver is a distinct concern consumed by three unrelated call sites (embedded-signup, webhook, settings API). A dedicated module keeps the single source of truth obvious and avoids coupling the app-identity logic to number plumbing. It imports `prisma` from `@/lib/db` and `decrypt` from `@/lib/crypto`, matching how `whatsapp.ts` is structured.

### Contract

```ts
export interface ResolvedMetaApp {
  appId: string;
  appSecret: string;
  // configId is INFORMATIONAL: consumed only by GET /api/meta-app and the
  // connect page (to drive the FB SDK). It is NOT used by the server-side
  // OAuth code exchange in embedded-signup. On the platform branch it comes
  // from NEXT_PUBLIC_META_CONFIG_ID, which — despite the NEXT_PUBLIC_ prefix —
  // is a plain env var readable server-side; reading it here is deliberate,
  // not a client-only var misused on the server.
  configId: string | null;
  source: "tenant" | "platform";
}

export class MetaAppConfigError extends Error {
  constructor(message = "Meta app is not configured") {
    super(message);
    this.name = "MetaAppConfigError";
  }
}

export async function resolveMetaAppCredentials(
  userId: string,
): Promise<ResolvedMetaApp>;
```

### Precedence and behavior

1. `const row = await prisma.tenantMetaApp.findUnique({ where: { userId } })`.
2. **Tenant branch** — if `row` exists:
   - Decrypt the secret inside a try/catch: `let appSecret; try { appSecret = decrypt(row.metaAppSecret); } catch { throw new MetaAppConfigError("Tenant Meta app credentials are invalid"); }`. The caught `decrypt()` error object is **not** rethrown and **not** logged; only the generic `MetaAppConfigError` propagates, so neither the ciphertext nor the Node crypto error (which could echo buffer contents) ever surfaces. `row.metaAppId` is non-null (NOT NULL column), so no missing-id guard is needed here.
   - Return `{ appId: row.metaAppId, appSecret, configId: row.configId ?? null, source: "tenant" }`.
3. **Platform branch** — if no `row`:
   - `const appId = process.env.META_APP_ID; const appSecret = process.env.META_APP_SECRET;`
   - If either is falsy, `throw new MetaAppConfigError("Server is not configured for Embedded Signup")` — the same message string the embedded-signup route already returns, so the existing 500 copy is preserved.
   - `configId` comes from `process.env.NEXT_PUBLIC_META_CONFIG_ID ?? null` (the only place the platform config id exists today; it is readable server-side as a plain env var even though it is `NEXT_PUBLIC_`).
   - Return `{ appId, appSecret, configId, source: "platform" }`.

The resolver never logs. The only error type it throws is `MetaAppConfigError`; callers map it to their existing error responses. Any other unexpected throw (e.g. a DB connectivity error from `findUnique`) is left to propagate to the caller's existing top-level try/catch, which already returns a generic 500 without leaking internals.

**Ciphertext stays local to the resolver (resolves review Finding 3 — NIT).** The `findUnique` has no `select`, so `row` carries the `metaAppSecret` ciphertext into memory. That `row` object — including the ciphertext — **stays local to `resolveMetaAppCredentials`**: only the decrypted value is returned (inside `appSecret`), the ciphertext is never placed on the returned object, never returned to a caller, and never logged (no `console.*` touches `row` on any branch). This mirrors the `serializeNumber` guarantee in `whatsapp.ts`, which strips `accessToken` so the ciphertext never leaves the function. On a `decrypt()` throw, the caught error (which could echo buffer/ciphertext contents) is discarded and only the generic `MetaAppConfigError` propagates, so the ciphertext does not leak via an error path either.

### Error-handling table (resolver)

| Condition | Classification | Caller receives | Logged? |
|---|---|---|---|
| Tenant row, `decrypt()` throws (bad key / tampered ciphertext) | Recoverable credential error | `MetaAppConfigError` (generic message, no secret/ciphertext) | No |
| No tenant row, `META_APP_ID`/`META_APP_SECRET` missing | Recoverable credential error | `MetaAppConfigError("Server is not configured for Embedded Signup")` | No |
| `prisma.tenantMetaApp.findUnique` throws (DB error) | Fatal (unexpected) | Propagates to caller's try/catch → generic 500 | By caller only, no secret |

### Testability

Pure-ish and unit-testable by seeding/omitting a `TenantMetaApp` row and toggling env vars: assert `source`, assert the tenant branch decrypts, assert a tampered secret yields `MetaAppConfigError` with no secret in the message, assert missing platform env yields the config error. No network. This is the primary unit-test target of the feature.

---

## 3. Embedded Signup rewiring — `POST /api/numbers/embedded-signup`

Replace the direct env reads:

```ts
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
if (!appId || !appSecret) { ...500... }
```

with:

```ts
import { resolveMetaAppCredentials, MetaAppConfigError } from "@/lib/meta-app";
// ...after the session guard and body parse...
let appId: string, appSecret: string;
try {
  ({ appId, appSecret } = await resolveMetaAppCredentials(session.user.id));
} catch (e) {
  if (e instanceof MetaAppConfigError) {
    return NextResponse.json(
      { error: "Server is not configured for Embedded Signup" },
      { status: 500 },
    );
  }
  throw e; // falls through to the route's existing catch → generic 500
}
```

Everything downstream (the `${GRAPH}/oauth/access_token` exchange using `appId`/`appSecret`, `debug_token`, `/phone_numbers`, health fetch, `subscribed_apps`, `/register`, `normalizePhone`, `encrypt(businessToken)`, `upsertNumberForUser`, `serializeNumber`, the 201/400/409/401/500 branches, `NumberOwnedByOtherTenantError`) is **unchanged**. A tenant with a `TenantMetaApp` row exchanges the code against their app; a tenant without one hits the platform branch and behaves exactly as today. The `MetaAppConfigError` message is deliberately the same string the route emits today so the client-facing copy does not change.

**Edge case:** a tenant whose stored secret is undecryptable gets the clean 500 "not configured" rather than a crash, and no secret is logged. This is the same user-visible outcome as a platform misconfiguration, which is acceptable (both mean "can't start the OAuth exchange").

**Testability:** integration-tested by mocking `fetch` for the Graph calls and seeding/omitting a `TenantMetaApp` row; assert which `client_id` is sent in the token URL. The resolver call itself is unit-tested separately.

---

## 4. Per-app webhook signature verification — `POST /api/webhooks/whatsapp`

This is the subtle part. Meta signs the webhook body with the **app secret of the app subscribed to that WABA**. In Model B, different tenants' events are signed with different secrets. Signature verification must happen *before* the body is trusted, yet the body's `phone_number_id` is what tells us which tenant (hence which secret) to use. That is the chicken-and-egg.

### Resolution: bounded candidate-secret set, parse-for-routing-only, fail-closed

The design keeps the GET handshake and all POST routing/storage logic intact, and changes **only** how the signature is verified. The step order below is **load-bearing and must be implemented exactly as ordered**: the cheap, no-DB rejections (missing/malformed signature header) happen *before* any body parse or DB query, so a request without a well-formed signature never costs a DB round-trip (closing the pre-auth DB-amplification vector the review flagged). New flow for `POST`:

1. **Read the raw body exactly once:** `const raw = await request.text();` (unchanged — the HMAC must be over the exact signed bytes, and the body stream can only be read once). No parsing yet.

2. **Signature-header gate — before any parse or DB work.** Require `x-hub-signature-256` starting with `sha256=`; if missing/malformed, `console.warn("[Webhook] Missing or malformed X-Hub-Signature-256")` and return `401` **immediately** — no `JSON.parse`, no `prisma` query runs for such a request. Keep `const theirHex = signatureHeader.slice("sha256=".length);` and `const a = Buffer.from(theirHex, "hex");`. This preserves today's cheap rejection for unauthenticated/malformed-header traffic and ensures the DB work in steps 3–4 only ever runs for a request that at least *presents* a well-formed signature.

   > **Note — the old `META_APP_SECRET`-missing check moves.** Today the route rejects with `401` the instant `META_APP_SECRET` is absent, *before* the header check. In the new flow that unconditional check is **removed**; the "no usable secret" rejection becomes step 5 (`secrets.size === 0`), which runs *after* the header gate. The header gate (step 2) still short-circuits malformed/missing-signature requests with zero DB work, so the only requests that reach the DB are those presenting a well-formed `sha256=` header.

3. **Parse `phone_number_id`(s) for routing only (bounded).** Only now — for a request that passed the header gate — `JSON.parse` the raw body in a `try/catch` purely to collect candidate phone number ids, capped to a small constant so untrusted body JSON can never inflate the subsequent `IN (...)` query:
   ```ts
   const MAX_CANDIDATE_PHONE_IDS = 10; // legit Meta payloads carry exactly one
   let parsedPhoneIds: string[] = [];
   try {
     const peek = JSON.parse(raw);
     const ids = new Set<string>();
     outer: for (const entry of peek?.entry ?? [])
       for (const change of entry?.changes ?? []) {
         const id = change?.value?.metadata?.phone_number_id;
         if (typeof id === "string" && id) {
           ids.add(id);
           if (ids.size >= MAX_CANDIDATE_PHONE_IDS) break outer;
         }
       }
     parsedPhoneIds = [...ids];
   } catch {
     parsedPhoneIds = []; // unparseable body → no tenant candidate; platform secret only
   }
   ```
   This parsed value is **untrusted**: it is used *only* to look up candidate secrets, and grants no trust until a signature matches. The cap (`MAX_CANDIDATE_PHONE_IDS = 10`, deduplicated via the `Set`) means a crafted body stuffed with thousands of fake ids yields at most 10 distinct values into the `IN` query. A real Meta webhook contains exactly one `phone_number_id` per change, so the cap never affects legitimate traffic — it only defangs a malicious oversized body (which will 401 at step 6 anyway, since the attacker cannot sign it).

   > **Note — intentional double parse.** This peek parse (step 3) and the processing parse in step 7 (`const body = JSON.parse(raw)`) are **separate on purpose**. The peek result is used *only* to select candidate secrets and is discarded immediately after; it is never trusted and never fed to the processing loop. The post-verify parse in step 7 is the one whose result is actually processed. Re-parsing the same in-memory string is cheap and keeps the untrusted-peek and trusted-processing concerns textually separate; the raw body itself is still read only once (step 1).

4. **Build the bounded candidate-secret set.** The set contains at most: the platform `META_APP_SECRET` (if set), plus the decrypted `metaAppSecret` of the `TenantMetaApp` of each tenant that owns one of the (capped) `parsedPhoneIds`. It never iterates all tenants, and the `IN` query input is now bounded by the step-3 cap, not by attacker input.
   ```ts
   const secrets = new Set<string>();
   if (process.env.META_APP_SECRET) secrets.add(process.env.META_APP_SECRET);
   if (parsedPhoneIds.length) {
     const numbers = await prisma.whatsAppNumber.findMany({
       where: { phoneNumberId: { in: parsedPhoneIds } }, // ≤ 10 ids
       select: { userId: true },
     });
     const userIds = [...new Set(numbers.map((n) => n.userId))];
     if (userIds.length) {
       const apps = await prisma.tenantMetaApp.findMany({
         where: { userId: { in: userIds } },
         select: { metaAppSecret: true },
       });
       for (const app of apps) {
         try { secrets.add(decrypt(app.metaAppSecret)); }
         catch { /* undecryptable candidate: skip, never log, never crash */ }
       }
     }
   }
   ```
   Bound: platform secret + one secret per owning tenant referenced in *this* request (normally one; at most the number of distinct owning tenants behind ≤ 10 phone ids). A `decrypt()` failure on a candidate is treated as "that candidate unavailable" — skipped silently (no log line, no secret material) — not an error.

   > **Note — `phoneNumberId` is unindexed today (resolves review Finding 2 — NIT).** Verified against `prisma/schema.prisma`: `WhatsAppNumber.phoneNumberId` is `String?` and is **non-unique and non-indexed** (only `phoneNumber` carries `@unique`). So the `findMany({ where: { phoneNumberId: { in: parsedPhoneIds } } })` above is a table scan, but the `IN` list is capped at ≤ 10 ids (step 3) and `WhatsAppNumber` row counts are small per deployment, so the scan is acceptable at current scale — do **not** assume an index exists. Adding `@@index([phoneNumberId])` to `WhatsAppNumber` is a reasonable future optimization but is **out of scope** for this change (it would require another idempotent `scripts/` migration to create the index on live Turso, and the requirements do not call for it).

   Note: this path reads `TenantMetaApp.metaAppSecret` and `decrypt`s it directly rather than calling `resolveMetaAppCredentials(userId)`. Rationale: the resolver throws `MetaAppConfigError` on a bad decrypt (correct for the single-tenant API paths) and would also return the *platform* secret on its fallback branch, which the webhook already adds explicitly. Reading candidate secrets directly keeps the "skip bad candidate, keep trying others" semantics the fail-closed loop needs. Both the resolver and this loop share the same `decrypt` + "never log secret" contract, so the security property is identical; only the aggregation differs.

5. **Fail closed if no candidate secret is available.** If `secrets.size === 0` (no platform secret configured and no decryptable owning-tenant secret), return `401` and process nothing. This is the relocated form of today's "missing `META_APP_SECRET` → 401", generalized to "no usable secret at all" and now evaluated after the header gate and candidate build.

6. **Constant-time compare against each candidate; accept iff one validates.** For each candidate secret compute `HMAC-SHA256(raw, secret)` as hex and compare to `theirHex` using the existing length-guarded `crypto.timingSafeEqual` on equal-length `Buffer`s:
   ```ts
   let verified = false;
   for (const secret of secrets) {
     const ourHex = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
     const b = Buffer.from(ourHex, "hex");
     if (a.length === b.length && crypto.timingSafeEqual(a, b)) { verified = true; break; }
   }
   if (!verified) {
     console.warn("[Webhook] Signature verification failed");
     return new Response("Unauthorized", { status: 401 });
   }
   ```
   "Accept only if one validates" is satisfied: a single match flips `verified` and breaks; if none match, `verified` stays false and the request is rejected. (Multiple distinct candidate secrets producing the same HMAC over the same body is cryptographically implausible; the first match establishes authenticity and short-circuits.)

7. **Process exactly as today.** On `verified`, fall through to the unchanged `const body = JSON.parse(raw)` + entry/changes/statuses/messages loop, including strict routing by `phone_number_id → WhatsAppNumber` (no env/any-number fallback), the conversation upsert, and the "always return 200 so Meta doesn't retry" behavior on processing errors.

### Why this is safe

- **No DB work before the signature header gate.** The header-presence/`sha256=` check (step 2) runs before any `JSON.parse` or `prisma` query. A request with a missing or malformed signature header is rejected with `401` at zero DB cost — identical to today's cheap rejection — so an unauthenticated attacker cannot force a DB round-trip at all.
- **The DB-query input is bounded by a constant, not by attacker input.** `parsedPhoneIds` is capped at 10 distinct ids (step 3) before the `IN (...)` query, so a body stuffed with thousands of fake `phone_number_id`s cannot inflate the query. Legitimate Meta payloads carry exactly one id, so the cap is invisible to real traffic.
- **No trust is granted before verification.** The pre-parse in step 3 only *selects which secrets to try*. An attacker who fabricates a body with a victim's `phone_number_id` still cannot produce a valid `X-Hub-Signature-256` without that app's secret; the HMAC check in step 6 rejects it (401), so the fabricated `phone_number_id` buys nothing.
- **The candidate set is bounded and request-scoped**, so there is no "try every tenant's secret" oracle and no unbounded work. In the normal case there are at most two candidates (platform + the one owning tenant).
- **Constant-time compare** on equal-length buffers preserves the existing timing-safety property for each comparison.
- **Fail-closed** at every gap: missing/malformed header → 401 (no DB); unparseable body → platform-secret-only; no secrets at all → 401; no candidate matches → 401. Nothing is processed on failure.
- **Raw body read once**; the step-7 `JSON.parse(raw)` reuses the same in-memory string (no second `request.text()`). The step-3 peek parse of the same string is intentional and its result is discarded (see step 3 note).
- **No secret is ever logged** — not in the candidate loop (bad decrypts are silently skipped), not on verification failure (the existing warn logs no secret), not on success.
- A tenant on the platform app (`source: "platform"`, i.e. no `TenantMetaApp` row) is verified against `META_APP_SECRET` exactly as today, because the platform secret is always in the candidate set when configured.

### Intended behavior change (vs. today) — called out explicitly

This generalization changes one real case, and the change is **intended** by the requirements (FR-4 / AC-5: "fail closed when no candidate secret is available"):

- **Today:** if `META_APP_SECRET` is unset, the route 401s **every** webhook unconditionally, before even looking at the signature.
- **After this change:** a request still 401s if its signature header is missing/malformed (step 2) or if *no* usable secret exists (step 5). But in a deployment where `META_APP_SECRET` is unset **and** the event belongs to a tenant who has their own app (Model B), that tenant's event now verifies against **their** secret and is processed — whereas today it would have been blanket-401'd. Platform-app (Model A) tenants still 401 when the platform secret is unset, because there is no candidate secret for them. This is the correct multi-tenant behavior and is deliberately in scope; it is also documented in the `.env.example` reframing (§8).

### Error-handling table (webhook POST)

| Condition | Result | DB queried? | Logged? |
|---|---|---|---|
| Missing/malformed `x-hub-signature-256` (step 2) | `401`, process nothing | **No** (gate precedes all parse/DB) | warn, no secret (as today) |
| Body unparseable for pre-parse peek (step 3) | Candidate set = platform secret only; continue to verify | Only the candidate-build queries | No |
| `parsedPhoneIds` oversized (crafted body) | Capped to first 10 distinct ids before the `IN` query | `IN` bounded to ≤10 | No |
| No candidate secret available (`secrets.size === 0`, step 5) | `401`, process nothing | Candidate-build ran | error, no secret |
| A candidate `decrypt()` throws | Skip that candidate, keep others | — | No |
| No candidate matches signature (step 6) | `401`, process nothing | Candidate-build ran | warn, no secret (as today) |
| One candidate matches (step 6) | Proceed to existing processing (step 7) | Yes (processing) | info/debug, no secret |
| Error during post-verify processing | `200` (so Meta doesn't retry), as today | Yes | error (payload shape only) |

### Testability

Unit/integration-testable without the network: feed a known `raw` body + a header computed with a known secret, seed a `WhatsAppNumber` + `TenantMetaApp` for that `phone_number_id`, and assert: tenant-secret body verifies; platform-secret body verifies; wrong-secret body → 401; no `phone_number_id` + platform-only → verifies iff signed with platform secret; `secrets.size === 0` → 401; undecryptable candidate is skipped (does not throw, does not match). The signature math is deterministic, so these are stable tests.

### Files

Modify `src/app/api/webhooks/whatsapp/route.ts` only; add imports `prisma` (already imported) and `decrypt` from `@/lib/crypto`. GET handshake unchanged.

---

## 5. Tenant Meta App settings API — `src/app/api/meta-app/route.ts` (new)

A new session-guarded, `userId`-scoped route. All three methods follow the existing route style (`getServerSession(authOptions)`, `zod` parse, `NextResponse.json`, 401 on no session). None ever log or return the secret.

### Serializer (never leak the secret)

A small internal helper builds the GET response from a `TenantMetaApp | null` + the platform env, so the secret value cannot accidentally escape (analogous to `serializeNumber` stripping `accessToken`):

```ts
function serializeMetaApp(row: TenantMetaApp | null): {
  appId: string | null; configId: string | null;
  source: "tenant" | "platform"; hasSecret: boolean;
} {
  if (row) return { appId: row.metaAppId, configId: row.configId ?? null, source: "tenant", hasSecret: true };
  return {
    appId: process.env.META_APP_ID ?? null,
    configId: process.env.NEXT_PUBLIC_META_CONFIG_ID ?? null,
    source: "platform",
    hasSecret: false,
  };
}
```

`hasSecret` reflects whether a **tenant** secret is stored (`source: "tenant"` ⇒ `true`); the platform secret is never surfaced as the tenant's. The raw `metaAppSecret` ciphertext is never selected into or placed on the response object.

**Decision — `GET` stays cheap; `hasSecret` means "stored," not "valid" (resolves review Finding 3).** `serializeMetaApp` deliberately does **not** call `resolveMetaAppCredentials` and never decrypts: it reports `hasSecret: true` purely from row presence. This is chosen over a decrypt-probe (`secretValid`) because NFR-2 already mandates "a `decrypt()` throw → clean credential error, no secret/ciphertext leaked," and a probe risks either leaking error detail or adding a decrypt to every settings read. The consequence to document and honor in the UI (§6): a tenant whose stored secret is undecryptable (bad key / tampered) still shows `source: "tenant"`, `hasSecret: true` in `GET`, even though embedded-signup and the webhook will fail for them via `MetaAppConfigError`. To avoid presenting a broken config as healthy, the Settings UI copy for a stored tenant secret is **"Secret is stored"** (a storage fact), *not* "Secret is valid" or "Connected and working." The user's remedy for a broken secret is to re-enter it (a fresh `PUT` overwrites the ciphertext). This keeps `GET` O(1) and never decrypts in the settings read path.

### `GET /api/meta-app`

- 401 if no session.
- `const row = await prisma.tenantMetaApp.findUnique({ where: { userId: session.user.id } });`
- Return `serializeMetaApp(row)` → `{ appId, configId, source, hasSecret }`. The `appId`/`configId` are the **effective** values (tenant row if present, else platform env) so the connect page can drive the FB SDK at runtime. Secret value never returned.

### `PUT /api/meta-app`

- 401 if no session.
- `zod` body schema (note `configId` allows explicit `null` to clear — see the semantics decision below):
  ```ts
  const putSchema = z.object({
    metaAppId: z.string().trim().min(1).max(100),
    metaAppSecret: z.string().min(10).max(500).optional(),
    configId: z.string().trim().min(1).max(100).nullish(), // string | null | undefined
  });
  ```
  On parse failure → `400` with `parsed.error.flatten()` in `details`, matching the existing routes.

- **`configId` partial-update semantics — decided (resolves review Finding 4b).** `configId` follows the **same "omit = leave unchanged" rule as the secret**, not a silent clobber. Rationale: the requirements make the secret explicitly write-only/omit-preserving, and the UI's intent when it sends only a changed secret is not to wipe a working Config ID. So:
  - `configId` **absent** (`undefined`) → leave the stored `configId` unchanged.
  - `configId === null` → explicitly clear it to `NULL` (lets the UI intentionally remove a Config ID).
  - `configId` a non-empty string → set it.

  The Settings UI (§6) will send `configId: null` when the user clears the field and the current value is non-empty, and send the string when set; it omits the key only when it is not touching Config ID. This makes "clear" an explicit, deliberate action rather than an accident of omission.

- Enforce the **write-only / required-on-create** rule for the secret:
  - If **no existing row** and `metaAppSecret` is omitted/empty → `400 { error: "App secret is required to connect your Meta app" }` (a new row must carry a secret; the NOT NULL `metaAppSecret` column cannot be left empty).
  - If an existing row and `metaAppSecret` is omitted/empty → leave the stored secret unchanged.
  - If `metaAppSecret` is present → `encrypt(metaAppSecret)` and store the ciphertext.

- **Atomic upsert via `prisma.tenantMetaApp.upsert` (resolves review Finding 4a — no find-then-create race).** The earlier find-then-branch had a concurrent-PUT race: two simultaneous PUTs for the same `userId` could both take the `create` branch and the second would hit the `userId @unique` constraint (`P2002`) as an uncaught `500`. `prisma.upsert` is atomic on the unique key and still supports the conditional secret write because `upsert` takes **distinct `create` and `update` payloads** — the secret is simply included only where it belongs. The conditional-field logic lives in building those two payloads:
  ```ts
  // Validate the required-on-create secret BEFORE the upsert, using a cheap
  // existence check (not the row data — never select the ciphertext here):
  const existing = await prisma.tenantMetaApp.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!existing && !metaAppSecret) {
    return NextResponse.json(
      { error: "App secret is required to connect your Meta app" },
      { status: 400 },
    );
  }

  // Build update payload: only set fields the caller is changing.
  const updateData: Record<string, unknown> = { metaAppId };
  if (metaAppSecret) updateData.metaAppSecret = encrypt(metaAppSecret);
  if (configId !== undefined) updateData.configId = configId; // null clears, string sets, undefined untouched

  const row = await prisma.tenantMetaApp.upsert({
    where: { userId },
    create: {
      userId,
      metaAppId,
      metaAppSecret: encrypt(metaAppSecret!), // guaranteed present by the guard above
      configId: configId ?? null,             // on create, undefined → null (no prior value to preserve)
    },
    update: updateData,
  });
  ```
  This is atomic (no `P2002` race window — a concurrent second PUT becomes an `update`), honors "omit secret = keep existing" (secret omitted from `update` leaves it unchanged), and honors the `configId` semantics above (omitted → not in `update` payload → unchanged; `null` → cleared; string → set). On create there is no prior value, so an omitted `configId` sensibly stores `null`.

  **The required-on-create existence check is intentionally separate from the atomic upsert, and every interleaving is safe (resolves review Finding 4 — NIT).** The cheap `findUnique({ select: { id: true } })` guard that enforces "a new row must carry a secret" runs *before* the `upsert` and is therefore **not** atomic with it. This is deliberate and benign: enumerate the concurrent-PUT interleavings on a brand-new tenant. (a) Two first-time PUTs that both carry a secret: both pass the guard, both target `create`/`update` with a secret present — the atomic `upsert` serializes them on `userId @unique`, the first creates and the second becomes an `update` that re-sets the secret; correct. (b) A PUT-with-secret (A) and a PUT-without-secret (B) arrive together: if B's guard runs before A commits, B sees no row and 400s ("secret required to create") — correct, the tenant genuinely has no row yet; if B's guard runs after A commits, B sees the row and proceeds as a benign `update` that omits the secret, leaving A's secret unchanged — also correct. No interleaving creates a row without a secret, drops a stored secret, or throws an uncaught error. So the non-atomic guard is safe by construction; its only job is to reject the single legitimately-invalid case (first-ever write with no secret), and the atomic `upsert` owns the actual write-correctness.
- Return the serialized GET-shape (`serializeMetaApp(row)`) with `200`. Secret never returned.

### `DELETE /api/meta-app`

- 401 if no session.
- `await prisma.tenantMetaApp.deleteMany({ where: { userId: session.user.id } });` — `deleteMany` makes it idempotent (no throw when absent, unlike `delete`). Reverting a tenant to the platform fallback (Model A).
- Return `{ ok: true }` with `200`.

### Isolation & secret rules (all methods)

- Every query is scoped by `session.user.id`; a client-supplied userId is never read (NFR-1).
- The secret is write-only: accepted by PUT, encrypted before storage, never returned by GET, never logged in any branch (NFR-2).
- Validation failures → 400 with flattened zod details; missing session → 401 (NFR-3).

### Error-handling table (`/api/meta-app`)

| Method | Condition | Response |
|---|---|---|
| any | no session | `401 { error: "Unauthorized" }` |
| PUT | zod parse fails | `400 { error: "Invalid request body", details }` |
| PUT | create with no secret | `400 { error: "App secret is required to connect your Meta app" }` |
| PUT | concurrent PUT race | `prisma.upsert` is atomic on `userId @unique`; the second write becomes an `update`, no `P2002` surfaces |
| PUT | `encrypt()` throws (missing `ENCRYPTION_KEY`) | caught by route try/catch → `500 { error: "Internal server error" }`, no secret logged |
| GET/PUT/DELETE | DB error | caught → `500 { error: "Internal server error" }` |

### Testability

Integration-tested with a mocked session and a seeded/empty row: PUT-create requires secret; PUT-update omitting secret preserves it (assert ciphertext unchanged); PUT-update omitting `configId` preserves the stored `configId`, while PUT with `configId: null` clears it (assert both); GET never contains a secret field; GET reports `hasSecret: true`/`source: "tenant"` from row presence even when the stored secret is undecryptable (storage-fact semantics); DELETE is idempotent (two calls both 200); all three methods 401 without a session.

---

## 6. Settings UI — `src/app/dashboard/settings/page.tsx` (new)

The sidebar already links to `/dashboard/settings` (`src/components/dashboard/sidebar.tsx`), but no page exists there yet, so this creates the page the existing nav already points at. A client component (`"use client"`) using the existing `Card`/`Input`/`Label`/`Button` primitives (same imports as the connect page), with a "Meta App" section:

- On mount, `GET /api/meta-app`; populate `metaAppId` and `configId` inputs with the returned effective values and show the secret field as empty with a helper line **"Secret is stored"** when `hasSecret && source === "tenant"`, else "No tenant secret stored (using platform app)". The copy is deliberately "stored" (a storage fact), **not** "valid"/"connected" — because `GET` does not decrypt (see §5 Finding-3 decision), an undecryptable stored secret still reports `hasSecret: true`; "stored" avoids claiming a broken secret works, and the user's remedy is to re-enter it. The source badge shows `Using your own app` vs `Using platform app` from `source`.
- **Save** → `PUT /api/meta-app` with `{ metaAppId, configId, metaAppSecret }` where `metaAppSecret` is sent **only if the user typed one** (so an empty secret field on an existing row leaves it unchanged — the write-only rule), and `configId` follows the §5 rule: send the string when set, send `configId: null` when the user clears a previously-set value, omit the key when not touching it. The secret input is `type="password"`, never pre-filled with any stored value.
- **Auth handling (resolves review Finding 8):** the page relies on the existing `/dashboard` auth gate — verified `src/app/dashboard/layout.tsx` is a server component that calls `getServerSession(authOptions)` and `redirect("/login")` when there is no session, so an unauthenticated user never reaches this client page. If `GET /api/meta-app` nonetheless returns `401` (e.g. session expiry mid-session), the page surfaces it in the same inline error box as any other API error — it does **not** perform its own redirect. There is no `middleware.ts` in the repo; the layout guard is the auth boundary.
- **Clear / Disconnect own app** → `DELETE /api/meta-app`, then re-fetch to reflect the reverted platform state (`source: "platform"`, `hasSecret: false`).
- Errors from the API are surfaced inline (same red-box pattern as the connect page). The secret is never rendered back.

This page is a thin client over the API; it holds no secret and reflects only `hasSecret`/`source` state.

**Edge case:** if `GET` returns `appId: null` (platform env unset and no tenant row), the UI shows empty fields and the "no app configured" hint; saving a tenant app then flips `source` to `tenant`.

---

## 7. Connect page — runtime effective-config fetch

`src/app/dashboard/numbers/add/page.tsx` currently reads build-time-inlined `NEXT_PUBLIC_META_APP_ID`/`NEXT_PUBLIC_META_CONFIG_ID` at module scope. Those are frozen at build and cannot express per-tenant values, so they are replaced with a **runtime** fetch of the tenant's effective config.

Changes (behavior otherwise preserved):

- Remove the module-level `const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID;` / `META_CONFIG_ID` reads.
- Add state `const [cfg, setCfg] = useState<{ appId: string | null; configId: string | null } | null>(null);`.
- In a `useEffect` on mount, `fetch("/api/meta-app")` → set `cfg` to `{ appId, configId }`. The existing `message` listener (`WA_EMBEDDED_SIGNUP`) and FB SDK injection stay, but FB SDK **init now runs after `cfg.appId` is known**: gate the `initFB`/script-injection effect on `cfg?.appId` (effect depends on `cfg`), calling `window.FB.init({ appId: cfg.appId, ... })` with the fetched value.
- `handleConnect` uses `cfg?.appId` and `cfg?.configId` instead of the module constants. When either is absent, keep the **exact** existing message: `"Embedded Signup is not configured yet. Set NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_META_CONFIG_ID, or enter credentials manually."` and the manual path. (Message text unchanged to satisfy FR-5/AC-7; it still names the env vars because the platform fallback is still driven by them, and a tenant can instead use the Settings page or the manual form.)
- **Keep the "not configured yet…" string verbatim — do not reword it during implementation (resolves review Finding 5 — NIT).** The review flagged that this message now slightly under-describes the options (a Model B tenant could configure their own app via Settings rather than setting the `NEXT_PUBLIC_*` env vars), but AC-7 explicitly pins the string. This is a genuine tension resolved by honoring the requirement verbatim: the string **must not** be "helpfully" expanded to mention Settings, because any change breaks AC-7's exact-match check. This is recorded here as a NIT with **no code change** so an implementer does not silently reword it.
- `FB.login` is called with `config_id: cfg.configId` (runtime value).
- The manual-credentials form and its `POST /api/numbers/manual` submission are **untouched**.
- **Manual form stays available regardless of `cfg` (resolves review Finding 10).** Verified the current page renders the manual form gated only by its own `showManual` toggle, independent of any SDK/config state. This design keeps it that way: the manual form's rendering must **not** be gated on `cfg` (effective app/config), so a `cfg` of `null` — whether from a failed `GET /api/meta-app`, a network error, or a tenant/platform with no configured app — never hides the manual path. The Embedded-Signup button and its "not configured yet…" message are what depend on `cfg`; the manual form is always reachable.

**Edge cases:**
- Fetch fails (network/500): treat as "not configured" — show the existing message, keep the manual path available. Do not crash the page.
- `cfg` resolves to a tenant app: `FB.init`/`FB.login` use the tenant's `appId`/`configId`, so the popup runs under the tenant's app with no rebuild.
- `sdkReady` gating is preserved; the "Facebook SDK is still loading" guard remains.

**Testability:** this is client UI; verified by the build plus manual/E2E (SDK is third-party). The logic branch (configured vs not) is simple enough to assert via a component test that mocks `fetch` if a React test setup is added, but no test framework exists for client components in-repo today, so verification is primarily the production build + manual check.

---

## 8. `.env.example` documentation

Update `.env.example` so the platform Meta vars are documented as the **Model A fallback**, used only when a tenant has no `TenantMetaApp` row; per-tenant apps (Model B) override them. No new env var is introduced (per-tenant creds live in the DB, encrypted). Concretely:

- Reframe the `META_APP_ID` / `META_APP_SECRET` block: "Platform (Model A) fallback app. Used for a tenant's OAuth code exchange and inbound-webhook signature verification **only when that tenant has not connected their own Meta app** (Model B) via Settings. A tenant with their own app uses theirs instead."
- `META_WEBHOOK_VERIFY_TOKEN`: note it stays **platform-level and shared** — the GET handshake and the single webhook endpoint are not per-tenant (Out of Scope); only POST signature verification becomes per-app.
- `NEXT_PUBLIC_META_APP_ID` / `NEXT_PUBLIC_META_CONFIG_ID`: note they remain the platform fallback for the connect page, but the connect page now fetches the **effective** app/config at runtime from `GET /api/meta-app`, so a tenant's own app no longer requires a rebuild.
- **Fix the now-false "only ever read client-side" sentence in the "Client-exposed Meta values" block (resolves review Finding 1 — MEDIUM).** The current `.env.example` asserts, verbatim: *"There is NO server-side META_CONFIG_ID; the Embedded Signup Configuration ID is only ever read client-side via NEXT_PUBLIC_META_CONFIG_ID."* After this change that is false — `resolveMetaAppCredentials` (§2, platform branch) and `serializeMetaApp` / `GET /api/meta-app` (§5) both read `process.env.NEXT_PUBLIC_META_CONFIG_ID` **server-side** (the `NEXT_PUBLIC_` prefix only controls client-bundle inlining; it does not prevent a server-side `process.env` read). Replace that sentence with: *"`NEXT_PUBLIC_META_CONFIG_ID` is the platform (Model A) Embedded Signup Configuration ID. It is inlined into the client bundle at build time **and** read server-side by `resolveMetaAppCredentials` and `GET /api/meta-app` as a plain env var (the `NEXT_PUBLIC_` prefix does not stop server reads). The connect page now obtains the effective config id at runtime from `GET /api/meta-app`, so a tenant's own Config ID (Model B, stored encrypted in the DB) overrides this platform value without a rebuild."*
- **Soften the adjacent "Changing them requires a REBUILD to take effect" line in the same block.** It is no longer true for the connect page's effective config, which is now fetched at runtime. Reword to scope the rebuild caveat to the build-time-inlined client constant only: *"NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so any code that reads the inlined constant directly still needs a rebuild to pick up a new value. The connect page no longer reads those constants directly — it fetches the effective app/config at runtime from `GET /api/meta-app` — so changing a tenant's own app via Settings takes effect without a rebuild. Changing the platform fallback values themselves still requires updating the env and (for any remaining inlined client reads) a rebuild."* Name both of these sentences explicitly so the implementer edits this block and does not leave the stale client-only claim.
- Keep the `ENCRYPTION_KEY` block as-is (it already documents AES-256-GCM at-rest encryption; the tenant app secret reuses it).
- Extend the "Meta-side prerequisites" footer to say the same prerequisites (Embedded Signup Configuration ID; App Review for `whatsapp_business_management` + `whatsapp_business_messaging`) apply **per app** — once for the platform app, and once per tenant that brings their own app. Also correct the footer's Configuration-ID bullet, which currently says *"The code reads it client-side as NEXT_PUBLIC_META_CONFIG_ID; changing it requires a rebuild"* — this is now inconsistent with the server-side read and runtime fetch. Reword it to: *"The platform Configuration ID is set as NEXT_PUBLIC_META_CONFIG_ID; it is read both in the client bundle and server-side, and the connect page fetches the effective (tenant-or-platform) value at runtime, so a tenant's own Configuration ID overrides the platform one without a rebuild."* This keeps the footer consistent with the "Client-exposed Meta values" block fix above.
- **Correct the now-inaccurate footer line (resolves review Finding 9).** The current footer asserts: *"`META_APP_SECRET` is mandatory: without it the webhook rejects every payload (401), so delivery-status updates never land."* After the per-app change this is only conditionally true (a Model B tenant's events verify against *their* secret even if the platform secret is unset). Replace that line with: *"`META_APP_SECRET` verifies inbound webhooks for tenants on the platform app (Model A); tenants who connected their own Meta app (Model B) are verified against their own secret instead. Keep it set — without it, platform-app tenants' delivery-status updates are rejected (401)."* This matches the §4 "intended behavior change" note so the doc and the code agree.

No secrets or real values appear in the file (placeholders only, as today).

---

## Files created / modified

**Created**
- `prisma/schema.prisma` — (modified) add `TenantMetaApp` model + `User.tenantMetaApp` back-relation.
- `scripts/add-tenant-meta-app-table.mjs` — idempotent `@libsql/client` `CREATE TABLE IF NOT EXISTS` migration.
- `src/lib/meta-app.ts` — `resolveMetaAppCredentials`, `ResolvedMetaApp`, `MetaAppConfigError`.
- `src/app/api/meta-app/route.ts` — `GET`/`PUT`/`DELETE`, session-guarded, `userId`-scoped, secret-never-leaked serializer.
- `src/app/dashboard/settings/page.tsx` — tenant Meta App settings UI.

**Modified**
- `src/app/api/numbers/embedded-signup/route.ts` — use `resolveMetaAppCredentials(session.user.id)` for the OAuth code exchange.
- `src/app/api/webhooks/whatsapp/route.ts` — per-app signature verification via bounded candidate-secret set (fail-closed); GET handshake + routing unchanged.
- `src/app/dashboard/numbers/add/page.tsx` — runtime `GET /api/meta-app` effective-config fetch replacing build-time `NEXT_PUBLIC_*` reads; manual path untouched.
- `.env.example` — platform vars documented as Model A fallback; prerequisites per-app; no new var.

**Verification gate:** `prisma generate && next build` must pass. Run the migration script once against Turso (`node scripts/add-tenant-meta-app-table.mjs`) and a second time to confirm the clean no-op. A tenant with no `TenantMetaApp` row must exhibit identical behavior to pre-change across embedded signup, webhook verification, sends, template routes, and manual connect (no regression).

---

## Acceptance-criteria coverage

| AC | Addressed by |
|---|---|
| 1 (schema + generate) | §1 model + back-relation |
| 2 (idempotent table script) | §1 DDL + `CREATE TABLE/INDEX IF NOT EXISTS` |
| 3 (resolver precedence + clean errors) | §2 contract + error table |
| 4 (embedded-signup per-app exchange) | §3 |
| 5 (webhook bounded candidate-set, fail-closed) | §4 |
| 6 (`/api/meta-app` CRUD, no secret leak) | §5 |
| 7 (connect page runtime fetch, message preserved, manual untouched) | §7 |
| 8 (settings UI write-only secret, clear reverts) | §6 |
| 9 (`.env.example` Model A fallback docs) | §8 |
| 10 (build passes, no regression) | Verification gate + no-fallback-change for platform tenants |

---

## Responses to design review findings

### Second review pass (current)

Review: `.agents/tasks/design-metaapp-review.md` / `.json` (verdict `CHANGES_REQUESTED`; HIGH 0, MEDIUM 1, NIT 4). This pass re-verified the first-pass resolutions and raised 5 new findings. All 5 are addressed below; none are backlogged or ignored. Every resolution stays within the original requirements.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | MEDIUM | `.env.example` states the Config ID is only read client-side, which the resolver's server-side read contradicts; §8 did not fix that line | **Addressed in §8.** Added explicit edits: replace the *"There is NO server-side META_CONFIG_ID; … only ever read client-side via NEXT_PUBLIC_META_CONFIG_ID"* sentence with wording that `NEXT_PUBLIC_META_CONFIG_ID` is read both at build time (client bundle) **and** server-side by `resolveMetaAppCredentials` / `GET /api/meta-app`, and that the connect page fetches the effective config id at runtime so a tenant's own Config ID overrides it without a rebuild. Also softened the adjacent "requires a REBUILD" sentence and corrected the matching Configuration-ID bullet in the "Meta-side prerequisites" footer, so the doc and code agree. |
| 2 | NIT | Webhook candidate build queries `WhatsAppNumber.phoneNumberId`, which is unindexed (table scan) | **Addressed in §4 step 4.** Added a note (verified against `schema.prisma`: `phoneNumberId` is `String?`, non-unique, non-indexed; only `phoneNumber` is `@unique`) that the `IN (≤10)` scan is acceptable at current scale and that a follow-up `@@index([phoneNumberId])` is explicitly out of scope. |
| 3 | NIT | Resolver `findUnique` loads the ciphertext column; design should state it never leaves the resolver | **Addressed in §2.** Added a paragraph: the `findUnique` result (including `metaAppSecret` ciphertext) stays local to the resolver; only the decrypted value is returned inside `appSecret`; the ciphertext is never placed on the returned object, returned, or logged (mirrors `serializeNumber`), and the discarded `decrypt()` error cannot leak it. |
| 4 | NIT | `PUT` required-on-create existence check is non-atomic with the upsert it guards (benign but undocumented) | **Addressed in §5.** Added a paragraph noting the existence-check guard is intentionally separate from the atomic `upsert`, and walked every concurrent interleaving to show each yields a correct outcome (create-with-secret always carries the secret; a late no-secret PUT becomes a benign update); no interleaving creates a secret-less row, drops a secret, or throws. |
| 5 | NIT | Connect-page "not configured" message names only `NEXT_PUBLIC_*` vars; must stay verbatim per AC-7 | **Addressed in §7 — no code change.** Recorded explicitly that the string must stay verbatim to satisfy AC-7 and must not be reworded (e.g. to mention Settings) during implementation, despite slightly under-describing the Model B option. |

### First review pass (prior)

Review: earlier `CHANGES_REQUESTED` pass (HIGH 1, MEDIUM 4, NIT 5). All ten findings are addressed below; none are backlogged or ignored. Every resolution stays within the original requirements (per-tenant overrides platform; fail-closed webhook; no new deps; no regression).

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | HIGH | Webhook step order ambiguous → possible pre-auth DB work; `META_APP_SECRET`-missing behavior change unacknowledged | **Addressed in §4.** Pinned the order: (1) read raw body, (2) **signature-header gate before any parse/DB** — missing/malformed header 401s with zero DB cost, (3) bounded parse-for-routing, (4) candidate build, (5) `secrets.size===0` → 401, (6) constant-time compare. Added an explicit "Intended behavior change" subsection: with `META_APP_SECRET` unset, Model B tenants now verify against their own secret while Model A tenants still 401 — which is what FR-4/AC-5 require. |
| 2 | MED | Migration DDL claimed to mirror a pattern that has no `CREATE TABLE`/`FOREIGN KEY`/`CURRENT_TIMESTAMP`; FK not enforced by libSQL | **Addressed in §1.** Separated "mechanics reused from the proven script" from "net-new `CREATE TABLE`." **Decided: drop the DB-level FK** (libSQL doesn't enforce it without `PRAGMA foreign_keys=ON`; cascade is enforced by Prisma, which is how every write/delete happens here) and **make timestamps plain `TEXT NOT NULL` with no SQL default** (Prisma supplies the values; no non-Prisma insert exists). DDL updated to match. Prisma model keeps `onDelete: Cascade` for the client-level cascade. |
| 3 | MED | `GET /api/meta-app` reports healthy state for an undecryptable stored secret | **Addressed in §5 + §6.** Decided option (a): `GET` stays cheap and never decrypts; `hasSecret`/`source` come from row presence. Documented that `hasSecret: true` means **stored, not valid**, and set the Settings UI copy to **"Secret is stored"** (not "valid"/"connected"), with re-entry as the remedy. No decrypt error is ever leaked. |
| 4 | MED | `PUT` find-then-create race (`P2002` → 500); `configId` silently clobbered to null on omit | **Addressed in §5.** Switched to atomic `prisma.tenantMetaApp.upsert` with distinct `create`/`update` payloads (no race; conditional secret write preserved). Decided `configId` semantics explicitly: **omit = leave unchanged, `null` = clear, string = set** (same omit-preserving rule as the secret); the UI sends `null` to clear. zod uses `.nullish()`. |
| 5 | MED | `parsedPhoneIds` unbounded from untrusted body → pre-auth DB amplification | **Addressed in §4 step 3.** Enforced Finding-1 ordering (header gate before any parse/DB) **and** capped `parsedPhoneIds` to the first 10 distinct ids before the `IN` query. Documented that legitimate Meta payloads carry exactly one id, so the cap never affects real traffic. |
| 6 | NIT | Double `JSON.parse` not flagged as intentional | **Addressed in §4 step 3 note:** the peek parse and the processing parse are separate on purpose; the peek result is discarded after secret selection and never trusted; the raw body is still read once. |
| 7 | NIT | Resolver returns `configId` from a `NEXT_PUBLIC_*` var server-side; could look like a bug | **Addressed in §2 contract:** annotated `ResolvedMetaApp.configId` as informational for the connect page, unused by the OAuth exchange, and noted that reading `NEXT_PUBLIC_META_CONFIG_ID` server-side is a deliberate plain-env read. |
| 8 | NIT | Settings page 401 behavior / `/dashboard` auth gate unstated | **Addressed in §6:** verified `src/app/dashboard/layout.tsx` server-side session guard (`getServerSession` → `redirect("/login")`); stated the page relies on it and surfaces a mid-session `401` in the inline error box (no self-redirect). No `middleware.ts` exists; the layout is the boundary. |
| 9 | NIT | `.env.example` "rejects every payload (401)" footer becomes inaccurate | **Addressed in §8:** replaced that line with per-app wording (platform secret verifies Model A tenants; Model B tenants verify against their own; keep it set so Model A delivery-status updates don't 401), matching §4's behavior-change note. |
| 10 | NIT | Confirm manual form stays visible when `cfg` is null/failed | **Addressed in §7:** verified the manual form is gated only by `showManual`, independent of `cfg`; stated it must not be gated on `cfg`, so a null/failed effective-config never hides the manual path. |

---

Design file path: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/.agents/tasks/design-metaapp.md`
