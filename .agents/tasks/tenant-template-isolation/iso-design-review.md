# Design Review — Tenant Template Isolation (iso-design.md rev 3)

Reviewer: design-review subagent (fresh read, no authoring context)
Design reviewed: `.agents/tasks/tenant-template-isolation/iso-design.md` (rev 3)
Requirements: `.agents/tasks/tenant-template-isolation/iso-requirements.md`
Date: 2025-02-16

Verdict: **CHANGES_REQUESTED** (1 MEDIUM, several NITs). The design is strong and
the HIGH-1 re-leak path from the prior revision is genuinely closed by the
positive-match-only gate. The remaining MEDIUM is a precision/safety gap in the
cleanup-vs-import ordering interaction, not a re-leak. Everything the task asked
me to scrutinize (import mechanism, sync-hardening guard, not-a-WABA classifier,
cleanup predicate, migration pattern) was spot-checked against the real code.

---

## Findings

### 1. MEDIUM — §2 run-order independence claim conflicts with the §4 cleanup predicate's dependence on the leaked rows still existing

Location: Overview "Required run order", §2 invariant box, §7 "Run-order
independence of §2", and §4 selection predicate.

Problem: The design asserts (correctly) that §2's gate enforces isolation
independently of run order — a positive owned-phone match is required to import,
so `989050294147122` can never re-import. That part is sound. BUT the §4 cleanup
predicate deletes a Surshyam row **only** when its `metaTemplateId` also exists
under Utkranti. If the run order in §6 step 2 is followed as written
(§4 cleanup → §5 flag → deploy §2/§3), there is a window where the semantics are
fine. The gap is the reverse case the design does not address: if §2/§3 are
deployed first (which the design says is *safe* to do because §2 is
order-independent), a subsequent sync under the hardened gate will SKIP the bad
WABA and import nothing — but the already-leaked rows remain, and `GET
/api/templates` keeps returning Utkranti's 7 templates to Surshyam until §4 runs.
The design's "§2 is correct independently of this order" language (§7, Overview)
is true for *not creating new* leaks but is silently untrue for *removing
existing* ones. A reader could deploy §2/§3, observe sync no longer leaks, and
conclude the fix is complete while the 7 leaked rows are still visible.

Fix: State explicitly that §4 (cleanup) is a hard precondition for the *user-
visible* fix (the leaked rows disappearing from `GET /api/templates`), and that
§2's order-independence applies only to the "create zero new cross-tenant rows"
invariant (FR1/AC5), not to remediation of the existing 7 rows (which requires
§4). Add one sentence to §7's "Run-order independence of §2" bullet:
"§2 prevents new leaks regardless of order; it does NOT remove the 7 already-
leaked rows — §4 is required and must run for the leak to disappear from the
tenant's view."

### 2. NIT — "the committed `isNotAWabaError`" wording implies a helper that does not yet exist

Location: HIGH-level summary table (MEDIUM-1 row), §3 MEDIUM-1 paragraph, §6
step 0.

Problem: The phrase "confirm the committed `isNotAWabaError` returns true" reads
as if the classifier is already in the repo. I grepped the codebase: no
`isNotAWabaError` exists anywhere outside the design/review docs. It is a brand-
new export this design adds to `src/lib/whatsapp.ts`. The wording is harmless to
an attentive implementer but could cause a reader to go looking for an existing
function.

Fix: Change "the committed `isNotAWabaError`" to "the newly added
`isNotAWabaError` (new export in `src/lib/whatsapp.ts`)" on first mention, so it
is unambiguous the helper is created by this work.

### 3. NIT — §6 step-0 capture box left as literal `____` placeholders; the "would have caught 989050294147122" claim is asserted-conditional, not demonstrated

Location: §3 "Capture result (to be filled at implementation time, blocks ship)",
§6 step 0.

Problem: The design cannot demonstrate (from the repo) that `isNotAWabaError`
returns `true` for `989050294147122` — the only repo-visible log (manual-connect
branch c) records just `phonesRes.status`, never the error body. The design
honestly defers this to a blocking implementation-time capture. This is the
correct handling for a design doc (the live Graph call cannot be made during
design), and §2's positive-match gate makes the *isolation* guarantee
classifier-independent. However, the **AC12 connect-rejection** correctness
(reject `989050294147122` with HTTP 400) genuinely depends on the capture
outcome, so the design closes with one labeled unverified assumption. This is a
NIT (not MEDIUM) because: (a) it is explicitly converted into a ship-blocking
step with a concrete procedure and a fallback (widen to observed status, never a
bare `code 100`); and (b) the leak itself is blocked by §2 regardless.

Fix: No design change required beyond keeping step 0 as a blocking gate. If
desired, add a note that AC12 (connect rejection of the exact id) is the only
acceptance criterion whose pass/fail is unresolved until the capture completes,
so the implementer treats it as a release gate rather than a unit-test
assertion.

### 4. NIT — sync `synced` field is `localTemplates.length`, not a count that includes imports; design examples should not imply otherwise

Location: §2 "Response shape", "If every WABA is skipped" paragraph
(`{ synced: <local count>, ... }`).

Problem: Verified against `src/app/api/templates/sync/route.ts`: the handler
returns `synced: localTemplates.length` where `localTemplates` is the
*filtered* (non-duplicate, status-in-[submitted,pending,approved]) local set —
not a total of all rows and not inclusive of freshly imported rows. The design's
"`synced: <local count>`" is approximately right but imprecise ("local count"
could be read as "all local templates"). Preserving the field unchanged is
correct (AC7); the design just slightly mislabels what it holds.

Fix: Change "`synced: <local count>`" to "`synced: <filtered local-template
count, unchanged formula>`" so the implementer does not "correct" the field to
include imports.

---

## Verified Assumptions (checked against real code)

1. **Import write site stamps `whatsappNumberId: meta.__sourceNumberId`
   (non-null).** CONFIRMED in `src/app/api/templates/sync/route.ts` import loop —
   the `prisma.template.create` block matches the design's verbatim snippet,
   including `userId: session.user.id`, `metaTemplateId: meta.id`, and
   `whatsappNumberId: meta.__sourceNumberId`. The design's correction of the
   brief's stale "imports set whatsappNumberId=null" claim is accurate.

2. **`__sourceNumberId` tagging in the fetch loop.** CONFIRMED —
   `metaTemplates.push({ ...t, __sourceNumberId: numberId })` where `numberId`
   comes from `for (const [wabaId, { numberId, accessToken }] of wabaMap)`.

3. **`wabaMap` dedupes verified numbers by `wabaId`, "first per WABA wins".**
   CONFIRMED — `if (!wabaMap.has(creds.wabaId)) wabaMap.set(...)`. The `findMany`
   has no `orderBy` (design's "Turso return order" note is accurate).

4. **`findMany` returns the full row (no `select`), so `phoneNumberId` is
   available for the §2 step-1 `wabaMap` extension.** CONFIRMED — the sync
   `findMany` has only a `where`, no `select`. The design's plan to read
   `number.phoneNumberId` is feasible.

5. **`resolveWabaCredentials` destructures only `{ wabaId, accessToken }` and the
   sync passes the full row (structural typing).** CONFIRMED in
   `src/lib/whatsapp.ts` — signature is `(number: { wabaId: string | null;
   accessToken: string | null })`. NIT-2's "intentional full-row call" note is
   accurate; no env fallback exists (returns nulls otherwise).

6. **`GET /api/templates` is `userId`-scoped.** CONFIRMED (design cites it; AC8
   unchanged).

7. **Manual-connect branch (c) swallows every non-ok `/phone_numbers` as a
   non-fatal `console.warn` logging only `phonesRes.status`.** CONFIRMED in
   `src/app/api/numbers/manual/route.ts` — exact `else { console.warn(... non-
   fatal): ${phonesRes.status}) }`. The health check (step 1) is `GET
   /{phoneNumberId}?fields=...` with `Authorization: Bearer`, independent of the
   WABA list — so a valid phone+token with a bad `wabaId` persists today, exactly
   as the design states.

8. **`/phone_numbers` success shape is `data[].id` matched against the stored
   `phoneNumberId`.** CONFIRMED — manual-connect uses `list.some((p) => p.id ===
   phoneNumberId)`. The §2 ownership predicate reuses the identical shape, so the
   positive-match gate is implementable and consistent.

9. **`WhatsAppNumber.phoneNumberId` is nullable (`String?`).** CONFIRMED in
   `prisma/schema.prisma`. The design's handling of a null `ownedPhoneId` → SKIP
   (`foreign-waba`) is therefore necessary and correct — a null can never produce
   a positive match, which the design accounts for.

10. **Reference migration pattern (`scripts/add-tenant-meta-app-table.mjs`).**
    CONFIRMED — manual `.env` parse via regex `/^([^=]+)=["']?(.+?)["']?$/`,
    `createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN
    })`, try/catch → non-secret `console.error` → `process.exit(1)` →
    `client.close()` in `finally`. §4/§5 modeling on this is accurate; no
    `db:push`. Env var names exist in `.env`.

11. **Cleanup selection predicate precision/safety (task focus #4).** VERIFIED
    SAFE against the requirements:
    - Outer filter `t.userId = SURSHYAM` ⇒ never selects Utkranti rows (AC18). ✓
    - `t.metaTemplateId IS NOT NULL` + `EXISTS(... o.metaTemplateId =
      t.metaTemplateId ...)` ⇒ a name-only draft with null/distinct
      `metaTemplateId` can never match (AC19, A3). ✓
    - `EXISTS` subquery binds `o.userId = UTKRANTI` specifically — stricter than
      "any different userId" and matching AC17 exactly. ✓
    - Delete uses the identical predicate ⇒ cannot drift from the dry-run
      selection; after apply no Surshyam row satisfies it ⇒ idempotent (AC20). ✓
    - `--apply` flag gates mutation; default is dry-run that prints every
      candidate (AC16). ✓
    - Reads only `Template` id/userId/name/metaTemplateId; never
      `WhatsAppNumber`/ciphertext (NFR2). ✓

12. **§5 bad-WABA flag script.** VERIFIED — four-column SELECT excludes
    `accessToken`; `UPDATE ... SET wabaId = NULL, verificationStatus = 'pending'
    WHERE userId = SURSHYAM AND wabaId = '989050294147122'`; idempotent (after
    apply `wabaId` is NULL so `WHERE wabaId = '989050294147122'` matches 0 rows);
    separate script preserves §4's no-ciphertext envelope (AC23/AC24, A4).

13. **Sync-hardening guard cannot be bypassed (task focus #2).** VERIFIED for the
    *leak* invariant: the only IMPORT path is `phonesRes.ok` AND
    `list.some(p => p.id === ownedPhoneId)` AND `ownedPhoneId != null`. Every
    other branch (`foreign-waba`, `not-a-waba`, `probe-unverifiable`) does
    `continue` before the `message_templates` fetch, so no `metaTemplates` entry
    is produced and neither the update loop nor the import loop can write a row
    for that WABA. `989050294147122` cannot return a Surshyam-owned phone id, so
    it cannot pass row 1 of the decision table under any Graph behavior. The
    prior revision's "trust stored wabaId" fallback is removed. This is a genuine
    closure of HIGH-1.

---

## Unverified / Deferred Assumptions

1. **The exact Graph error shape for `989050294147122/phone_numbers`
   (status + code/type/error_subcode).** NOT verifiable from the repo (the design
   says so; confirmed — only `phonesRes.status` is logged by branch c, never the
   body). The design converts this into a ship-blocking capture step (§6 step 0)
   with a concrete fallback. Consequence: AC12 (reject the exact id at connect)
   is the one acceptance criterion whose pass is unproven until the capture runs.
   The *isolation* guarantee does NOT depend on it (§2 positive-match). See
   finding #3. This is an accepted, labeled deferral — not a design error.

2. **The live Graph behavior by which Surshyam's token read Utkranti's templates
   ("shared Meta app/BM context").** NOT verifiable from the repo (a claim about
   Meta-side resolution). The design explicitly states the fix does not depend on
   the mechanism — the positive-match gate blocks the leak class regardless. This
   is sound: the §2 guarantee is mechanism-independent. No action needed.

3. **Whether a real/owned WABA's `/phone_numbers` always lists the tenant's
   stored `phoneNumberId` under a correctly-scoped token.** Assumed by the
   positive-match gate; the FR6/AC7 tradeoff section acknowledges that an under-
   scoped or transiently-failing token imports nothing (SKIP `probe-
   unverifiable`). This is the documented, accepted safety posture (primary
   FR1/AC5 outranks import convenience). No action needed.

---

## Severity tally

- HIGH: 0
- MEDIUM: 1 (finding #1)
- NIT: 3 (findings #2, #3, #4)

Because MEDIUM > 0, the verdict is **CHANGES_REQUESTED**. The single MEDIUM is a
documentation-precision fix in the run-order narrative (the §2 order-
independence claim must not be read as "the leaked rows go away without §4"); it
is a quick loop-back, not a structural redesign.
