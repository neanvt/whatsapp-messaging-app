# Implementation Plan — Per-Tenant Credentials for Template-Management Routes

Source design: `.agents/tasks/design.md` (Status: Design revision 2, APPROVED).
Requirements: `.agents/tasks/requirements.md`.
Repo: `/Users/neeleshtentiwala/Desktop/Whatsapp/whatsapp`.

## Context (verified against live code)

- Build command: `npm run build` (= `prisma generate && next build`). The repo has
  **no test runner**; verification is the production build (type-check + lint via
  `next build`) plus targeted grep/credential-path walkthrough per the design.
  Baseline `npm run build` is currently **green** (verified before planning).
- `src/lib/whatsapp.ts` already exports `resolveSendCredentials(number)` — the exact
  pattern to mirror for the new WABA resolver. `decrypt` is already imported there.
- `src/lib/crypto.ts` `decrypt()` throws `"Invalid ciphertext format"` on malformed
  input and throws (via `decipher.final`) on tampered ciphertext / bad key; it never
  logs its inputs. The resolver must not add logging.
- `prisma/schema.prisma`: `Template.whatsappNumberId String?` + `whatsappNumber`
  relation **already exist**; `WhatsAppNumber` already has `wabaId`, `phoneNumberId`,
  `accessToken` (ciphertext), `verificationStatus`. **No schema change is required.**
- Env reads to remove (confirmed by grep):
  - `src/app/api/templates/sync/route.ts` lines ~36-37 (`const wabaId/accessToken = process.env...`) and the `!wabaId || !accessToken` 500 guard.
  - `src/app/api/templates/[id]/submit/route.ts` lines ~111-112 and its 500 guard.
  - `src/app/api/templates/[id]/route.ts` lines ~144-151 (DELETE guard + fetch).
- Frontend submit callers that POST to `/api/templates/[id]/submit` with
  `{ sampleValues }` (no `numberId`): `src/app/dashboard/templates/new/page.tsx`
  (`handleSubmit`) and `src/app/dashboard/templates/[id]/page.tsx`
  (`handleSaveAndSubmit`).

## Schema migration decision

**No schema change / no migration script is required.** `Template.whatsappNumberId`
already exists; submit/sync write it, delete reads it. (Design §8.) This is recorded
explicitly so the implementer does NOT create a `scripts/*.mjs` migration or run
`prisma db push` (which fails against `libsql://` with P1012 in this repo).

---

# Implementation Plan

- [ ] 1. Add the `resolveWabaCredentials` resolver to `src/lib/whatsapp.ts`.
      Add one exported, pure, synchronous function immediately after
      `resolveSendCredentials`, mirroring its shape (design §3.2). Signature:
      `resolveWabaCredentials(number: { wabaId: string | null; accessToken: string | null }): { wabaId: string | null; accessToken: string | null }`.
      Return `{ wabaId: number.wabaId, accessToken: decrypt(number.accessToken) }`
      only when BOTH `wabaId` and `accessToken` are non-null; otherwise return
      `{ wabaId: null, accessToken: null }`. No `console.*`, no `prisma`, no
      `session`. `decrypt` is already imported — do not re-import. Add a short
      comment matching the `resolveSendCredentials` doc style (no env fallback;
      decrypt may throw; callers treat a throw as a credential error; never log the
      token/ciphertext).
      Files: `src/lib/whatsapp.ts`
      Verify: `npm run build` compiles clean (the resolver is referenced by the
      routes in later items; until then it is an unused export, which still
      type-checks). (AC-1.)

- [ ] 2. Migrate the submit route to per-tenant credentials with optional `numberId`.
      File `src/app/api/templates/[id]/submit/route.ts`. Follow design §5 exactly.
      - Add `import { resolveWabaCredentials } from "@/lib/whatsapp";`.
      - Keep auth guard, scoped `findFirst({ where: { id: params.id, userId: session.user.id } })`,
        404, and the `draft`/`rejected` status gate UNCHANGED.
      - In the EXISTING single `request.json()` try/catch, read BOTH `sampleValues`
        (unchanged) AND `numberId` from the same `reqBody` object (do NOT add a
        second `await request.json()` — it throws "body already read"). Set
        `numberId = typeof reqBody?.numberId === "string" && reqBody.numberId.length > 0 ? reqBody.numberId : undefined`.
      - Keep the 1024-char body guard UNCHANGED and BEFORE credential resolution.
      - Replace the `process.env.META_WABA_ID/ACCESS_TOKEN` block (and its 500
        "credentials not configured" guard) with number resolution per §4.3
        precedence, each lookup `prisma.whatsAppNumber.findFirst/findMany` scoped by
        `userId: session.user.id`, `verificationStatus: "verified"`,
        `wabaId: { not: null }`, `accessToken: { not: null }`:
        1. If `numberId` provided and the scoped `findFirst` returns nothing →
           400 `{ error: "Selected WhatsApp number is not connected", code: "NUMBER_NOT_CONNECTED" }`.
        2. Else if `template.whatsappNumberId` set: scoped `findFirst` on it; if not
           usable, FALL THROUGH to step 3 (stale binding).
        3. Else `findMany`: 0 → 409 `{ error: "Connect a WhatsApp number before managing templates" }`;
           exactly 1 → use it; >1 → 400 `{ error: "Multiple WhatsApp numbers connected — specify which number to submit this template from", code: "AMBIGUOUS_NUMBER" }`.
      - Resolve creds in a try/catch:
        `try { ({ wabaId, accessToken } = resolveWabaCredentials(number)); } catch { console.error("[Template submit] credential resolution failed (encryption/config)"); return 500 { error: "credential error" }; }`.
        Keep a defensive null guard → 409 (unreachable but consistent). Do NOT log
        token/ciphertext.
      - Keep Meta name sanitization, `buildComponents`, the
        `POST .../v19.0/${wabaId}/message_templates` call shape with
        `Authorization: Bearer ${accessToken}`, and the `META_TOKEN_EXPIRED`
        (code 190 / "Session has expired") 401 branch + the other-error 400 branch
        BYTE-FOR-BYTE unchanged — only the source of `wabaId`/`accessToken` changes.
      - In the success write-back, keep `status: "submitted"`, `metaTemplateId`,
        `submittedAt`, and ADD `...(template.whatsappNumberId ? {} : { whatsappNumberId: resolvedNumberId })`
        where `resolvedNumberId` is the chosen number's `id` (design §4.4).
      Files: `src/app/api/templates/[id]/submit/route.ts`
      Verify: `npm run build` compiles clean. Confirm `process.env.META_WABA_ID` and
      `process.env.META_ACCESS_TOKEN` no longer appear in this file (grep in item 6).
      (AC-2, AC-5, AC-6, AC-7, AC-8, AC-10.)

- [ ] 3. Migrate the sync route to iterate the tenant's usable WABAs.
      File `src/app/api/templates/sync/route.ts`. Follow design §6 exactly.
      - Add `import { resolveWabaCredentials } from "@/lib/whatsapp";` (keep the
        existing `import type { Prisma }`).
      - Keep the auth guard. Replace the `process.env` block + its 500 guard with:
        `findMany` of usable numbers scoped by `userId: session.user.id`,
        `verificationStatus: "verified"`, `wabaId: { not: null }`,
        `accessToken: { not: null }`. If `numbers.length === 0` → 409
        `{ error: "Connect a WhatsApp number before managing templates" }`.
      - Build `const wabaMap = new Map<string, { numberId: string; accessToken: string }>();`
        First-number-per-`wabaId` wins. For each number, resolve creds in try/catch:
        a decrypt throw → `console.error("[Template sync] credential resolution failed (encryption/config)")` and return 500 `{ error: "credential error" }`;
        a null-creds result → defensive `continue`. After the loop, if
        `wabaMap.size === 0` → 409 (same message).
      - Replace the single-fetch block: declare `type MetaTemplate` widened to
        include `__sourceNumberId: string` and `const metaTemplates: MetaTemplate[] = [];`
        (NOT `= metaData.data ?? []`). For each `[wabaId, { numberId, accessToken }]`
        in `wabaMap`, run the existing
        `GET .../v19.0/${wabaId}/message_templates?fields=...&limit=250&access_token=${accessToken}`
        fetch, and push each result as `{ ...t, __sourceNumberId: numberId }`
        (cast per-fetch results to `Omit<MetaTemplate, "__sourceNumberId">[]`).
        Per-fetch `!metaRes.ok`: detect token-expired (code 190 / "Session has
        expired") → return 401 `{ error, code: "META_TOKEN_EXPIRED" }`; other
        non-ok → return 400 with the Meta message (as today). Sync aborts on the
        first failing WABA.
      - Leave ALL downstream logic UNCHANGED: `mapMetaStatus`, `sanitize`,
        `byId`/`byName` maps, the per-user `findMany` of locals, dedup `deleteMany`,
        the update loop, and the response shape `{ synced, updated, imported, duplicatesRemoved }`.
        The `console.log(metaTemplates.map(...))` and `byId`/`byName` are transparent
        to the widened element type.
      - In the Meta-only import `create`, ADD `whatsappNumberId: meta.__sourceNumberId`
        (the `create` keeps `satisfies Prisma.TemplateUncheckedCreateInput`). Do NOT
        rebind already-local templates in the update loop.
      Files: `src/app/api/templates/sync/route.ts`
      Verify: `npm run build` compiles clean (watch the `MetaTemplate` type — the
      widened element type must satisfy the `byId`/`byName`/update-loop reads and the
      import `create`). Confirm no `process.env.META_WABA_ID`/`META_ACCESS_TOKEN`
      remain (grep in item 6). (AC-3, AC-5, AC-6, AC-7, AC-8, AC-10.)

- [ ] 4. Migrate the delete route's best-effort Meta call to per-tenant credentials.
      File `src/app/api/templates/[id]/route.ts` — **DELETE handler only** (leave
      GET and PUT untouched). Follow design §7 exactly.
      - Add `import { resolveWabaCredentials } from "@/lib/whatsapp";`.
      - Keep auth, scoped `findFirst`, and 404. Replace the
        `template.metaTemplateId && process.env.META_WABA_ID && process.env.META_ACCESS_TOKEN`
        guard: only attempt Meta delete when `template.metaTemplateId` is set. Resolve
        the number from `template.whatsappNumberId` (scoped `findFirst` by `userId`,
        verified, non-null `wabaId`/`accessToken`) if set+usable; else the user's
        single usable number (scoped `findMany`, use only when exactly 1); else SKIP
        the Meta delete (log `"[Template delete] no connected number — skipping Meta delete"`, no token).
      - If a number resolves, resolve creds in try/catch; on throw
        `console.warn("[Template delete] credential error — skipping Meta delete")`
        and fall through (do NOT 500). Only when `wabaId && accessToken` are present,
        issue the existing
        `DELETE .../v19.0/${wabaId}/message_templates?hsm_id=${template.metaTemplateId}&name=${template.name}`
        with `Authorization: Bearer ${accessToken}` and the existing
        `.catch((e) => console.warn("Meta delete warning:", e))`.
      - LEAVE `template.name` interpolated UNENCODED (design §7 scope note — carried
        forward verbatim, not a regression, out of scope to "clean up").
      - `await prisma.template.delete({ where: { id: params.id } })` ALWAYS runs after
        the best-effort Meta step. Response and outer catch unchanged. Do NOT surface
        `META_TOKEN_EXPIRED` here (best-effort/non-fatal, design §7.1).
      Files: `src/app/api/templates/[id]/route.ts`
      Verify: `npm run build` compiles clean. Confirm no `process.env.META_WABA_ID`/
      `META_ACCESS_TOKEN` remain in this file (grep in item 6). (AC-4, AC-5, AC-7,
      AC-10.)

- [ ] 5. (Additive, recommended) Let the submit UI pass an optional `numberId` to
      unblock multi-number tenants. Design §4.5 marks this optional/additive — single-
      number tenants keep working with no change because the backend auto-resolves the
      sole number. Implement a minimal selector: load the user's connected verified
      numbers (reuse the existing numbers API the dashboard already uses), and when
      there is more than one, let the user pick; include `numberId` in the POST body
      of the submit `fetch` in `src/app/dashboard/templates/[id]/page.tsx`
      (`handleSaveAndSubmit`) and `src/app/dashboard/templates/new/page.tsx`
      (`handleSubmit`), alongside the existing `sampleValues`. When exactly one number
      exists, default to it and omit the selector. Surface the backend
      `AMBIGUOUS_NUMBER` / `NUMBER_NOT_CONNECTED` / 409 "Connect a WhatsApp number"
      errors in the existing error UI. If scope/time is constrained, this item MAY be
      reduced to only wiring `numberId` into the POST body (no selector) without
      breaking single-number tenants — but prefer the selector so multi-number tenants
      are not dead-ended on a 400.
      Files: `src/app/dashboard/templates/[id]/page.tsx`,
      `src/app/dashboard/templates/new/page.tsx`
      Verify: `npm run build` compiles clean; the two pages still render (no new
      type/lint errors). Single-number flow sends no `numberId` or the sole id, and
      submit still succeeds end-to-end for a one-number tenant.

- [ ] 6. Verify env reads are gone and walk the credential paths (no code change).
      Verify (run each; all must hold):
      - `npm run build` → exit 0, clean type-check/lint.
      - grep the three routes for leftover env reads and expect ZERO matches:
        `grep -nE "META_WABA_ID|META_ACCESS_TOKEN" src/app/api/templates/[id]/submit/route.ts src/app/api/templates/sync/route.ts "src/app/api/templates/[id]/route.ts"`
        (AC-10 #17).
      - Per-route credential-path walkthrough against the design error-contract tables
        (§5.1 submit, §6.4 sync, §7.2 delete): confirm by reading the final code that
        each branch returns the specified status/body and that no `console.*` emits a
        token or ciphertext — submit (401/404/400 status gate/400 >1024/400
        NUMBER_NOT_CONNECTED/409 zero/400 AMBIGUOUS_NUMBER/500 credential error/401
        META_TOKEN_EXPIRED/200), sync (401/409/500 credential error/401
        META_TOKEN_EXPIRED/400 other/200), delete (401/404/200 with Meta skipped on 0
        or ambiguous or decrypt-throw/200 success, local delete always runs).
      - (Optional, non-billable) read-only Graph GET to confirm call shape only, e.g.
        `curl -s "https://graph.facebook.com/v19.0/{WABA_ID}/message_templates?fields=id,name,status&limit=1&access_token={TOKEN}"`
        using a real connected tenant's decrypted creds in a scratch shell (never
        commit the token; this is a shape check, not a required gate).

- [ ] 7. Update `scratchpad.md` per the project scratchpad rule.
      Record: the three template routes now resolve per-tenant WABA credentials via
      `resolveWabaCredentials` (no `META_WABA_ID`/`META_ACCESS_TOKEN` reads in these
      routes); the template→WABA mapping rules (explicit `numberId` → template
      binding → single number → 409/`AMBIGUOUS_NUMBER`); sync iterates all usable
      WABAs and binds imports to their source number; delete stays best-effort; no
      schema change. Append a dated "Change log" entry (newest first). Refresh
      `Last updated:`. Reference config by key name only — no secret values.
      Files: `scratchpad.md`
      Verify: `npm run build` still exit 0 (docs-only change does not break the
      build); the new change-log entry and `Last updated` date are present.
