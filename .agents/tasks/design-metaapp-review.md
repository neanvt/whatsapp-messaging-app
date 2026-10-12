# Design Review — Bring-Your-Own Meta App (Model B) with shared-app fallback (Model A)

- **Design reviewed:** `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/.agents/tasks/design-metaapp.md`
- **Requirements:** `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp/.agents/tasks/requirements-metaapp.md`
- **Review method:** Read the design cold, then verified every load-bearing claim against the actual source (`src/lib/crypto.ts`, `src/lib/db.ts`, `src/lib/whatsapp.ts`, `src/app/api/webhooks/whatsapp/route.ts`, `src/app/api/numbers/embedded-signup/route.ts`, `src/app/dashboard/numbers/add/page.tsx`, `src/app/dashboard/layout.tsx`, `src/components/dashboard/sidebar.tsx`, `prisma/schema.prisma`, `scripts/*.mjs`, `.env.example`). Where the design flagged "unverified territory" (the TEXT-affinity `DateTime` round-trip), I ran an empirical probe against the real `@prisma/adapter-libsql` + `@libsql/client` to settle it.

## Verdict

**APPROVED.** No HIGH or MEDIUM findings. Three NITs are recorded below; none block implementation. The design is third-iteration and the two prior review passes closed the substantive issues; this pass re-verified them against source and empirically confirmed the one remaining feasibility risk is safe.

---

## Findings

### 1. NIT — PUT/GET/DELETE route-level `try/catch` is asserted by the error table but omitted from the code snippets (§5)

The §5 error-handling table promises that `encrypt()` throwing (missing `ENCRYPTION_KEY`) and any DB error are "caught by route try/catch → `500 { error: "Internal server error" }`, no secret logged." The design says the methods "follow the existing route style," and the existing `embedded-signup` route does wrap its whole body in `try/catch`. But the §5 `GET`/`PUT`/`DELETE` snippets themselves show no enclosing `try/catch`. Nothing in the design is wrong; it is an omission that an implementer could copy literally and ship un-wrapped handlers, which would surface a raw Prisma/`encrypt` error object (and `encrypt` on a bad key throws `"ENCRYPTION_KEY is missing or not a 32-byte base64 key"` — not a secret, but still an internals leak).

**Concrete fix:** State explicitly that each of the three methods is wrapped in `try { … } catch (e) { console.error("[meta-app]", e); return NextResponse.json({ error: "Internal server error" }, { status: 500 }); }` (no secret in the log line, matching the embedded-signup route), so the error-table rows are actually realized in code.

### 2. NIT — `encrypt()` is referenced as the storage primitive but the `ENCRYPTION_KEY`-missing failure mode is only half-specified for PUT-create (§5)

Verified in `src/lib/crypto.ts`: `encrypt()`/`decrypt()` resolve the key lazily and throw a generic (non-secret) `Error` when `ENCRYPTION_KEY` is absent or not 32 bytes. The PUT-create path calls `encrypt(metaAppSecret!)` inside the `upsert` `create` payload. If `ENCRYPTION_KEY` is unset, this throws *after* the required-on-create guard has passed and *inside* the `upsert` call. The design's error table covers it ("caught by route try/catch → 500") but only if finding #1 is honored. This is the same root omission as #1, called out separately because it is the one place a secret-adjacent operation can throw.

**Concrete fix:** Fold into #1 — ensure the `PUT` body (including the `encrypt()` call) is inside the handler `try/catch`. No behavioral change beyond that.

### 3. NIT — "process exactly as today" (§4 step 7) silently assumes the old `appSecret` local is fully removed from the webhook

Verified against `src/app/api/webhooks/whatsapp/route.ts`: today `const appSecret = process.env.META_APP_SECRET` is read once and used only for the single HMAC. The new flow (§4) removes that unconditional read (the design's "Note — the old `META_APP_SECRET`-missing check moves" covers this) and replaces the HMAC with the candidate loop. The design's step 7 says processing is "unchanged," which is true, but an implementer doing a minimal diff could leave the now-dead `const appSecret`/`ourHex`/`b` lines in place and produce an unused-variable or a stale second verification. The design does not explicitly list the lines to delete.

**Concrete fix:** Add a one-line note to §4: "Delete the current `const appSecret = process.env.META_APP_SECRET` guard block and the single-secret `ourHex`/`Buffer.from(ourHex)` compare entirely; they are fully replaced by steps 2–6. Only `const raw`, the `theirHex`/`a` extraction (step 2), and the processing loop (step 7) survive from the original body."

---

## Verified Assumptions (checked against source / empirically)

1. **`serializeNumber` strips `accessToken`** — Confirmed in `src/lib/whatsapp.ts` (`const { accessToken: _accessToken, ...rest } = number; return rest;`). The design's `serializeMetaApp` analogy (never place `metaAppSecret` on the response object) is sound.
2. **`crypto.ts` contract** — Confirmed: `encrypt` → `base64(iv).base64(tag).base64(ciphertext)`; `decrypt` throws `"Invalid ciphertext format"` on malformed input and throws via the GCM auth tag on tamper/bad key; key is lazily resolved from `ENCRYPTION_KEY` (32-byte base64); neither logs its inputs. The resolver's "catch decrypt → `MetaAppConfigError`, never rethrow/log the original" (§2) is correct and necessary (the raw error can carry buffer context).
3. **Migration-script pattern** — Confirmed only three repo scripts exist (`test-crypto.mjs`, `add-media-attachments.mjs`, `add-meta-onboarding-columns.mjs`). `add-meta-onboarding-columns.mjs` does only `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`, with the exact `.env` regex parse, `createClient({ url, authToken })`, try/catch → `process.exit(1)`, `client.close()` in `finally`. No `CREATE TABLE`, no `FOREIGN KEY`, no `DEFAULT CURRENT_TIMESTAMP` anywhere. The design's claim that `CREATE TABLE IF NOT EXISTS` is net-new territory (and its decision to drop the DB-level FK and omit SQL timestamp defaults) is accurately grounded.
4. **`datasource` provider is `sqlite`** — Confirmed in `prisma/schema.prisma`. So Prisma's unique-index naming `TenantMetaApp_userId_key` (`<Model>_<field>_key`) is the correct name for the hand-written `CREATE UNIQUE INDEX`, matching the generated client. 
5. **TEXT-affinity `createdAt`/`updatedAt` round-trips correctly through Prisma over libSQL** — The design flagged this as "unverified territory." I verified it empirically: created a `Package`-shaped table with `createdAt TEXT NOT NULL` / `updatedAt TEXT NOT NULL` over the real `@prisma/adapter-libsql` + `@libsql/client`, ran `prisma.package.create(...)` then `findUnique(...)`, and both the write and read returned a proper `Date` object (`isDate: true`, correct ISO value). The adapter decodes `DateTime` by the Prisma schema type, not the SQLite affinity, so the coerced-text storage does not break reads. **The design's choice (`TEXT NOT NULL`, no SQL default, Prisma supplies all values) is feasible and safe.** Prisma `generate && build` will not exercise this (it is runtime), but the probe confirms runtime correctness.
6. **`WhatsAppNumber.phoneNumberId` is `String?`, non-unique, non-indexed** — Confirmed (only `phoneNumber` is `@unique`). The §4 candidate-build `findMany({ where: { phoneNumberId: { in: ≤10 } } })` is a table scan, correctly flagged as acceptable at scale with `@@index` out of scope.
7. **Embedded-signup route shape** — Confirmed: whole body in a top-level `try/catch` returning generic `500`; reads `META_APP_ID`/`META_APP_SECRET`; exchanges code at `${GRAPH}/oauth/access_token?client_id=…&client_secret=…&code=…`; downstream `debug_token`, `/phone_numbers`, health, `subscribed_apps`, `/register`, `normalizePhone`, `encrypt(businessToken)`, `upsertNumberForUser`, `serializeNumber`, `NumberOwnedByOtherTenantError` → 409. The §3 rewiring (inner resolver `try/catch`, rethrow non-`MetaAppConfigError` to the outer catch) is consistent and preserves the exact "Server is not configured for Embedded Signup" 500 copy.
8. **Webhook current behavior** — Confirmed: reads `META_APP_SECRET` first (401 if missing), then header gate (401 if missing/malformed `sha256=`), single HMAC `timingSafeEqual` on equal-length buffers, then `JSON.parse(raw)`, strict routing by `phone_number_id` via `findFirst` (no env/any-number fallback), conversation upsert, always-200-on-processing-error. The §4 reordering (header gate before any parse/DB, bounded peek-parse, candidate set, fail-closed) and its "intended behavior change" note (with `META_APP_SECRET` unset, Model B tenants now verify against their own secret; Model A tenants still 401) are accurate and match FR-4/AC-5.
9. **`session.user.id` and `session.user.role`** — Confirmed the `authorize` return in `src/lib/auth.ts` sets `id`, `email`, `name`, `role`. The `userId`-scoping in the resolver and `/api/meta-app` is valid.
10. **Dashboard auth gate / no middleware** — Confirmed `src/app/dashboard/layout.tsx` is a server component calling `getServerSession(authOptions)` and `redirect("/login")` when there is no session. No `src/middleware.ts` exists (only `.next` build artifacts and `node_modules/next-auth/src/middleware.ts`). The §6 claim that the settings page relies on the layout gate and surfaces a mid-session 401 inline (no self-redirect) is accurate.
11. **Sidebar already links `/dashboard/settings`** — Confirmed in `src/components/dashboard/sidebar.tsx` (`href="/dashboard/settings"`). §6 creates the page the nav already points at; no dead/duplicate link.
12. **Connect page current state** — Confirmed it reads module-level `NEXT_PUBLIC_META_APP_ID`/`NEXT_PUBLIC_META_CONFIG_ID`, injects the FB SDK, `FB.login` with `config_id`, has the exact "Embedded Signup is not configured yet. Set NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_META_CONFIG_ID, or enter credentials manually." string, and renders the manual form gated only by its own `showManual` toggle (independent of SDK/config). The §7 plan (runtime fetch, keep the string verbatim per AC-7, never gate the manual form on `cfg`) is consistent with the real code.
13. **`.env.example` stale sentence exists** — Confirmed verbatim: *"There is NO server-side META_CONFIG_ID; the Embedded Signup Configuration ID is only ever read client-side via NEXT_PUBLIC_META_CONFIG_ID."* and the footer *"META_APP_SECRET is mandatory: without it the webhook rejects every payload (401)…"* and *"The code reads it client-side as NEXT_PUBLIC_META_CONFIG_ID; changing it requires a rebuild."* All three are the lines §8 targets; the design's replacement wording is correct and makes the doc agree with the new server-side reads and per-app webhook behavior.
14. **zod bounds match NFR-3** — `metaAppId` 1–100, `metaAppSecret` 10–500 (optional), `configId` 1–100 (nullish): the §5 `putSchema` matches the requirements exactly.
15. **`DELETE` idempotency** — `deleteMany({ where: { userId } })` is correctly chosen over `delete` to avoid a throw when absent (AC-6 idempotent). Verified this is the standard Prisma idiom.
16. **`PUT` atomic upsert avoids `P2002` race** — `prisma.tenantMetaApp.upsert` keyed on `userId @unique` with distinct `create`/`update` payloads is the correct resolution; the non-atomic required-on-create existence guard is correctly reasoned to be benign across all interleavings (no interleaving creates a secret-less row, drops a secret, or throws uncaught).

## Unverified / Wrong Assumptions

None. Every claim the design labeled "verified" was re-checked against source and holds. The single item the design itself called "unverified territory" (TEXT-affinity `DateTime` round-trip through the libSQL adapter) was promoted to **verified** by an empirical probe (see Verified Assumptions #5) and is safe. No assumption in the design was found to be wrong.

---

## Requirement / Acceptance-Criteria coverage check

| AC | Covered? | Note |
|---|---|---|
| 1 — schema + `prisma generate` exposes `tenantMetaApp` | Yes | §1 model + `User.tenantMetaApp` back-relation; cuid id, `userId @unique`, `onDelete: Cascade`. |
| 2 — idempotent `CREATE TABLE IF NOT EXISTS` script, columns match model | Yes | §1 DDL + `CREATE UNIQUE INDEX IF NOT EXISTS TenantMetaApp_userId_key`; FK-drop and TEXT-timestamp decisions grounded and (timestamp) empirically safe. |
| 3 — resolver precedence + clean errors, no secret leak | Yes | §2 contract, error table, ciphertext-stays-local paragraph. |
| 4 — embedded-signup per-app exchange, status codes preserved | Yes | §3 inner resolver try/catch; outer catch preserved. |
| 5 — webhook bounded candidate set, fail-closed, no secret logged | Yes | §4 ordered steps; "intended behavior change" documented. |
| 6 — `/api/meta-app` CRUD, secret write-only, 401 w/o session, `userId`-scoped | Yes | §5; GET `hasSecret` = stored (not valid), documented. |
| 7 — connect page runtime fetch, exact message, manual untouched | Yes | §7; verbatim string pinned, manual form not gated on `cfg`. |
| 8 — settings UI write-only secret, clear reverts | Yes | §6; "Secret is stored" copy. |
| 9 — `.env.example` Model A fallback docs, no new env var | Yes | §8; three stale lines corrected. |
| 10 — build passes, no regression for tenants without a row | Yes | Verification gate; platform branch is byte-for-byte current behavior. |

The three NITs are documentation/implementation-hygiene refinements (make the asserted route-level `try/catch` explicit in the snippets, and name the webhook lines to delete). They do not change the verdict.
