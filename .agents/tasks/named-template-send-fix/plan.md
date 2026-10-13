# Implementation Plan — Named-parameter template send fix

Derived from `design.md` (revision 2) and `requirements.md`. This is a single
in-place feature change in one repo. Order is by dependency: pure helper first,
then the shared send path, then the two routes, then the templates response,
then docs + scratchpad, then the ground-truth diagnostic and the verification
gate. Each item leaves the tree buildable.

## Decisions the implementer must honor (settled here, do not re-decide)

- **Test harness (NFR6 / AC15).** The repo has **no** test framework
  (`package.json` has only `dev/build/start/lint/db:*`; no vitest/jest; the only
  "tests" are standalone `scripts/*.mjs` run with `node`, e.g.
  `scripts/test-crypto.mjs`). Do **not** add vitest/jest or any runtime/dev dep
  (NFR2). Follow the existing convention: write the pure-function unit tests as a
  standalone **`scripts/test-template-params.mjs`** using node's built-in
  `node:assert/strict`, runnable with `node scripts/test-template-params.mjs`
  (exit 0 = pass). Because node cannot import a `.ts` module directly and we are
  adding no loader dep, keep the pure parameter logic available to the script by
  having `scripts/test-template-params.mjs` import from a **plain ESM
  `.mjs`/`.js` sibling is NOT created**; instead the script re-declares the small
  pure functions is NOT acceptable (would drift). Resolution: author the pure
  logic in `src/lib/template-params.ts` AND have the test script import it via
  node's native TS stripping if available; if `node scripts/test-template-params.mjs`
  cannot resolve the `.ts` import in this Node version, fall back to running it
  through the already-installed TypeScript via
  `node --import tsx` is unavailable (tsx not installed) — therefore the
  authoritative, always-available gate is **`npm run build`** (runs
  `prisma generate && next build`, which typechecks the whole tree including the
  new pure module and its consumers) **plus `npm run lint`**. The `.mjs` test
  script is best-effort extra coverage; the build+lint gate is the required gate
  that MUST pass. (If the implementer confirms the installed Node can strip types
  for a direct `.ts` import, wire the script to import the real functions so the
  assertions exercise the shipped code; otherwise document in the script header
  that it mirrors the logic and the build is the source-of-truth gate.)
- **Named-map carrier field.** Use a single explicit object field
  `templateParams: Record<string,string>` on `POST /api/v1/messages` (design §6.1,
  A4). Not free top-level keys — avoids collision with reserved fields.
- **Disambiguation.** `templateParams` present and non-empty ⇒ named-map form;
  else positional `variables`. Both present ⇒ 400 (zod `.refine` + defensive
  resolver check). (design §6.1, FR1.5.)
- **No schema change** (A5 confirmed: `body`, `headerType`, `headerContent`,
  `buttons`, `category`, `language`, `name` all exist on `Template` in
  `prisma/schema.prisma`). No `prisma db push`.
- **Single send path preserved**: both routes keep calling `sendTemplateMessage`;
  session route `/api/messages/send` needs **no logic change** (it never sets
  `templateParams`). (FR4.5/FR4.7/AC11.)

---

- [ ] 1. Create the pure parameter-model module `src/lib/template-params.ts`.
      Export: the `ParamModel` and `ResolvedBody` types from design §4; a
      whitespace-tolerant scanner `parseTemplateBody(body)` using
      `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g` that classifies named vs numbered vs none,
      de-duplicates named tokens to first-occurrence declared order, and computes
      the numbered `count` from the Set of numeric tokens of that SAME single scan
      (design §4.1); `resolveBodyParams(model, { variables, namedParams, name })`
      implementing every rule in design §4.2 (none → emit nothing; numbered →
      reject a non-empty `namedParams`, else require length === count; named →
      named-map requires exact key-set match, positional requires
      length === names.length, both-forms error, neither-present error) returning
      `{ ok:true, resolved } | { ok:false, error }` with the exact Meta-style error
      strings from §4.2 (echo expected-vs-provided names/counts, no secrets);
      `namedParams(body): string[]` returning the ordered de-duplicated declared
      names (`[]` for numbered/none); and `buttonUrlIsDynamic(buttonsJson: string | null): boolean`
      that parses the buttons JSON defensively (reuse the `parseJsonColumn` style —
      never throw) and returns true iff some URL-type button's `url` contains `{{`.
      All functions pure (string in, value out) — no DB, no network, no `fetch`,
      no prisma import (NFR6).
      Files: `src/lib/template-params.ts`
      Verify: `npm run build` exits 0 (typechecks the new module). The module must
      compile under `strict` with no `any`-driven payload construction (NFR1).

- [ ] 2. Make `template-format.ts` delegate the numbered count to the new module
      (single source of truth — design §4.1, Finding 4) and re-export `namedParams`.
      Change `countVariables(body)` to `const m = parseTemplateBody(body); return m.kind === "numbered" ? m.count : 0;`
      (preserving today's numeric-only behavior: 0 for named/none). Add
      `export { namedParams } from "@/lib/template-params";` (or re-export via a
      thin wrapper) so the templates route and docs share one derivation. Leave
      `parseJsonColumn` unchanged.
      Files: `src/lib/template-format.ts`
      Verify: `npm run build` exits 0. Manually trace that `countVariables("Hi {{1}}, order {{2}}")` still returns 2 and `countVariables("Hi {{guest_name}}")` returns 0 — assert both in `scripts/test-template-params.mjs` as the Finding-4 agreement check.

- [ ] 3. Add the `scripts/test-template-params.mjs` pure-function test (NFR6).
      Cover (design §12): `parseTemplateBody` for named / numbered / none /
      repeated-name de-dup / mixed named+numeric / `\s*`-tolerant `{{ guest_name }}`;
      `resolveBodyParams` named-map happy path, missing key, extra key, positional
      happy path, wrong count, both-forms error, numbered-with-namedParams reject;
      `buttonUrlIsDynamic` static vs `{{}}` URL vs null/garbage; the
      `countVariables ≡ parseTemplateBody` numbered-agreement check; and the
      `niqen_invite` §7 trace asserting the exact six-entry ordered BODY component
      `{ type, parameter_name, text }`. Use `node:assert/strict`; exit non-zero on
      first failure. Follow the Decisions note: wire it to import the real `.ts`
      functions if this Node can strip types; otherwise mark the script as a mirror
      and rely on build+lint as the authoritative gate.
      Files: `scripts/test-template-params.mjs`
      Verify: `node scripts/test-template-params.mjs` prints all-pass and exits 0
      (if the Node version resolves the import); regardless, `npm run build` and
      `npm run lint` stay green.

- [ ] 4. Rewrite component construction in `src/lib/send-template.ts` to be
      structure-driven and insert the pure pre-charge gate. Add
      `namedParams?: Record<string, string>` to `SendTemplateInput` and destructure
      it. Insert the pre-charge gate (design §5.1) EXACTLY between the auth-OTP
      guard `return` (`if (template.category === "authentication" && !variables?.[0]) {...}`)
      and the credit check (`if (!isSuperAdmin) { const userCredits = ... }`): (a)
      call `parseTemplateBody(template.body)` + `resolveBodyParams(model, { variables, namedParams, name: template.name })`,
      return `{ ok:false, code:400, error }` on failure; (b) presence-only
      media-header check — if `headerType` ∈ {image,video,document} and NONE of
      `documentUrl|mediaUrl|documentBase64|pdfBase64|mediaBase64` is present, return
      400 (do NOT include `mediaId` — Finding 6; no upload, no DB write — Finding 1);
      (c) dynamic-button check — if not authentication and `buttonUrlIsDynamic(template.buttons)`
      and no `buttonParam||buttonUrlParam`, return 400. Then rewrite the body/header/
      button builders: BODY per §5.2 (named → `parameter_name`+text entries in
      resolved order; numbered → positional `{type:"text",text}` byte-identical to
      today; none → omit); HEADER per §5.3 (emit only for a real media header with a
      resolved `docUrl`; keep the post-charge base64→MediaStore upload exactly where
      it is today and route its failure to the existing failed+refund branch;
      **delete** the `else if (headerType === "image")` Unsplash block and the
      `if (!docUrl && headerType === "document")` dummy-PDF block); BUTTON per §5.4
      (keep the auth copy-code button firing from `variables[0]` independent of
      `resolvedBody.kind`; emit a dynamic URL button only when the button is dynamic
      AND `btnParam` present; **delete** the `template.name === "niqen_invite"`
      branch and the literal `"rsvp"` fallback). Keep credit lifecycle, Meta error
      surfacing, and the payload `console.log` (no token) unchanged (§5.5–5.7).
      Files: `src/lib/send-template.ts`
      Verify: `npm run build` exits 0 and `npm run lint` is clean. Numbered-template
      regression trace: hand-trace `otp_1`/`migration_alert_v2` through the new BODY
      builder and confirm the emitted parameters array is `{type:"text",text:v}` with
      no `parameter_name` (AC6); confirm the §7 `niqen_invite` named + positional
      traces both produce the identical six-entry component.

- [ ] 5. Extend `POST /api/v1/messages` to accept the named map and pass it through.
      In `src/app/api/v1/messages/route.ts` add `templateParams: z.record(z.string(), z.string()).optional()`
      to the `Body` zod object and add a `.refine` rejecting the case where both
      `variables` and `templateParams` are present with message
      `"Provide either 'variables' or 'templateParams', not both."` (design §6.1,
      FR1.5). Destructure `templateParams` from `parsed.data` and pass
      `namedParams: templateParams` into the `sendTemplateMessage(...)` call
      alongside the existing fields. The route keeps surfacing `result.code`
      verbatim, so the new 400s flow out unchanged (§6.2). No other logic change.
      Files: `src/app/api/v1/messages/route.ts`
      Verify: `npm run build` exits 0 and `npm run lint` is clean. Confirm the
      existing `templateName`-xor-`templateId` `.refine` is still present and the
      new `.refine` composes with it (both can run).

- [ ] 6. Confirm `src/app/api/messages/send/route.ts` is observably unchanged.
      No edit expected — the session route destructures only `numberId, recipient,
      templateId, variables` and never sets `templateParams`, so it continues to
      pass positional `variables` into the same `sendTemplateMessage` and keeps its
      402→400 remap (FR4.5/AC11). Read the file and verify no change is required; do
      NOT add `templateParams` here.
      Files: `src/app/api/messages/send/route.ts` (no modification)
      Verify: `git diff --stat` shows this file is NOT modified after the task; the
      session-send contract (402→400 remap, positional variables) is intact.

- [ ] 7. Add the additive `namedParams: string[]` field to the templates list
      response. In `src/app/api/v1/templates/route.ts` import `namedParams` from
      `@/lib/template-format` (re-exported in item 2) and change the mapped object to
      `{ ...t, buttons: parseJsonColumn(t.buttons), variableCount: countVariables(t.body), namedParams: namedParams(t.body) }`.
      `variableCount` stays numbered-only (unchanged). This is additive and
      non-breaking (design §6.3, Finding 3). (Decision: the task scope and design §3
      list only the LIST route for `namedParams`; the single-template route
      `GET /api/v1/templates/[id]` is NOT required to add the field — leave it as-is
      to stay in scope. The docs single-template example keeps `variableCount` only.)
      Files: `src/app/api/v1/templates/route.ts`
      Verify: `npm run build` exits 0 and `npm run lint` is clean. Hand-trace that a
      numbered template yields `namedParams: []` and `niqen_invite` yields the six
      declared names.

- [ ] 8. Update `/docs` for the named-variable contract. In
      `src/app/docs/page.tsx`, in the `POST /api/v1/messages` block (the
      `{/* POST /api/v1/messages */}` section): extend the Body paragraph to
      document `templateParams` (named-map object keyed by declared names) vs the
      positional `variables` array, the mutual-exclusion rule, the deterministic
      positional→named order (first-occurrence, distinct, left-to-right over the
      body — AC4), and the pre-charge 400 on name/count/header/button mismatch; add a
      `niqen_invite` named-map curl example using placeholder values only (FR5.3).
      In the `{/* GET /api/v1/templates */}` block: add the sentence that
      `variableCount` is the numbered (`{{1}}`,`{{2}}`…) count and is `0` for a named
      template, that `namedParams` lists the declared names in the exact order to
      send, and that an integrator sends them as a `templateParams` object or a
      positional `variables` array in that order; add `"namedParams": ["event","guest_name",...]`
      to the list-response example JSON. No real tokens/keys/phone IDs/FB creds
      (FR5.3/AC16). Also add a brief separate note (FR6/AC14) that `deliveredAt`-null
      / "Message delivered: 0" is a distinct webhook-subscription / `META_APP_SECRET`
      concern, not this send fix — documentation only.
      Files: `src/app/docs/page.tsx`
      Verify: `npm run build` exits 0 and `npm run lint` is clean (JSX valid). Grep
      the diff to confirm no literal token/key/phone-id string was introduced
      (placeholders like `wa_live_xxxxxxxx` only).

- [ ] 9. Update `scratchpad.md`. Refresh `Last updated:` to today's date; update the
      send-path / public-API description to state that `POST /api/v1/messages`
      accepts positional `variables` OR a named `templateParams` map, that named vs
      numbered body shape is derived by `src/lib/template-params.ts`
      (`parseTemplateBody`/`resolveBodyParams`/`buttonUrlIsDynamic`), that the
      pre-charge gate 400s on mismatch before any credit/row, and that
      `GET /api/v1/templates` now returns `namedParams`. Append a dated Change-log
      entry (newest first) summarizing: new `template-params.ts`, send-path rewrite
      removing the `niqen_invite`/`"rsvp"` and Unsplash hardcodes, route named-map
      support, templates `namedParams` field, docs update. Reference config by key
      name only — no secret values.
      Files: `scratchpad.md`
      Verify: `Last updated` is today and the Change-log has a new top entry; no
      secret values present.

- [ ] 10. Ground-truth diagnostic (AC1) — run during implementation, before
      finalizing. Read `$META_ACCESS_TOKEN` from `.env` at runtime; NEVER print,
      echo, log, or commit it (reference by key name only — AC16). Make ONE pinned
      `v19.0` Graph call to capture the real `niqen_invite` structure:
      `curl -s -G "https://graph.facebook.com/v19.0/1290990196241997/message_templates" --data-urlencode "name=niqen_invite" --data-urlencode "fields=name,status,category,language,components" -H "Authorization: Bearer $META_ACCESS_TOKEN"`.
      Record ONLY as evidence (in a scratch file deleted before commit, or commit
      notes): the BODY component's ordered named-param set (pins the real declared
      order for AC4), the HEADER `format` (NONE/TEXT/IMAGE/VIDEO/DOCUMENT), and
      whether any URL button is static or `{{1}}`-dynamic. Also fetch the tenant's
      authentication templates
      (`fields=name,category,components`) and confirm NONE declares a media header —
      this validates the §5.1 uniform media-header 400 for auth (Finding 2); if one
      does, add an auth carve-out to gate check (b) before shipping. If the real
      declared order differs from the assumed `event, guest_name, event_name,
      event_date, venue_name, allowed_guests`, update the `/docs` example (item 8)
      and the §7 trace to the recorded order — the derivation code does NOT change
      (it reads the live body).
      Files: none committed (evidence is scratch-only, deleted before commit)
      Verify: evidence captured; token never appears in any file, log, or commit;
      if a code-verification/token-expiry error (`#190` / expired) is returned,
      note that the token in `.env` must be renewed (see item 11) and the live
      proof is deferred — the build+unit gate still governs AC15.

- [ ] 11. Optional live proof + token-expiry handling. If the item-10 token is
      valid, do ONE live `niqen_invite` send to `917088970099` via the corrected
      named-map payload and record only the HTTP status + `wamid` as evidence
      (confirms no `#132000`/`#100`; AC2). If the Graph call returns an expired/
      invalid token error, do NOT hardcode or commit a new token: document that the
      operator must regenerate the per-number access token (reconnect via Embedded
      Signup or paste a fresh token into the number record / `.env` `META_ACCESS_TOKEN`
      by key name) and that the diagnostic/live proof resumes once renewed. Remove
      any temp script created for this step before commit.
      Files: none committed (temp script removed)
      Verify: `git status` is clean of any temp script; no token value committed.

- [ ] 12. Final verification gate (AC15/AC16). Run the project's real gate and
      confirm a clean tree.
      Files: none
      Verify:
      - `npm run build` exits 0 (prisma generate + next build typechecks the whole
        tree including `template-params.ts` and all consumers).
      - `npm run lint` is clean.
      - `node scripts/test-template-params.mjs` passes (or, per item 1/3, the build
        is the authoritative gate if the Node version can't import the `.ts`).
      - `git diff --stat` shows ONLY: `src/lib/template-params.ts` (new),
        `src/lib/send-template.ts`, `src/lib/template-format.ts`,
        `src/app/api/v1/messages/route.ts`, `src/app/api/v1/templates/route.ts`,
        `src/app/docs/page.tsx`, `scripts/test-template-params.mjs` (new),
        `scratchpad.md`. `src/app/api/messages/send/route.ts` is NOT modified.
      - No temporary repro/diagnostic scripts remain; `git status` is clean of
        untracked scratch files.
      - No token/key/phone-id/app-secret value appears in any diff, log, or doc
        (placeholders only).
      - Work is committed on `main` (no push, no worktree, no PR) per task scope.

## Notes / gaps (reasonable assumptions)

- The pure-function `.mjs` test is best-effort because the repo ships no TS test
  loader and NFR2 forbids new deps; the authoritative, always-runnable gate is
  `npm run build` + `npm run lint`. The implementer may, if the installed Node
  strips TS types for a direct import, wire the script to the real functions so it
  exercises shipped code — preferred when available.
- `GET /api/v1/templates/[id]` is intentionally left without `namedParams`: design
  §3 and the task scope list only the LIST route. If the reviewer deems the detail
  route in scope, it is a one-line additive mirror of item 7, but it is not planned
  here to avoid scope creep.
- The §10 live proof depends on a valid `.env` `META_ACCESS_TOKEN`; the user's
  "code verification expired, how to renew" and "message not received" reports are
  consistent with an expired token. If expired, items 10–11 degrade to
  "documented, deferred" and AC15 is still met by build+unit (AC1's live-proof is
  explicitly optional in the design; the structural root-cause fix stands on the
  unit trace).
```