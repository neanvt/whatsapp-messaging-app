# Design review — Named-parameter template send fix (revision 2)

Reviewer: design-review subagent (fresh read, no authoring context)
Date: 2025-06-13
Design: `.agents/tasks/named-template-send-fix/design.md`
Requirements: `.agents/tasks/named-template-send-fix/requirements.md`

## Verdict

**APPROVED** — 0 HIGH, 0 MEDIUM findings. NIT findings below are non-blocking.

The design is a revision-2 document that already resolved a prior review's 10 findings. I re-read the design independently and verified every structural claim it makes about the current code against the actual source. The named-vs-numbered construction is unambiguous and Meta-correct, the ordered/de-duplicated parse is well-defined, the positional→named order is explicit (first-occurrence, left-to-right, distinct), the header/button rules correctly delete the Unsplash dummy image and the `"rsvp"` hardcode, numbered/positional back-compat is preserved byte-for-byte, the session route is unchanged, and the ground-truth diagnostic step is specified with a pinned Graph API version. No HIGH/MEDIUM gap remains.

---

## Verified assumptions (checked against source)

1. **Root-cause code exists as described.** `src/lib/send-template.ts` builds named params by index: `namedMatches = Array.from((template.body||"").matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)).map(m => m[1])` then `parameter_name: namedMatches[idx] || \`param_${idx + 1}\``. The scan is NOT de-duplicated. **Confirmed** — matches design §1/§4.3.
2. **`niqen_invite`/`"rsvp"` hardcode exists.** `else if (template.name === "niqen_invite" || (template.buttons && template.buttons.includes("{{"))) { ... text: "rsvp" }`. **Confirmed** — matches design §1(2)/§5.4.
3. **Dummy fallbacks exist.** `if (!docUrl && headerType === "document") { docUrl = "...dummy.pdf" }` and `else if (headerType === "image") { ...unsplash... }`. **Confirmed** — matches §1(3)/§5.3.
4. **`countVariables` regex is `/\{\{\s*\d+\s*\}\}/g` with a `Set` dedup.** `template-format.ts` confirms this. The design's claim that the new `parseTemplateBody` scan adds `\s*` tolerance (vs the send-path scan which lacks it) and that `countVariables` can be refactored to delegate without behavior change on numbered bodies is **correct** — both already return the distinct numeric-token count.
5. **`countVariables` is live and used.** `src/app/api/v1/templates/route.ts` calls `countVariables(t.body)`; the detail route also references it (grep hit at docs/line 587 is docs text, but route usage is confirmed). The delegation refactor is safe.
6. **Public route `Body` zod schema is a flat object** with `variables?: string[]`, no `templateParams`, and surfaces `result.code` verbatim (`status: result.code`). **Confirmed** — matches §6.1/§6.2. The `.refine` the design adds is additive.
7. **Session route `/api/messages/send` passes only `variables`** (never `templateParams`/`namedParams`, never header/button fields) and keeps the `result.code === 402 ? 400` remap. **Confirmed** — matches §3/§5.5/§8/FR4.5. The design's "no logic change required" is accurate.
8. **Templates route returns `{...t, buttons, variableCount}`** and the additive `namedParams` field is a clean extension. **Confirmed** — matches §6.3.
9. **Schema types:** `body String`, `headerType String?`, `buttons String? // stored as JSON string`. **Confirmed** — matches A3/A5; `parseJsonColumn(template.buttons)` for the button-dynamic check is the right accessor.
10. **Auth-OTP guard and credit-check anchors exist verbatim** as quoted in §5.1: the `if (template.category === "authentication" && !variables?.[0])` early return, followed later by `if (!isSuperAdmin) { const userCredits = await prisma.userCredits.findUnique(...) }`. **Confirmed** — the gate insertion point is real and unambiguous.
11. **Base64→MediaStore write is a real DB side effect** (`createClient(...)` + `INSERT INTO MediaStore`) that currently runs post-credit-check, inside the Meta-send block. **Confirmed** — the §5.1/Finding-1 reasoning (presence-only pre-charge gate; write stays post-charge) is faithful to the code's current ordering.
12. **`mediaId` is accepted end-to-end but never read in component construction.** `send-template.ts` destructures `mediaId` but never references it after. **Confirmed** — §5.3/Finding-6 "dead input, remains unused" is accurate.
13. **Meta error surfacing** `errorMessage = details ? \`${baseMsg}: ${details}\` : baseMsg` and the payload `console.log` (no token; `Authorization` header never logged). **Confirmed** — matches §5.6/§5.7/NFR4.
14. **Send path uses `graph.facebook.com/v19.0/{phoneNumberId}/messages`.** **Confirmed** — the §10 decision to pin the diagnostic to `v19.0` matches the sender.

## Unverified / wrong assumptions

- **`niqen_invite` real body + declared order (A1/AC4) is NOT verified** — the actual approved template is not in the repo. The design correctly does NOT treat the assumed order (`event, guest_name, event_name, event_date, venue_name, allowed_guests`) as ground truth: §7 and §10 label it illustrative and require the real `components` to be captured at implementation time, with `/docs` and the §7 trace updated to the recorded order. This is the right posture; it is a deliberate implementation-time step, not a design gap.
- **`buttonUrlIsDynamic`, `template-params.ts`, `parseTemplateBody`, `resolveBodyParams` do not exist yet** — they are new, to be created (design §3/§4). Not a defect; expected for a design doc. Their specified signatures and behavior are internally consistent.
- **No tenant auth template with a media header is confirmed** — the design flags this as an explicit §10 ground-truth check before the uniform media-header 400 ships, with a carve-out plan if one is found. Correctly handled as a checked precondition, not an assumption.

---

## Findings

### Checks requested by the step prompt — all PASS

- **Named-vs-numbered body construction unambiguous and Meta-correct:** §5.2 emits `{type:"text", parameter_name, text}` for named and `{type:"text", text}` for numbered; the numbered branch is byte-identical to the current `vars.map(v => ({type:"text", text:v}))`. Named set == `model.names` exactly (complete, no extras). PASS.
- **Ordered/de-duplicated named parse well-defined:** §4.1 step 1/4 — single left-to-right scan, first-occurrence kept, later duplicates dropped. Deterministic. PASS.
- **Positional→named mapping order explicit:** §4.2 named/positional branch zips `names[i] → variables[i]` against the distinct de-duplicated name list; count validated against `model.names.length` (Finding 5). PASS.
- **Header/button pitfalls avoided:** §5.3 deletes the Unsplash and dummy.pdf blocks; §5.4 step 3 deletes the `niqen_invite`/`"rsvp"` branch; dynamic buttons come only from `buttonParam`/`buttonUrlParam`. PASS.
- **Back-compat (positional + numbered) preserved:** §8 — numbered output unchanged; positional for named produces identical component to named-map. PASS.
- **Session route unchanged:** §3/§8 — no logic change, confirmed against source. PASS.
- **Ground-truth diagnostic specified:** §10 — pinned `v19.0`, exact `fields=`, records BODY named params / HEADER format / BUTTON url static-vs-`{{}}`, token referenced by key name only. PASS.

### NIT findings (non-blocking)

1. **NIT — Docs section labels use "§6" / numbered sections that don't exist in `docs/page.tsx`.** The design (§3 and §6.3) says to document the contract "in §6 (`POST /api/v1/messages`)" and "the `GET /api/v1/templates` subsection." The actual `src/app/docs/page.tsx` is JSX with comment markers (`{/* POST /api/v1/messages */}`, `{/* GET /api/v1/templates */}`), not numbered sections. Concrete fix: implementer should target the `{/* POST /api/v1/messages */}` and `{/* GET /api/v1/templates */}` blocks (around lines 459 and 532) rather than looking for a literal "§6". No behavioral impact.

2. **NIT — `buttonUrlIsDynamic` must tolerate the current button-JSON shapes.** The schema stores `buttons` as a JSON string of button objects (e.g. `[{ "type": "URL", "text": "Track", "url": "https://..." }]`, per docs example). §5.4 says a button is dynamic iff a URL-type button's `url` contains `{{...}}`, and that null/unparseable → not dynamic. Concrete fix: in `buttonUrlIsDynamic`, after `parseJsonColumn`, guard for both an array and a non-array/garbage result, and match `type` case-insensitively (stored value is upper-case `"URL"` in the docs sample) before testing `url.includes("{{")`. This keeps the helper from under-detecting a dynamic URL button whose `type` is `"URL"`. The design already says to use `parseJsonColumn` and to treat garbage as non-dynamic, so this is a clarifying note, not a correction.

3. **NIT — Gate check (c) references `buttonUrlIsDynamic(template.buttons)` while §5.4 signature is `buttonUrlIsDynamic(buttonsJson: string | null)`.** These agree (`template.buttons` is `string | null`), but §5.1 also computes `const btnParam = buttonParam || buttonUrlParam` inside the gate AND §5.4 recomputes the same `btnParam` and the same `buttonIsDynamic` for emission. Concrete fix: compute `buttonIsDynamic` and `btnParam` once (e.g. in the gate) and reuse in §5.4 emission so the two sites can't diverge if one is edited later. Purely a code-hygiene suggestion; both sites are specified identically today.

---

## Traceability spot-check

FR1–FR5, NFR1–NFR6, AC1–AC16 each map to a concrete section (design §13). I confirmed the non-obvious ones: AC5 (pre-charge 400, no credit, no row) is guaranteed by the pure gate sitting before `message.create` and the credit decrement (§5.1 ordering, verified against the real statement order in `send-template.ts`); AC6/AC11 (numbered byte-identical, session route unchanged) hold because neither branch nor route is touched; AC13 (docs) is specified concretely in §6.3; FR6/AC14 (webhook/`deliveredAt`) is documentation-only in §11.

No conflicting information between sections was found. No scope creep beyond the requirements (the only additions — `templateParams` field, `namedParams` response field, `countVariables` delegation — are each tied to an FR/AC and are additive/non-breaking).
