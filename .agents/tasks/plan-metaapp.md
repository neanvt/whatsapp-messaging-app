# Implementation Plan — Bring-Your-Own Meta App (Model B) with shared-app fallback (Model A)

Source of truth: `/.agents/tasks/design-metaapp.md` (approved) and `/.agents/tasks/requirements-metaapp.md`.
Build/verify gate for the project: `npm run build` (= `prisma generate && next build`). There is no test
framework in the repo (no jest/vitest/playwright config, no `test` script in `package.json`), so verification
is the production build plus the manual/reasoning checks each item names. The Turso migration script is run
with `node scripts/<name>.mjs` (there is no npm script for `scripts/*.mjs`).

Ordering is by dependency: foundation (schema + migration + resolver) → consumers (embedded-signup, webhook,
CRUD API) → UI + connect page → docs + scratchpad. Each item leaves the codebase buildable.

---

- [ ] 1. Add the `TenantMetaApp` Prisma model and the `User.tenantMetaApp` back-relation.
      Add the model exactly as in design §1 (`id @default(cuid())`, `userId @unique`, `user` relation with
      `onDelete: Cascade`, `metaAppId String`, `metaAppSecret String` (ciphertext), `configId String?`,
      `createdAt @default(now())`, `updatedAt @updatedAt`). Add `tenantMetaApp TenantMetaApp?` to the `User`
      model alongside the existing relations (`credits`, `whatsappNumbers`, etc.). Datasource provider is
      `sqlite`; keep it. Do NOT run `prisma db push` (rejected over `libsql://`).
      Files: `prisma/schema.prisma`
      Verify: `npx prisma generate` succeeds and the generated client types expose `prisma.tenantMetaApp`
      (confirmed by `npm run build` passing in a later item that uses it; a standalone check is
      `npx prisma validate` returns "The schema ... is valid").

- [ ] 2. Create the idempotent `@libsql/client` migration script that creates the `TenantMetaApp` table on Turso.
      Reuse the mechanics of `scripts/add-meta-onboarding-columns.mjs` (manual `.env` parse with the same regex,
      `createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })`, try/catch → non-secret
      `console.error` → `process.exit(1)`, `client.close()` in `finally`). Execute the exact DDL from design §1:
      `CREATE TABLE IF NOT EXISTS TenantMetaApp (id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL,
      metaAppId TEXT NOT NULL, metaAppSecret TEXT NOT NULL, configId TEXT, createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL);` then `CREATE UNIQUE INDEX IF NOT EXISTS TenantMetaApp_userId_key ON
      TenantMetaApp (userId);`. No `FOREIGN KEY`, no `DEFAULT CURRENT_TIMESTAMP` (rationale in §1 — libSQL does
      not enforce FKs without `PRAGMA foreign_keys=ON`; Prisma supplies all timestamps). Optionally
      `PRAGMA table_info(TenantMetaApp)` first to log "created" vs "already exists. Skipping." Log only
      table/index status — never row data.
      Files: `scripts/add-tenant-meta-app-table.mjs`
      Verify: `node scripts/add-tenant-meta-app-table.mjs` creates the table and exits 0; run it a SECOND time
      and confirm it is a clean no-op (logs "already exists", exits 0, no error). Then confirm the table exists,
      e.g. via a one-off `PRAGMA table_info(TenantMetaApp)` showing columns `id,userId,metaAppId,metaAppSecret,
      configId,createdAt,updatedAt` and the unique index `TenantMetaApp_userId_key` present. (Requires a live
      `.env` with `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`; if unavailable in this environment, state that and
      confirm the DDL/idempotency by code review instead.)

- [ ] 3. Create the shared resolver module `src/lib/meta-app.ts`.
      Implement exactly per design §2: `interface ResolvedMetaApp { appId; appSecret; configId: string | null;
      source: "tenant" | "platform" }`, `class MetaAppConfigError extends Error`, and
      `async function resolveMetaAppCredentials(userId): Promise<ResolvedMetaApp>`. Import `prisma` from
      `@/lib/db` and `decrypt` from `@/lib/crypto`. Precedence: `prisma.tenantMetaApp.findUnique({ where:
      { userId } })`; if a row exists, decrypt `metaAppSecret` inside try/catch and on failure throw
      `new MetaAppConfigError("Tenant Meta app credentials are invalid")` (never rethrow/log the caught error),
      return `{ appId: row.metaAppId, appSecret, configId: row.configId ?? null, source: "tenant" }`. Else read
      `process.env.META_APP_ID`/`META_APP_SECRET`; if either falsy throw
      `new MetaAppConfigError("Server is not configured for Embedded Signup")`; return
      `{ appId, appSecret, configId: process.env.NEXT_PUBLIC_META_CONFIG_ID ?? null, source: "platform" }`.
      The resolver never logs; the ciphertext `row` stays local and is never returned or logged.
      Files: `src/lib/meta-app.ts`
      Verify: `npm run build` compiles the new module (and item 1's client types). Reason through the precedence
      table (§2 error-handling table): tenant-row → decrypts → `source:"tenant"`; bad decrypt → `MetaAppConfigError`
      with no secret; no row + env present → `source:"platform"`; no row + env missing → `MetaAppConfigError`.

- [ ] 4. Rewire `POST /api/numbers/embedded-signup` to resolve app creds via the resolver.
      Per design §3: remove the direct `process.env.META_APP_ID`/`META_APP_SECRET` reads and the inline
      `if (!appId || !appSecret) { ...500... }`. Import `resolveMetaAppCredentials, MetaAppConfigError` from
      `@/lib/meta-app`. After the session guard and body parse, do
      `try { ({ appId, appSecret } = await resolveMetaAppCredentials(session.user.id)); } catch (e) {
      if (e instanceof MetaAppConfigError) return NextResponse.json({ error: "Server is not configured for
      Embedded Signup" }, { status: 500 }); throw e; }`. Keep the exact 500 copy string so client-facing text
      is unchanged. Everything downstream (token exchange URL using `appId`/`appSecret`, `debug_token`,
      `/phone_numbers`, health, `subscribed_apps`, `/register`, `normalizePhone`, `encrypt(businessToken)`,
      `upsertNumberForUser`, `serializeNumber`, 201/400/409/401/500 branches, `NumberOwnedByOtherTenantError`)
      stays unchanged.
      Files: `src/app/api/numbers/embedded-signup/route.ts`
      Verify: `npm run build` passes. Reason through: a tenant with a `TenantMetaApp` row sends their `appId` in
      the token URL (`source:"tenant"`); a tenant without one uses platform env unchanged; a resolver
      `MetaAppConfigError` yields the same 500 "Server is not configured for Embedded Signup" as today; any
      other throw falls to the route's existing top-level catch → generic 500.

- [ ] 5. Rewire `POST /api/webhooks/whatsapp` to per-app signature verification via a bounded candidate-secret set.
      Implement the load-bearing step order from design §4 exactly: (1) `const raw = await request.text()`
      (unchanged, read once); (2) signature-header gate FIRST — require `x-hub-signature-256` starting with
      `sha256=`, else warn + 401 with NO parse and NO DB query (remove today's unconditional
      `META_APP_SECRET`-missing 401 that precedes the header check); keep `theirHex`/`a` buffer; (3) parse the
      raw body in try/catch ONLY to collect candidate `phone_number_id`s via a `Set`, capped at
      `MAX_CANDIDATE_PHONE_IDS = 10` (unparseable → `[]`); (4) build `secrets: Set<string>` = platform
      `META_APP_SECRET` (if set) + for each owning tenant of the capped ids
      (`prisma.whatsAppNumber.findMany({ where: { phoneNumberId: { in } }, select: { userId: true } })` then
      `prisma.tenantMetaApp.findMany({ where: { userId: { in } }, select: { metaAppSecret: true } })`), the
      `decrypt`ed `metaAppSecret`, skipping any candidate whose `decrypt()` throws (no log, no crash) — import
      `decrypt` from `@/lib/crypto`; do NOT call `resolveMetaAppCredentials` here (keep skip-bad-candidate
      semantics); (5) if `secrets.size === 0` → 401 (relocated "no usable secret"); (6) for each candidate
      compute `HMAC-SHA256(raw, secret)` hex and compare with the existing length-guarded
      `crypto.timingSafeEqual`, set `verified=true` on first match; if none match → warn + 401;
      (7) on `verified`, fall through to the UNCHANGED `const body = JSON.parse(raw)` processing loop (statuses,
      inbound messages, strict `phone_number_id → WhatsAppNumber` routing, conversation upsert, always-200). The
      GET handshake is unchanged. No secret/ciphertext is ever logged on any branch.
      Files: `src/app/api/webhooks/whatsapp/route.ts`
      Verify: `npm run build` passes. Reason through §4 safety + error table: missing/malformed header → 401
      with zero DB work; `IN` bounded ≤10; platform-secret body verifies when `META_APP_SECRET` set; a
      tenant-secret body verifies against their secret even if platform secret unset (intended FR-4/AC-5
      change); wrong-secret and `secrets.size===0` → 401; undecryptable candidate skipped; processing errors
      still return 200.

- [ ] 6. Create the tenant Meta App settings API `src/app/api/meta-app/route.ts` (GET/PUT/DELETE).
      Implement per design §5. Session guard (`getServerSession(authOptions)`, 401 if no `session.user.id`),
      `userId`-scoped only (never client-supplied id), `zod` validation, `NextResponse.json`. Add the internal
      `serializeMetaApp(row: TenantMetaApp | null)` helper returning `{ appId, configId, source, hasSecret }`
      from row presence (never selects/returns the ciphertext; `hasSecret` means "stored", not "valid" — does
      NOT decrypt). GET: `findUnique({ where: { userId } })` → `serializeMetaApp(row)`. PUT: zod
      `{ metaAppId: string.trim().min(1).max(100), metaAppSecret: string.min(10).max(500).optional(),
      configId: string.trim().min(1).max(100).nullish() }`, 400 with `parsed.error.flatten()` in `details` on
      failure; cheap existence check `findUnique({ where:{userId}, select:{id:true} })` → if no row and no
      secret, 400 `{ error: "App secret is required to connect your Meta app" }`; build `update` payload
      (`metaAppId` always; `metaAppSecret: encrypt(...)` only if present; `configId` only if `!== undefined` —
      null clears, string sets); call atomic `prisma.tenantMetaApp.upsert({ where:{userId},
      create:{ userId, metaAppId, metaAppSecret: encrypt(metaAppSecret!), configId: configId ?? null }, update })`;
      return `serializeMetaApp(row)` with 200. DELETE:
      `prisma.tenantMetaApp.deleteMany({ where: { userId } })` (idempotent) → `{ ok: true }` 200. Top-level
      try/catch → 500 `{ error: "Internal server error" }`, never logging the secret. Import `encrypt` from
      `@/lib/crypto`, `prisma` from `@/lib/db`, `authOptions` from `@/lib/auth`, `z` from `zod`.
      Files: `src/app/api/meta-app/route.ts`
      Verify: `npm run build` passes. Reason through §5 error table + testability: no session → 401 all methods;
      PUT create requires secret; PUT update omitting secret preserves it (secret absent from `update` payload);
      PUT `configId: null` clears, omitted leaves unchanged; GET never contains a secret field; concurrent PUT
      is race-free via `upsert`; DELETE idempotent.

- [ ] 7. Create the tenant Meta App settings UI page `src/app/dashboard/settings/page.tsx`.
      Per design §6. New `"use client"` page (the sidebar already links `/dashboard/settings`; no page exists
      yet). Use existing `Card`/`CardContent`/`CardHeader`/`CardTitle`/`CardDescription`, `Input`, `Label`,
      `Button` primitives (same import paths as the connect page). On mount `GET /api/meta-app`; populate
      `metaAppId` + `configId` inputs with returned effective values; secret field always empty
      (`type="password"`, never pre-filled); helper line "Secret is stored" when `hasSecret && source==="tenant"`,
      else "No tenant secret stored (using platform app)"; source badge "Using your own app" vs "Using platform
      app" from `source`. Save → `PUT /api/meta-app` sending `metaAppSecret` ONLY if the user typed one, and
      `configId` per §5 rule (string when set, `null` when clearing a previously-set value, omit when
      untouched). Clear/Disconnect → `DELETE /api/meta-app` then re-fetch. Surface API errors (including a 401)
      inline in the same red-box pattern as the connect page; do NOT self-redirect (the `/dashboard`
      server-layout guard is the auth boundary). Never render the secret back.
      Files: `src/app/dashboard/settings/page.tsx`
      Verify: `npm run build` passes (page compiles, no server-only imports in the client component). Reason
      through §6: load reflects `hasSecret`/`source`; empty secret field preserves stored secret on save;
      clear reverts to `source:"platform"`.

- [ ] 8. Switch the connect page to a runtime effective-config fetch from `GET /api/meta-app`.
      Per design §7. In `src/app/dashboard/numbers/add/page.tsx`: remove the module-level
      `const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID` / `META_CONFIG_ID` reads. Add
      `const [cfg, setCfg] = useState<{ appId: string | null; configId: string | null } | null>(null)`; in a
      mount `useEffect`, `fetch("/api/meta-app")` and set `cfg` to `{ appId, configId }`. Keep the
      `WA_EMBEDDED_SIGNUP` message listener. Gate FB SDK init/script-injection on `cfg?.appId` (make the init
      effect depend on `cfg`), calling `window.FB.init({ appId: cfg.appId, ... })` with the fetched value.
      `handleConnect` uses `cfg?.appId`/`cfg?.configId`; when either is absent keep the EXACT existing message
      verbatim ("Embedded Signup is not configured yet. Set NEXT_PUBLIC_META_APP_ID and
      NEXT_PUBLIC_META_CONFIG_ID, or enter credentials manually.") — do NOT reword it (AC-7). `FB.login` uses
      `config_id: cfg.configId`. The manual-credentials form and its `/api/numbers/manual` submission are
      untouched and MUST remain gated only on `showManual` (never on `cfg`), so a null/failed `cfg` never hides
      the manual path. Preserve the `sdkReady` / "Facebook SDK is still loading" guard. On a failed/500 fetch,
      treat as "not configured" (show message, keep manual path), do not crash.
      Files: `src/app/dashboard/numbers/add/page.tsx`
      Verify: `npm run build` passes. Reason through §7: configured `cfg` drives FB init/login at runtime (no
      rebuild for a tenant's own app); absent `cfg` shows the verbatim message; manual form always reachable.

- [ ] 9. Update `.env.example` to document the platform vars as the Model A fallback and fix the stale claims.
      Per design §8. Reframe the `META_APP_ID`/`META_APP_SECRET` block as the platform (Model A) fallback used
      only when a tenant has no `TenantMetaApp` row (Model B overrides). Note `META_WEBHOOK_VERIFY_TOKEN` stays
      platform-level/shared (per-tenant GET handshake is out of scope; only POST signature verification becomes
      per-app). In the "Client-exposed Meta values" block, REPLACE the false sentence that the Config ID is
      "only ever read client-side" with wording that `NEXT_PUBLIC_META_CONFIG_ID` is read both at build time
      (client bundle) AND server-side by `resolveMetaAppCredentials` / `GET /api/meta-app`, and that the connect
      page fetches the effective config id at runtime so a tenant's own Config ID overrides it without a
      rebuild; soften the adjacent "requires a REBUILD" sentence to scope it to the inlined client constant
      only. In the Meta-side-prerequisites footer, correct the Configuration-ID bullet (no longer client-only)
      and correct the `META_APP_SECRET` line to say it verifies platform-app (Model A) tenants' webhooks while
      Model B tenants verify against their own secret (keep it set so platform-app delivery updates aren't 401'd).
      Keep the `ENCRYPTION_KEY` block as-is. Introduce NO new env var. Placeholders only — no real values.
      Files: `.env.example`
      Verify: Review that no stale "only ever read client-side" / unconditional-`META_APP_SECRET`-mandatory
      wording remains and no new env var was added. (`npm run build` does not read `.env.example`; this is a
      doc-accuracy review against §8.)

- [ ] 10. Update `scratchpad.md` to reflect the new feature, endpoint, schema, and env semantics.
      Per the global scratchpad rule. Refresh `Last updated:`. Add `TenantMetaApp` to a Schema section;
      add `GET/PUT/DELETE /api/meta-app` to the Backend endpoints table; document `src/lib/meta-app.ts`
      (`resolveMetaAppCredentials`, precedence tenant→platform, `MetaAppConfigError`) in Architecture; update
      the "Onboarding paths" and webhook notes to describe per-app (bounded candidate-secret) signature
      verification and the runtime effective-config fetch on the connect page; correct the "NO server-side
      META_CONFIG_ID" note to match §8; add a Settings UI entry (`/dashboard/settings`); note the Model A/B
      fallback model and that no new env var was added. Prepend a dated Change log entry (newest first)
      summarizing this feature.
      Files: `scratchpad.md`
      Verify: Doc review — the new model, endpoint, resolver, webhook change, connect-page change, and settings
      page are all represented and the stale client-only Config ID note is corrected; a dated Change log entry
      is present at the top.

- [ ] 11. Final regression + build gate.
      Run the full project build and reason through the no-regression contract (AC-10 / NFR-5): a tenant with no
      `TenantMetaApp` row behaves exactly as today for embedded signup (platform branch), webhook verification
      (platform secret in candidate set), sends (`resolveSendCredentials` untouched), template routes
      (`resolveWabaCredentials` untouched), and manual connect (`/api/numbers/manual` untouched);
      `serializeNumber` still strips `accessToken`. No new runtime dependency was added (NFR-4).
      Files: (none — verification only)
      Verify: `npm run build` (= `prisma generate && next build`) completes successfully with no type errors.
      Confirm `package.json` dependencies are unchanged from baseline (no new runtime dep). Confirm the three
      resolver consumers (embedded-signup, webhook, settings API) all route through the single source of truth
      for app-credential logic as designed.
