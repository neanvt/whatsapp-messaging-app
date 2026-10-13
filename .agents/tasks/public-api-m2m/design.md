# Design — Public server-to-server (M2M) API with per-tenant API keys

Last updated: 2026-10-13
Status: Revised (iteration 3 — all 6 findings from the iteration-2 `design-review.json` resolved; see "Responses to design review" at the end. The earlier iteration-2 responses to the first review are retained below under "Responses to design review (iteration 1)".)

## Overview

This feature adds a machine-to-machine (M2M) public API under `/api/v1`, authenticated by per-tenant API keys sent as `Authorization: Bearer wa_live_...`. A tenant mints a key from the dashboard, binds it to exactly one of their verified `WhatsAppNumber` records, and pastes **only** that key plus the platform base URL into their third-party server. The platform resolves the owning user and the bound number from the key, fills in the Meta `phoneNumberId` + decrypted access token server-side via the existing `resolveSendCredentials`, and calls the Meta Cloud API. The third party never handles a Phone Number ID, WABA ID, access token, or any Facebook credential.

The core architectural move is a **shared send helper** (`sendTemplateMessage`) extracted byte-for-byte from the current `POST /api/messages/send/route.ts` logic, called by both the existing session route and the new public route so the two paths can never drift. Everything else (ApiKey model + migration, the auth helper, the three public routes, the dashboard management routes + page, and the docs update) is additive and sits beside the existing session-cookie world without changing it.

The stack is **locked** to what the repo already uses: Next.js 14 App Router, TypeScript, Prisma 5.x with the libSQL/Turso driver adapter, NextAuth (session cookie for the dashboard), zod for request validation, Tailwind + the existing `@/components/ui/*` primitives, and Node's built-in `crypto`. **No new dependencies.** DB schema changes ship via an idempotent `@libsql/client` script, never `prisma db push`.

## Module boundaries and data flow

Two authentication worlds, strictly separated (per A6):

| Surface | Auth | Who calls it |
| --- | --- | --- |
| `/api/v1/*` (public) | API key only (`authenticateApiKey`) | third-party servers |
| `/api/api-keys/*` (management) | session cookie only (`getServerSession`) | the dashboard UI |
| existing `/api/*` routes | session cookie only (unchanged) | the dashboard UI |

New / changed modules:

```
prisma/schema.prisma                      (edit: add ApiKey model + User/WhatsAppNumber relations)
scripts/add-api-key-table.mjs             (new: idempotent libSQL migration)
src/lib/api-key.ts                        (new: generateApiKey, hashKey, looksLikeApiKey, isSuperAdminUser — pure, no DB)
src/lib/api-auth.ts                       (new: authenticateApiKey(request), unauthorized() helper)
src/lib/send-template.ts                  (new: shared sendTemplateMessage(...) — the extracted send core)
src/app/api/messages/send/route.ts        (edit: becomes a thin session wrapper over sendTemplateMessage)
src/app/api/v1/messages/route.ts          (new: POST — public template send)
src/app/api/v1/messages/[id]/route.ts     (new: GET — public message status)
src/app/api/v1/templates/route.ts         (new: GET — public template list)
src/app/api/api-keys/route.ts             (new: GET list, POST create — session)
src/app/api/api-keys/[id]/route.ts        (new: DELETE revoke — session)
src/app/dashboard/api-keys/page.tsx       (new: management UI)
src/components/dashboard/sidebar.tsx      (edit: add "API Keys" nav link)
src/app/docs/page.tsx                     (edit: add M2M section + correct the "no API-key scheme" note)
```

> Note on the task-prompt filename `src/lib/api-auth.ts` vs the requirements' `src/lib/api-key.ts`: this design uses **both**, with a clean split — `src/lib/api-key.ts` holds pure key generation/hashing (no DB, trivially unit-testable), and `src/lib/api-auth.ts` holds `authenticateApiKey(request)` (DB + request parsing). This satisfies FR2.1/FR2.6 and the task prompt's named file; the two files import cleanly (`api-auth` imports `hashKey` from `api-key`).

High-level request flow for a public send:

```
third-party server
  → POST /api/v1/messages  (Authorization: Bearer wa_live_xxx, body {recipient, templateName|templateId, variables?})
    → authenticateApiKey(request)
        → parse "Bearer <token>", shape-check wa_live_, sha256(token)
        → prisma.apiKey.findUnique({ where: { keyHash } }), reject if null or revokedAt set
        → timingSafeEqual(computedHash, row.keyHash)
        → load bound WhatsAppNumber (row.whatsappNumberId)
        → best-effort update lastUsedAt
        → return { userId, apiKey, number }    (or null → 401)
    → validate body (zod), resolve template by {userId, name|id, status:"approved"}
    → sendTemplateMessage({ userId, number, template, recipient, variables, isSuperAdmin })
        → (identical core: auth-template OTP guard, credit check/deduct, Message create,
           resolveSendCredentials, Meta fetch, status update, refund-on-failure)
    → return { id, status, metaMessageId? }
```

## 1. ApiKey data model and migration

### 1.1 Prisma model (edit `prisma/schema.prisma`)

Add the model and the two inverse relations. Field names, nullability, and defaults mirror the existing `TenantMetaApp` style (cuid id, `@default(now())`, `@updatedAt`, cascade on `User`).

```prisma
model ApiKey {
  id               String         @id @default(cuid())
  userId           String
  user             User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  whatsappNumberId String
  whatsappNumber   WhatsAppNumber @relation(fields: [whatsappNumberId], references: [id], onDelete: Cascade)
  name             String?        // tenant-chosen display label
  keyPrefix        String         // non-secret display fragment, e.g. "wa_live_ab12"
  keyHash          String         @unique // SHA-256 hex of the full key; never plaintext
  lastUsedAt       DateTime?
  revokedAt        DateTime?
  createdAt        DateTime       @default(now())
  updatedAt        DateTime       @updatedAt

  @@index([userId])
}
```

Add the inverse relation fields:

- `User`: `apiKeys ApiKey[]`
- `WhatsAppNumber`: `apiKeys ApiKey[]`

Decisions, with reasoning:

- **`keyHash @unique` only — no standalone `@@index([keyHash])`** (resolves iteration-1 review finding 6 — NIT). The `@unique` on `keyHash` already produces a unique index, which is the functional index the hash lookup uses, and it satisfies the task prompt's "index keyHash" instruction. The earlier draft kept a redundant `@@index([keyHash])` in the model while the migration created only the unique index; that made Prisma's schema metadata and the live DB diverge (Prisma would expect a second index the DB does not have). The redundant line is **removed** so schema and DB agree. The model therefore declares `keyHash @unique` and `@@index([userId])`; the migration creates exactly `CREATE UNIQUE INDEX ... ApiKey_keyHash_key` and `CREATE INDEX ... ApiKey_userId_idx` — one-to-one with the schema.
- **`onDelete: Cascade` on both relations.** Deleting a user or a number removes its keys. libSQL does not enforce FKs, so (as with `TenantMetaApp`) cascade is a Prisma-client behavior only; the migration DDL carries no `FOREIGN KEY`. This matches the established pattern and A5/FR1.2.
- **`name String?` (nullable).** The dashboard create flow treats name as optional at the model level even though the management route may require it (FR4.2 says required at the API layer). Keeping the column nullable avoids a non-null migration default and lets the API own the "required" rule. (Design decision reconciling task-prompt `name String?` with FR4.2: the DB column is nullable; `POST /api/api-keys` validates `name` as required via zod. The stricter rule lives at the layer that owns user input.)
- **`whatsappNumberId` is non-null and immutable** (A5): there is no update endpoint; retarget = revoke + recreate.

### 1.2 Migration script (`scripts/add-api-key-table.mjs`)

Clone `scripts/add-tenant-meta-app-table.mjs` exactly in mechanics: manual `.env` parse, `createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN })`, `PRAGMA table_info` existence probe for the log line, `CREATE TABLE IF NOT EXISTS`, `CREATE ... INDEX IF NOT EXISTS`, `catch → console.error(non-secret) → process.exit(1)`, `client.close()` in `finally`. Timestamps are plain `TEXT NOT NULL` with no SQL default (Prisma supplies `@default(now())`/`@updatedAt`). Nullable columns (`name`, `lastUsedAt`, `revokedAt`) are `TEXT` without `NOT NULL`.

```sql
CREATE TABLE IF NOT EXISTS ApiKey (
  id               TEXT PRIMARY KEY NOT NULL,
  userId           TEXT NOT NULL,
  whatsappNumberId TEXT NOT NULL,
  name             TEXT,
  keyPrefix        TEXT NOT NULL,
  keyHash          TEXT NOT NULL,
  lastUsedAt       TEXT,
  revokedAt        TEXT,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ApiKey_keyHash_key ON ApiKey (keyHash);
CREATE INDEX IF NOT EXISTS ApiKey_userId_idx ON ApiKey (userId);
```

The index names match Prisma's own naming (`<Model>_<field>_key` for unique, `<Model>_<field>_idx` for non-unique) so a later `prisma generate` + introspection stays consistent. A second run is a clean no-op (all three statements are `IF NOT EXISTS`) and exits 0 (AC1).

**Probe and index idempotency (resolves iteration-2 review finding 5 — NIT).** The reference script runs a single `PRAGMA table_info(TenantMetaApp)` to choose its "already exists" vs "created" log line, then runs its `CREATE TABLE` + one `CREATE INDEX` unconditionally (both `IF NOT EXISTS`). This script, which must create **two** indexes, keeps the same structure: the existence probe is **one** `PRAGMA table_info(ApiKey)` whose only purpose is the log line (`info.rows.length > 0` → "ApiKey table already exists. Skipping." else "ApiKey table created."), and **all three** DDL statements — the `CREATE TABLE IF NOT EXISTS` and **both** `CREATE ... INDEX ... IF NOT EXISTS` (unique on `keyHash`, non-unique on `userId`) — run **unconditionally** every time. There is no per-index probe; `IF NOT EXISTS` on each statement is what makes the second run a no-op, independent of the single table probe. This preserves AC1 (exit 0, no error, no duplicate on re-run) regardless of partial prior state (e.g. table exists but an index was somehow missing — the unconditional `CREATE INDEX IF NOT EXISTS` fills it in).

The schema change is applied **only** via this script (FR1.5); `prisma db push` is never run against the live libSQL DB. `prisma generate` (inside `npm run build`) picks up the model for the typed client.

## 2. Key format, generation, and hashing (`src/lib/api-key.ts`)

Pure functions, no DB, no request — trivially unit-testable (NFR, testability).

```ts
import crypto from "crypto";

const PREFIX = "wa_live_";

// FR2.6 / A1 / NFR3: 32 random bytes (256 bits) base64url-encoded (no padding),
// prefixed with the human-readable, non-secret label. The full string is the secret.
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const random = crypto.randomBytes(32).toString("base64url"); // ~43 url-safe chars
  const plaintext = PREFIX + random;
  const hash = hashKey(plaintext);
  // keyPrefix = non-secret display fragment: label + first 4 chars of the random part.
  const prefix = PREFIX + random.slice(0, 4);
  return { plaintext, hash, prefix };
}

// SHA-256 hex of the full presented key. Deterministic (A2): lookup is by this value.
export function hashKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

// Cheap shape gate so a malformed/foreign token never hits the DB (edge case: 401 w/o lookup).
// 32 random bytes base64url-encode (no padding) to exactly 43 chars, so a well-formed key is
// PREFIX + 43 chars. The floor is set to that real encoded length, not the raw byte count
// (resolves iteration-2 review finding 6 — NIT). This is only a shape filter: a token that
// passes still has to match the SHA-256 lookup, which is the real gate.
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(PREFIX) && token.length >= PREFIX.length + 43;
}
```

Decisions:

- **`base64url` (not hex) for the random portion** — denser (43 chars for 32 bytes vs 64), URL-safe, no padding. The `keyPrefix` for display is `wa_live_` + the first 4 random chars (the task prompt's "`wa_live_` + 4 chars"). Showing 4 chars of a 256-bit secret leaks negligible entropy and is only ever used to help a tenant tell two keys apart in the list.
- **SHA-256, unsalted, deterministic** (A2): because we must look a row up by hash (no plaintext stored and no username to scope by), the hash must be deterministic. 256 bits of input entropy makes a precomputation/rainbow attack infeasible, so a per-key salt (which would break O(1) lookup) is unnecessary. A `timingSafeEqual` on the hash is still applied in the auth helper as defense in depth (NFR2).
- **Never log** the plaintext, the hash, or the random bytes anywhere in this module (NFR1).

## 3. Auth helper (`src/lib/api-auth.ts`)

```ts
import { NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/db";
import { hashKey, looksLikeApiKey } from "@/lib/api-key";
import type { WhatsAppNumber, ApiKey } from "@prisma/client";

export interface ApiKeyContext {
  userId: string;
  apiKey: ApiKey;
  number: WhatsAppNumber;
}

export async function authenticateApiKey(request: Request): Promise<ApiKeyContext | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return null;                       // missing/malformed → 401
  const token = match[1].trim();
  if (!looksLikeApiKey(token)) return null;      // wrong shape → 401, no DB hit

  const computedHash = hashKey(token);
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: computedHash } });
  if (!apiKey) return null;                       // unknown key → 401
  if (apiKey.revokedAt) return null;              // revoked → 401

  // Defense-in-depth constant-time compare (NFR2). Equal-length hex buffers.
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(apiKey.keyHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const number = await prisma.whatsAppNumber.findUnique({
    where: { id: apiKey.whatsappNumberId },
  });
  if (!number) return null;                       // bound number vanished → 401

  // Best-effort lastUsedAt (FR2.5 / edge case): never block or fail the request.
  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => { /* swallow — do not log the key */ });

  return { userId: apiKey.userId, apiKey, number };
}

// Shared 401 responder used by all /api/v1 routes.
export function unauthorized() {
  return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
}
```

Decisions:

- **Return `null` for every auth failure**, and let each route turn `null` into `unauthorized()` (401). This keeps the helper branch-free for callers and never distinguishes "unknown key" from "revoked" from "malformed" in the response (no oracle; all 401, FR2.2 / AC12).
- **`lastUsedAt` update is fire-and-forget** (not awaited) so a write failure cannot fail the send (edge case). It is dispatched before returning; the request proceeds regardless.
- **The bound number is loaded here**, so routes receive a ready `number` for `resolveSendCredentials`. If the number was deleted out from under the key, that is a 401 (the key is unusable). A number that still exists but was *unverified/disconnected* is NOT a 401 here — that case is handled downstream in the send (null-credential → failed + refund), matching the session route.
- **No logging of token/hash** anywhere (NFR1, AC16).

## 4. Shared send helper (`src/lib/send-template.ts`) — the exact refactor

This is the risk center: the session route must stay byte-for-byte equivalent. The strategy is **extract, don't rewrite**. The body of the current `POST /api/messages/send/route.ts` from the point *after* its own 401/400 input checks is lifted verbatim into a function; the session route then becomes a thin wrapper that does its session-specific validation and calls the function. The public route does its key-specific validation and calls the same function.

### 4.1 Helper signature and contract

```ts
import prisma from "@/lib/db";
import { resolveSendCredentials } from "@/lib/whatsapp";
import type { WhatsAppNumber, Template } from "@prisma/client";

export interface SendTemplateInput {
  userId: string;
  number: WhatsAppNumber;      // already verified + owned by userId by the caller
  template: Template;          // already resolved + approved + owned by userId by the caller
  recipient: string;
  variables?: string[];
  isSuperAdmin: boolean;       // caller supplies; computed ONCE by the caller — see contract below
}

export type SendTemplateResult =
  | { ok: true;  message: { id: string; status: "sent"; metaMessageId: string | null } }
  | { ok: false; code: number; error: string };   // code ∈ {400, 402/403, 500}
```

**`isSuperAdmin` contract (resolves iteration-1 review finding 3 — MEDIUM).** `isSuperAdmin` is computed **exactly once by the caller** and passed in as a plain boolean. The helper uses that single passed value for all three credit decisions — the pre-send check (step 2), the deduct (step 4), and the refund (step 10) — and **must never re-derive it** (no second DB read, no re-reading a role mid-request). This guarantees deduct and refund stay symmetric: if the deduct ran, the refund runs, and vice versa, even if the owner's role were to change between calls. The session wrapper computes it from `session.user.role` (already email-driven at session issue time); the public route computes it via `isSuperAdminUser` (§4.4). Both feed the identical boolean through the identical helper.

The helper owns everything that today lives in the send route *below* the number/template/credits input validation:

1. **Auth-template OTP guard** (early 400): `if (template.category === "authentication" && !variables?.[0]) return { ok:false, code:400, error:"OTP code variable required for authentication template" }`. This runs **before** any message row or credit change (AC7).
2. **Credits check** (non-superadmin): load `UserCredits`, if missing or `totalCredits <= 0` → `{ ok:false, code:<credits code>, error:"Insufficient credits" }` *before* creating a message or contacting Meta (AC9).
3. **Message create** (`status:"queued"`, with `whatsappNumberId: number.id`, `templateId: template.id`, `recipientPhone: recipient`, serialized `templateVariables`).
4. **Credit deduct** (non-superadmin: `totalCredits -1`, `usedCredits +1`).
5. **Credential resolve** via `resolveSendCredentials(number)` wrapped in try/catch → nulls on throw (preserves the `ENCRYPTION_KEY`/decrypt-throw edge case).
6. **Null-credential branch** (bound number has no stored creds — unverified/disconnected after bind, or `resolveSendCredentials` threw on a decrypt/`ENCRYPTION_KEY` error): set `finalStatus="failed"`, `errorMessage = "WhatsApp number is not connected. Reconnect it to send messages."` — the identical message the session route uses. The message row is updated to `failed` and the credit is **refunded** (step 10), and the helper returns **`{ ok:false, code:500, error:"WhatsApp number is not connected. Reconnect it to send messages." }`** (resolves iteration-1 review finding 2 — MEDIUM). This is the same 500 the session route returns for this case (verified in `send/route.ts`: the failed branch returns status 500 after refund), so parity is preserved. It is a **distinct** failure from a Meta non-2xx (step 8), but both resolve to `code:500` after refund.
7. **Meta payload build** including the `#131008` auth-template copy-code URL button: `{ type:"button", sub_type:"url", index:"0", parameters:[{ type:"text", text: variables[0] }] }`, keyed on `variables?.[0]`.
8. **Meta fetch** to `https://graph.facebook.com/v19.0/{phoneNumberId}/messages`, capture `metaMessageId` from `metaData.messages?.[0]?.id`.
9. **Message update** (`status`, `sentAt` when sent, `metaMessageId`, `errorMessage`).
10. **Refund on failure** (non-superadmin: `totalCredits +1`, `usedCredits -1`, using the same single `isSuperAdmin` boolean from step 4) and return `{ ok:false, code:500, error:... }`. Both failure causes map to `code:500`: the **not-connected / null-credential** branch (step 6, error "WhatsApp number is not connected. Reconnect it to send messages.") and the **Meta non-2xx** branch (step 8, error = Meta's message or "Failed to send via Meta API"). The two are distinguished only by the `error` string, not the code — matching the session route, which returns 500 for both.
11. **Success** → `{ ok:true, message:{ id, status:"sent", metaMessageId } }`.

The copy-paste is literal: the console logs (`[Meta] Sending message:`, `[Meta] Message sent, id:`), the `recipient.replace(/\D/g, "")` normalization, the `language.code ?? "en"`, and the exact credit arithmetic all move unchanged. The helper **does not** read the session and **does not** build an HTTP response — it returns a plain result object, so both callers map it to their own `NextResponse`.

### 4.2 Credit-insufficient status code (resolve the 402/403 ambiguity)

The requirements leave 402 vs 403 open (FR3, AC9). **Decision: the shared helper returns `code: 402` for insufficient credits.** `402 Payment Required` is the semantically correct code for "out of balance / top up to proceed," and it cleanly distinguishes a billing stop from an authorization stop (403) in a third party's error handling. The **session route maps the helper's `code:402` back to its original `400`** (see 4.3) so the dashboard behavior is unchanged (NFR6/AC15); only the new public route surfaces 402. This keeps the session route byte-for-byte in observable behavior while giving the public API a correct, documented billing code.

> Implementation detail: the helper returns a small discriminated result; the session wrapper remaps `402 → 400` and `else → the helper code`. This is the one deliberate asymmetry and it exists solely to preserve legacy behavior.

### 4.3 Session route after refactor (`src/app/api/messages/send/route.ts`)

```ts
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { numberId, recipient, templateId, variables } = body;
    if (!numberId || !recipient || !templateId)
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });

    const number = await prisma.whatsAppNumber.findFirst({
      where: { id: numberId, userId: session.user.id, verificationStatus: "verified" },
    });
    if (!number) return NextResponse.json({ error: "Invalid or unverified WhatsApp number" }, { status: 400 });

    const template = await prisma.template.findFirst({
      where: { id: templateId, userId: session.user.id, status: "approved" },
    });
    if (!template) return NextResponse.json({ error: "Template not found or not approved" }, { status: 400 });

    const result = await sendTemplateMessage({
      userId: session.user.id,
      number,
      template,
      recipient,
      variables,
      isSuperAdmin: session.user.role === "superadmin",
    });

    if (!result.ok) {
      // Preserve legacy observable codes for the dashboard: insufficient-credits was 400 here.
      const code = result.code === 402 ? 400 : result.code;
      return NextResponse.json({ error: result.error }, { status: code });
    }
    return NextResponse.json({ id: result.message.id, status: "sent", message: "Message sent successfully" });
  } catch (error) {
    console.error("Error sending message:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
```

Every observable detail of the old route is retained: the four input-field 400s, the number/template 400s, the OTP 400 (now inside the helper but with the identical message and ordering), the insufficient-credits 400, the Meta-failure 500 with the refund already applied, and the success body `{ id, status:"sent", message:"Message sent successfully" }`. The one guard that moves is the OTP check: it was between the template check and the credits check in the original; the helper runs it first (still before any credit/message mutation), so the externally observable ordering (OTP 400 before credits 400 before any side effect) is preserved.

### 4.4 Shared superadmin predicate (`isSuperAdminUser`) — resolves iteration-1 review finding 1

Superadmin status in this app is **email-driven**, decided in the NextAuth JWT callback (`src/lib/auth.ts`): a user is superadmin iff their email equals `process.env.SUPERADMIN_EMAIL || "neanvtech@gmail.com"`, OR (defensively) their stored `role` is already `"superadmin"`. The DB `role` column is never set to `"superadmin"` anywhere in the codebase (the admin-users route only grants `"admin"`), so a public-path lookup that trusts only `role` would misclassify the superadmin as a regular tenant and charge them credits — breaking A3/AC8/NFR6.

To make the rule a single source of truth across both auth worlds, add a tiny pure predicate. Place it in `src/lib/api-key.ts` (already a dependency-free helper module imported by both the public route and, if desired, usable by `auth.ts`):

```ts
// Mirrors the superadmin rule in src/lib/auth.ts (JWT callback). Email override OR explicit role.
// Both fields are typed non-nullable to match the schema and the §5.1 `select`:
// User.email is `String @unique` (NOT NULL) and User.role is `String @default("admin")` (NOT NULL),
// so a persisted user never has a null email or role (resolves iteration-2 review finding 4 — NIT:
// no impossible `| null` case in the predicate type).
export function isSuperAdminUser(user: { email: string; role: string }): boolean {
  const superAdminEmail = process.env.SUPERADMIN_EMAIL || "neanvtech@gmail.com";
  return user.email === superAdminEmail || user.role === "superadmin";
}
```

The public `POST /api/v1/messages` route calls this once with the key owner's `{ email, role }` (selected from `prisma.user.findUnique`) and passes the resulting boolean to `sendTemplateMessage`. The session route continues to use `session.user.role === "superadmin"`, which is correct there because the session role was already computed via the same email rule at login — the two therefore agree for the same user. (Optional, not required: `auth.ts` could be refactored to call `isSuperAdminUser` too, further guaranteeing no drift; this is noted but left out of the required scope to keep the auth callback untouched and avoid regression risk.)

Decision: the predicate lives in `api-key.ts` (not `auth.ts`) to avoid importing the NextAuth-coupled module into the public path, and because it is pure (env + plain fields), trivially unit-testable, and already the home of the other pure crypto helpers.

## 5. Public `/api/v1` routes (API-key auth only)

All three start with `const ctx = await authenticateApiKey(request); if (!ctx) return unauthorized();` and never read a session (A6). Validation uses zod with a 400 on failure before any side effect (NFR8). Each wraps its body in try/catch → 500.

### 5.1 `POST /api/v1/messages` (`src/app/api/v1/messages/route.ts`)

Request body (zod):

```ts
const Body = z.object({
  recipient: z.string().min(1),
  templateName: z.string().min(1).optional(),
  templateId: z.string().min(1).optional(),
  variables: z.array(z.string()).optional(),
}).refine((b) => !!b.templateName !== !!b.templateId, {
  message: "Provide exactly one of templateName or templateId",
});
```

The refine uses XOR (`!!a !== !!b`) so sending **both** `templateName` and `templateId`, or **neither**, is a 400 — there is no silent precedence rule.

> **On the `templateName`/`templateId` contract (resolves iteration-2 review finding 1 — MEDIUM).** The step task prompt mandates the public send body `{recipient, templateName|templateId, variables?}` and "resolve template by key.userId + name/id". The earlier requirements FR3.1.2/FR3.1.4 specified only `templateId`, so this design previously *widened* the spec silently. Rather than drop `templateName` (which the task prompt requires), the authoritative contract was fixed at the source: **requirements.md FR3.1.2/FR3.1.4 were updated** to specify "exactly one of `templateName` or `templateId`" (with a matching edge-case bullet and acceptance note). The design now *conforms to* that requirement rather than overriding it. The DX rationale: a third party integrating by human-readable template name should not have to look up the platform's internal template id first; both keys resolve the same `approved`, owner-scoped `Template`.

- The body **does not** accept `numberId`/`phoneNumberId`. The send always uses `ctx.number` (the key's bound number), ignoring any client-supplied number field entirely (FR3.1.2, AC6).
- **Template resolution** (FR3.1.4): `prisma.template.findFirst({ where: { userId: ctx.userId, status:"approved", ...(templateId ? { id: templateId } : { name: templateName }) } })`. Not found / not approved / not owned → **404** (not found) or **400** (exists but not approved), matching the session route's "Template not found or not approved" semantics; to mirror the session route's single 400 for both, this route returns **404** when no row matches the owner+name/id at all, and **400** when a row matches but status ≠ approved. (Resolved: the session route conflates both into 400; the public API splits them because a REST client benefits from 404-vs-400, and the acceptance criteria explicitly allow 404 for not-found/owned and 400 for not-approved — edge-case list.)
- **Bound-number guard** (FR3.1.3): `ctx.number` must be `verificationStatus === "verified"`. If it is not (unverified/disconnected after key creation), do **not** 400 up front — defer to the send helper's null-credential branch, which fails the message and refunds, mirroring the session route. (Decision: the session route's up-front "verified" check is a *query filter*, not a hard gate on an already-bound number; for the public key the number was verified at bind time, so a later unverify is a runtime send failure, not a request-shape error. This keeps the refund path identical to the session null-credential case per the edge-case list.)
- **Superadmin flag** (resolves iteration-1 review finding 1 — HIGH): the session route derives superadmin from `session.user.role`, and that session value is **email-driven**, not read from the DB `role` column. Verified in `src/lib/auth.ts` (JWT callback): `token.role = user.email === (process.env.SUPERADMIN_EMAIL || "neanvtech@gmail.com") ? "superadmin" : (user.role ?? "admin")`. Verified further that nothing in the codebase ever writes `role = "superadmin"` to the DB (`src/app/api/admin/users/[id]/route.ts` only ever grants `"admin"`, and no seed/script sets superadmin), so the superadmin's stored `role` column is `"admin"`. A naive `owner.role === "superadmin"` lookup would therefore read `"admin"` and **charge the superadmin a credit on every public send**, breaking A3 / AC8 / NFR6. The public route must apply the same email-override rule as the session. To guarantee the two paths cannot drift, this is factored into a single shared predicate `isSuperAdminUser({ email, role })` (see §4.4) used by the public route:

  ```ts
  const owner = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { email: true, role: true },
  });
  const isSuperAdmin = isSuperAdminUser(owner); // email override OR role === "superadmin"
  ```

  This value is computed **exactly once** here and passed to `sendTemplateMessage`; the helper never re-derives it (resolves iteration-1 review finding 3 — see §4.1). Passing a single boolean through the check, deduct, and refund keeps the credit math symmetric regardless of the underlying rule, and makes this call site the single point of truth for the public path.
- Call `sendTemplateMessage(...)`. Map the result:
  - `ok:true` → `200 { id, status, metaMessageId }` (FR3.1.6; `metaMessageId` included, may be null).
  - `ok:false` → `{ error }` with the helper's `code` **as-is** (so insufficient credits surfaces as **402** here, AC9; OTP-missing as **400**, AC7; and both the **not-connected / null-credential** branch and a **Meta non-2xx** surface as **500** with the refund already applied, AC8 and the not-connected edge case). The route maps `code` verbatim; it does not remap anything (only the session wrapper remaps `402→400`, §4.2).

### 5.2 `GET /api/v1/messages/[id]` (`src/app/api/v1/messages/[id]/route.ts`)

```ts
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const ctx = await authenticateApiKey(request);
  if (!ctx) return unauthorized();
  const message = await prisma.message.findFirst({
    where: { id: params.id, userId: ctx.userId, whatsappNumberId: ctx.number.id },
    select: {
      id: true, status: true, recipientPhone: true, metaMessageId: true,
      errorMessage: true, sentAt: true, deliveredAt: true, readAt: true, createdAt: true,
    },
  });
  if (!message) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(message);
}
```

- Scoped to **both** `userId` and the key's bound `whatsappNumberId` (FR3.2.2, AC10): a message owned by another user, or by this user but another number, is a **404** (never a cross-tenant/cross-number read, NFR4).
- **No existence oracle (resolves iteration-2 review finding 2 — MEDIUM, NFR4).** A non-matching id returns the **identical** `404 {"error":"Not found"}` whether the id does not exist at all or exists under another user/number. The single `findFirst` with the `{ id, userId, whatsappNumberId }` filter guarantees this: there is one code path for "no row," so a third party can never distinguish "wrong id" from "someone else's id." The user-supplied **path id is not logged** on any branch of this route (success or 404), so logs cannot be used to confirm the existence of another tenant's message id either.
- Returns only non-credential fields (A4/FR3.2.3). The `select` is an allow-list, so a future credential-bearing column can never leak by accident.

### 5.3 `GET /api/v1/templates` (`src/app/api/v1/templates/route.ts`)

```ts
export async function GET(request: Request) {
  const ctx = await authenticateApiKey(request);
  if (!ctx) return unauthorized();
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status"); // optional ?status=approved
  const KNOWN = ["draft", "pending", "submitted", "approved", "rejected"] as const;
  if (rawStatus !== null && !KNOWN.includes(rawStatus as (typeof KNOWN)[number])) {
    return NextResponse.json(
      { error: `Invalid status. Allowed: ${KNOWN.join(", ")}` },
      { status: 400 },
    );
  }
  const templates = await prisma.template.findMany({
    where: { userId: ctx.userId, ...(rawStatus ? { status: rawStatus } : {}) },
    select: { id: true, name: true, category: true, language: true, status: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(templates);
}
```

- Scoped to `ctx.userId` only (FR3.3.2 default proposal: return the tenant's templates with their `status` so the third party sees which are usable). Optional `?status=approved` narrows the list (AC11). **Decision: do not additionally filter by the bound number** — templates are owned at the user level in this schema (`Template.userId`), and `whatsappNumberId` on templates is nullable and not consistently set, so a number filter would hide usable templates. Scoping by `userId` is the correct, non-leaking boundary.
- `select` allow-list excludes `body`, `buttons`, `metaTemplateId`, etc. — returns only `name/category/language/status` (+`id` so the client can call send by id). No credential or other-tenant data (FR3.3.3, NFR4).
- **`?status` validation** (resolves iteration-1 review finding 5 — NIT): the optional `status` query param is validated against the known Template status set (`draft | pending | submitted | approved | rejected`). An **unknown/typo'd value returns 400** rather than silently yielding an empty list, so a third party gets an actionable error instead of a confusing empty response. An absent param returns the full tenant list. (This is the only query-param validation on the public GETs; `userId` scoping is never client-controlled.)

## 6. Dashboard key management (session auth only)

### 6.1 `GET /api/api-keys` (`src/app/api/api-keys/route.ts`)

Session-guarded (`getServerSession`), scoped to `session.user.id`. Returns a non-secret projection via `select` allow-list — **never** `keyHash` (FR4.1, AC4, AC16):

```ts
select: {
  id: true, name: true, keyPrefix: true, lastUsedAt: true, revokedAt: true, createdAt: true,
  whatsappNumber: { select: { id: true, phoneNumber: true, displayPhoneNumber: true } },
}
orderBy: { createdAt: "desc" }
```

### 6.2 `POST /api/api-keys` (same file)

Session-guarded. zod body `{ name: z.string().min(1), numberId: z.string().min(1) }`.

1. Validate body → 400 on failure.
2. Verify the number: `prisma.whatsAppNumber.findFirst({ where: { id: numberId, userId: session.user.id, verificationStatus:"verified" } })`. Not found / not owned / not verified → **400** `"Invalid or unverified WhatsApp number"` (FR4.2, AC5). (Using 400 to mirror the session send route's identical check; a reviewer could argue 404 for not-owned, but 400 keeps parity and avoids a tenant-existence oracle.)
3. `const { plaintext, hash, prefix } = generateApiKey();`
4. `const created = await prisma.apiKey.create({ data: { userId, whatsappNumberId: numberId, name, keyHash: hash, keyPrefix: prefix }, select: { id: true, name: true, keyPrefix: true, whatsappNumberId: true, lastUsedAt: true, revokedAt: true, createdAt: true } });` — the `select` allow-list excludes `keyHash` from the row read back.
5. Respond **201** with that projection **plus** `key: plaintext` — the **only** time the plaintext is ever returned (A7, FR4.2, AC3). No column stores the plaintext.

**Exact one-time-reveal response shape (resolves iteration-2 review finding 3 — MEDIUM).** This is the single response in the whole feature that returns a secret, so its shape is pinned here for the dashboard page (§6.4) and tests to assert against:

```jsonc
// 201 Created
{
  "id":               "clx...",
  "name":             "Orders server",
  "keyPrefix":        "wa_live_ab12",
  "whatsappNumberId": "clw...",
  "lastUsedAt":       null,
  "revokedAt":        null,
  "createdAt":        "2026-10-13T12:00:00.000Z",
  "key":              "wa_live_<full-plaintext-shown-exactly-once>"
}
```

`keyHash` is **never** present in this body (the `create`'s `select` omits it, and `key` is the generator's in-memory `plaintext`, not a DB read). The `key` field is populated only here; every subsequent read (`GET /api/api-keys`, §6.1) returns the same projection **without** `key` and without `keyHash`. A test asserts `response.body.key` matches `/^wa_live_/`, that `keyHash` is absent (AC16), and that a follow-up `GET` for the same id has no `key`/`keyHash`.

### 6.3 `DELETE /api/api-keys/[id]` (`src/app/api/api-keys/[id]/route.ts`)

Session-guarded. Revoke by setting `revokedAt`:

```ts
const existing = await prisma.apiKey.findFirst({ where: { id: params.id, userId: session.user.id } });
if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });   // other users' keys → 404 (AC14)
if (existing.revokedAt) return NextResponse.json({ id: existing.id, revoked: true }); // idempotent
await prisma.apiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
return NextResponse.json({ id: existing.id, revoked: true });
```

- A key owned by another user is **404** (the `findFirst` scopes to `session.user.id`), so user B can never revoke user A's key (AC14). Revocation is idempotent (re-revoking is a 200 no-op). Once `revokedAt` is set, `authenticateApiKey` rejects immediately (AC13).

### 6.4 Dashboard page (`src/app/dashboard/api-keys/page.tsx`) + sidebar link

A client component (`"use client"`) matching `settings/page.tsx`: `max-w-3xl mx-auto`, `@/components/ui/card`, `Button`, `Input`, `Label`, `Badge`, lucide icons. It renders inside the existing `DashboardShell` (Header + Sidebar + Footer, already responsive), so no layout work is needed beyond the page content.

Behavior:

- On mount, `GET /api/api-keys` → render a responsive list (card per key): name, `keyPrefix`, bound number (`displayPhoneNumber ?? phoneNumber`), `lastUsedAt`, and a Revoked/Active `Badge`.
- A **Create** form: a `name` input and a `<select>` of the caller's verified numbers (fetched from `GET /api/numbers`, filtered to `verificationStatus === "verified"`). On submit → `POST /api/api-keys`.
- On a successful create, show the **full plaintext key once** in a highlighted callout with a Copy button and a warning: "Copy this key now. For your security it will not be shown again." After dismiss, it is gone from state.
- A **Revoke** button per active key → `DELETE /api/api-keys/{id}` with a confirm, then refresh the list.
- Fully mobile-responsive: single-column stacking on small screens (`grid-cols-1 sm:grid-cols-2`-style), consistent with settings.

Sidebar edit (`src/components/dashboard/sidebar.tsx`): add `{ name: "API Keys", href: "/dashboard/api-keys", icon: KeyRound }` to the `navigation` array (import `KeyRound` from `lucide-react`). It inherits the existing active-state and mobile-drawer behavior.

## 7. Developer documentation (`src/app/docs/page.tsx`)

Add a new section (and a TOC entry) titled **"Connect a third-party application (Server-to-server API)"** placed after the current "5. Sending messages" / before "API reference", renumbering is optional — the simplest change adds it as a new numbered section and appends its TOC item. It covers:

- **How to create a key**: Dashboard → API Keys → create, pick a verified number, copy the one-time `wa_live_...` secret.
- **The bearer scheme**: `Authorization: Bearer wa_live_xxx`; the third party supplies **zero** Meta credentials and **zero** number info (the key is bound to a number server-side); a key acts only for its owner's data.
- **The three endpoints** with method/path/auth/body/success shape and the real status codes, each with a `curl` example using `CodeBlock`:

```
curl -X POST https://your-app.com/api/v1/messages \
  -H "Authorization: Bearer wa_live_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"recipient":"15551234567","templateName":"order_update","variables":["1234"]}'

curl https://your-app.com/api/v1/messages/MESSAGE_ID \
  -H "Authorization: Bearer wa_live_xxxxxxxx"

curl "https://your-app.com/api/v1/templates?status=approved" \
  -H "Authorization: Bearer wa_live_xxxxxxxx"
```

- **Lifecycle**: one-time reveal at creation; revoke in the dashboard; a revoked key 401s immediately; retarget = revoke + recreate.
- **Status semantics** (resolves iteration-1 review finding 7 — NIT; enumerate the real codes the handlers return):
  - **401** — missing/malformed `Authorization` header, token not matching the `wa_live_` shape, unknown key, or revoked key.
  - **400** — body validation failure (missing/empty `recipient`, not exactly one of `templateName`/`templateId`, bad `?status`), a resolved template that exists but is **not approved**, or a missing OTP `variables[0]` on an authentication-category template.
  - **402** — insufficient credits (non-superadmin, balance ≤ 0), before contacting Meta.
  - **404** — unknown message id (or one not owned by the key's user/bound number), or a template not found/owned for the given name/id.
  - **500** — the send failed and the credit was refunded, for either cause: the **bound number is not connected** (null credentials — "WhatsApp number is not connected. Reconnect it to send messages.") **or** Meta returned a non-2xx (Meta's error message).
- **Honest note (FR5.3)**: correct the existing yellow "no programmatic API-key scheme" callout in the API-reference section to say the session-cookie routes are for the **dashboard UI**, while `/api/v1` is the **integration path** for third-party servers.

## Error handling (per operation)

| Operation | Failure | Recoverable? | Caller receives | Logged |
| --- | --- | --- | --- | --- |
| `authenticateApiKey` header parse | missing/malformed/`wa_live_` shape | n/a | `null` → route 401 | no (never log token) |
| `authenticateApiKey` lookup | no hash match / revoked / number gone | n/a | `null` → route 401 | no |
| `lastUsedAt` update | DB write fails | yes (ignored) | success unaffected | no (swallow, no key) |
| `sendTemplateMessage` OTP guard | auth template w/o `variables[0]` | caller fixes input | 400, no side effect | no |
| `sendTemplateMessage` credits | balance ≤ 0, non-superadmin | caller tops up | 402 (public) / 400 (session), no send | no |
| not-connected number (null creds) | `resolveSendCredentials` returns `{null,null}`, or threw on decrypt/`ENCRYPTION_KEY` (caught → null) | fatal for this send | message `failed` + **refund**; `{ ok:false, code:500, error:"WhatsApp number is not connected. Reconnect it to send messages." }` → **500** | `console.warn`/`console.error` (no secret) |
| Meta fetch | non-2xx from Graph API | fatal for this send | message `failed` + **refund**; `{ ok:false, code:500, error:<Meta message \| "Failed to send via Meta API"> }` → **500** | `console.error(metaData)` (existing) |
| zod body validation | bad/missing fields | caller fixes input | 400, no side effect | no |
| route top-level | unexpected throw | fatal | 500 `"Internal server error"` | `console.error` (no key) |
| `GET /v1/messages/[id]` | not found, or owned by another user/number | n/a | identical `404 {"error":"Not found"}` (no existence oracle, NFR4) | no (path id never logged) |
| management `DELETE` | key not owned | n/a | 404 | no |

Validation rules for each external input:

- `Authorization` header — required, must be `Bearer <token>`, token must match `wa_live_` shape; failure → 401 (no DB side effect beyond the in-memory hash).
- `recipient` — required, non-empty string; normalized by the helper (`replace(/\D/g,"")`) only for the Meta payload; failure → 400.
- `templateName` | `templateId` — exactly one required (zod `.refine`); failure → 400. Resolution failure → 404/400 as above.
- `variables` — optional `string[]`; for authentication-category templates, `variables[0]` is required (OTP) → 400 if missing.
- management `name` — required non-empty (API layer), nullable in DB; `numberId` — required, must be a verified owned number → 400.

Invariant ownership:

- **Tenant isolation** (NFR4) is owned by the data layer: every public query is `where: { userId: ctx.userId, ... }` and sends go only through `ctx.number`. No endpoint accepts a user/number id from the client, so there is no path to cross a boundary.
- **Secret non-exposure** (NFR1) is owned by (a) the model — no plaintext column; (b) the create route — plaintext returned once, never stored; (c) every read projection — `select` allow-lists that exclude `keyHash`.
- **Send equivalence** (NFR6) is owned by `sendTemplateMessage` as the single source of truth; both routes call it, so drift is structurally impossible except the one documented `402→400` remap in the session wrapper.

## Testability

- **Unit (pure, no DB)**: `generateApiKey` (prefix shape, length, `hashKey(plaintext)` matches, prefix is a strict substring), `hashKey` determinism, `looksLikeApiKey` accept/reject, and `isSuperAdminUser` (true for the `SUPERADMIN_EMAIL`/`neanvtech@gmail.com` email even when `role==="admin"`, true for `role==="superadmin"`, false otherwise) — the latter directly guards review finding 1.
- **Integration (DB + request)**: `authenticateApiKey` for each 401 branch and the success path (incl. revoked and best-effort `lastUsedAt`); `sendTemplateMessage` for OTP-guard-400, insufficient-credits-402, superadmin-exemption, null-credential→failed+refund, Meta-ok→sent (Meta `fetch` mocked), Meta-fail→failed+refund; the three `/api/v1` routes end-to-end with a seeded key; the management routes (create reveals once, list hides hash, revoke idempotent + cross-user 404).
- The `402→400` remap is the only session-route behavior change; an integration test asserting the session route still returns 400 on insufficient credits guards NFR6/AC15.

## Verification steps (for the implementation phase)

1. `node scripts/add-api-key-table.mjs` — creates table + indexes; run **twice** to confirm the clean no-op and exit 0 (AC1).
2. `npm run build` — `prisma generate` picks up `ApiKey`; `next build` compiles all new routes/pages (AC2, AC18).
3. `npm run lint` — passes (AC18).
4. Manual/curl against a seeded verified number + approved template:
   - Create a key via the dashboard; confirm the plaintext is shown once and the DB row has only `keyHash`/`keyPrefix` (AC3, AC16).
   - `POST /api/v1/messages` happy path returns `{ id, status, metaMessageId? }` using the bound number (AC6); auth-template OTP cases (AC7); Meta-failure refund (AC8); insufficient-credits 402 (AC9).
   - `GET /api/v1/messages/{id}` for own vs other-user/other-number id (200 vs 404, AC10).
   - `GET /api/v1/templates` scoping + `?status=approved` (AC11).
   - 401 matrix: no header, bad shape, unknown key, revoked key (AC12, AC13).
   - Session send route unchanged for a dashboard user (AC15).
5. `grep -rn "wa_live_\|keyHash" src` and scan server logs during the above to confirm no plaintext/hash is logged by any new route or the helper (AC16).
6. Load `/docs` and confirm the M2M section renders with the three endpoints, bearer scheme, zero-credential guarantee, and the corrected note (AC17).
7. Remove any temporary seed/test artifacts created during verification.

## Open items (settled in this revision)

These were previously flagged for the reviewer; they are now settled decisions:

1. **`keyHash` indexing**: the model uses `keyHash @unique` only (the redundant standalone `@@index([keyHash])` was removed per iteration-1 finding 6). The unique index is the functional lookup index and satisfies "index keyHash".
2. **`name` nullability vs required**: DB column is nullable (`name String?`), required at the create API via zod. The stricter rule lives at the layer that owns user input. (Settled; no finding against it.)
3. **Insufficient-credits code 402** for the public API; the session route keeps its legacy 400 via the single documented `402→400` remap (§4.2). (Settled; no finding against it.)
4. **Template not-found 404 vs not-approved 400** split on the public send/resolve path (the session route uses a single 400). Consistent with the acceptance-criteria edge-case list. (Settled; no finding against it.)

## Responses to design review (iteration 2)

Review: `.agents/tasks/public-api-m2m/design-review.json` (+ `design-review.md`), verdict **CHANGES_REQUESTED** (0 HIGH, 3 MEDIUM, 3 NIT). All six findings are **addressed** in this iteration-3 revision; none backlogged or declined. Each change was re-verified against the real code (`src/app/api/messages/send/route.ts`, `scripts/add-tenant-meta-app-table.mjs`, `prisma/schema.prisma`, `src/app/docs/page.tsx`).

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | MEDIUM | Public send body accepts `templateName`, contradicting requirements FR3.1.2/FR3.1.4 (which specify `templateId` only) — a silent spec widening | **Addressed (review's option b).** The step task prompt mandates `{recipient, templateName|templateId, variables?}`, so `templateName` must stay. The contract was fixed at the authoritative source instead: **`requirements.md` FR3.1.2/FR3.1.4 were updated** to specify "exactly one of `templateName` or `templateId`," with a matching edge-case bullet and `Last updated` note. The design's XOR `.refine` (§5.1) now **conforms to** the requirement rather than overriding it; a `>` blockquote in §5.1 records the reconciliation and DX rationale. |
| 2 | MEDIUM | `GET /api/v1/messages/{id}` no-oracle isolation guarantee only implied; path-id logging not stated | **Addressed.** §5.2 now states explicitly: a non-matching id returns the **identical** `404 {"error":"Not found"}` whether it does not exist or exists under another user/number (single `findFirst` → one path, no existence oracle, NFR4), and the user-supplied **path id is never logged** on any branch. The error-handling table row for `GET /v1/messages/[id]` was updated to tie "not logged" to the oracle guarantee. |
| 3 | MEDIUM | One-time key-reveal response shape (`POST /api/api-keys`) not pinned | **Addressed.** §6.2 now pins the exact 201 body: `{ id, name, keyPrefix, whatsappNumberId, lastUsedAt, revokedAt, createdAt, key }`, states `keyHash` is never present (the `create` uses a `select` allow-list that omits it; `key` is the in-memory plaintext, not a DB read), and notes `key` appears only in this response — every later `GET` returns the same projection without `key`/`keyHash`. |
| 4 | NIT | `isSuperAdminUser` typed `role` as nullable though the DB column is non-null | **Addressed.** §4.4 predicate signature tightened to `{ email: string; role: string }` — both match the schema (`User.email String @unique` NOT NULL, `User.role String @default("admin")` NOT NULL) and the §5.1 `select { email: true, role: true }`, removing the impossible `| null` case. No behavior change. |
| 5 | NIT | Migration existence-probe and dual-index idempotency not stated explicitly | **Addressed.** §1.2 now states the existence probe is a single `PRAGMA table_info(ApiKey)` driving the log line only, and that all three DDL statements (`CREATE TABLE` + both `CREATE INDEX`, every one `IF NOT EXISTS`) run **unconditionally** on every invocation, so the second run is a clean no-op (AC1) regardless of partial prior state. |
| 6 | NIT | `looksLikeApiKey` length floor (32) below the actual base64url suffix length (~43) | **Addressed.** §2 floor bumped from `PREFIX.length + 32` to `PREFIX.length + 43` (the exact encoded length of 32 random bytes) with a comment noting it is only a shape filter and the SHA-256 lookup is the real gate. |

No iteration-2 findings were ignored or backlogged.

## Responses to design review (iteration 1)

Review (first round): verdict **CHANGES_REQUESTED** (1 HIGH, 2 MEDIUM, 4 NIT). All seven findings were **addressed** in the iteration-2 revision; none backlogged or declined. Each change was re-verified against the real code (`src/lib/auth.ts`, `src/app/api/messages/send/route.ts`, `src/app/api/admin/users/[id]/route.ts`).

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | HIGH | Superadmin derived from DB `role` column, which is never `"superadmin"` → superadmin wrongly charged on public sends | **Addressed.** Added shared pure predicate `isSuperAdminUser({ email, role })` in `src/lib/api-key.ts` mirroring the JWT callback's email override (`SUPERADMIN_EMAIL || "neanvtech@gmail.com"` OR `role === "superadmin"`). §5.1 now selects the owner's `email` **and** `role` and computes `isSuperAdmin` via this predicate. Verified in `src/lib/auth.ts` that the session role is email-driven, and in `src/app/api/admin/users/[id]/route.ts` that the DB column is only ever set to `"admin"`. (§4.4, §5.1) |
| 2 | MEDIUM | Status code for a disconnected bound number (null creds) left implied, not stated | **Addressed.** §4 step 6 now states the null-credential branch returns `{ ok:false, code:500, error:"WhatsApp number is not connected. Reconnect it to send messages." }` with refund applied, matching the session route's 500. A dedicated "not-connected number (null creds)" row was added to the error-handling table, separate from the Meta non-2xx row. §5.1 and §7 surface it as 500. |
| 3 | MEDIUM | `isSuperAdmin` not stated to be computed once / reused for check+deduct+refund | **Addressed.** Added an explicit "`isSuperAdmin` contract" paragraph to §4.1: the caller computes the boolean once and passes it in; the helper uses that single value for the check, deduct, and refund and never re-derives it, keeping credit math symmetric. §5.1 states the public route computes it once at that call site. |
| 4 | NIT | zod `.refine` allowed both `templateName` and `templateId`, contradicting "exactly one" | **Addressed.** Refine tightened to XOR (`!!b.templateName !== !!b.templateId`) with message "Provide exactly one of templateName or templateId" — both or neither now returns 400. |
| 5 | NIT | `?status` passed to Prisma unvalidated (silent empty list on typo) | **Addressed.** §5.3 validates `status` against `draft \| pending \| submitted \| approved \| rejected`; an unknown value returns **400** (documented), an absent value returns the full tenant list. |
| 6 | NIT | Redundant `@@index([keyHash])` in model diverges from migration | **Addressed.** Removed `@@index([keyHash])` from the Prisma model (§1.1); `keyHash @unique` + `@@index([userId])` remain, one-to-one with the two indexes the migration creates. |
| 7 | NIT | Docs status list omitted the not-connected 500, loose on 404 vs 400 | **Addressed.** §7 "Status semantics" rewritten to enumerate 401 / 400 (validation, not-approved template, missing OTP) / 402 (insufficient credits) / 404 (unknown message id or template not found/owned) / 500 (not-connected number or Meta non-2xx, both after refund). |

No findings were ignored or backlogged. The one deliberate asymmetry retained from iteration 1 — the session wrapper's `402→400` remap to preserve legacy dashboard behavior (§4.2) — was explicitly confirmed as parity-correct by the review ("The §4.3 wrapper and the 402→400 remap preserve observable session behavior. Confirmed accurate.") and is unchanged.
