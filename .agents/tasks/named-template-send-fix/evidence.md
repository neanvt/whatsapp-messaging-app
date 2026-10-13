# Evidence — Named-parameter template send fix

Ground-truth diagnostics, generated payloads, and verification results.
No secrets recorded here. The Meta access token was read from `.env`
(`META_ACCESS_TOKEN`) at run time and NEVER printed, echoed, logged, or committed.

## 1. Ground-truth Graph API call (AC1)

Pinned to Graph `v19.0` (same version the send path uses), WABA `1290990196241997`,
phoneNumberId `1068572486335513`:

```
GET https://graph.facebook.com/v19.0/1290990196241997/message_templates
    ?name=niqen_invite&fields=name,status,category,language,components
Authorization: Bearer <META_ACCESS_TOKEN from .env — not shown>
```

Token was VALID (HTTP 200, real components returned — no `#190`/expired error).

### Returned `niqen_invite` structure (the authoritative ground truth)

- `name`: `niqen_invite`
- `status`: `APPROVED`
- `category`: `MARKETING`
- `language`: `en`
- `id`: `1432908958796867`

Components:

1. **HEADER** — `format: IMAGE`. Declares a static sample via
   `example.header_handle` (an uploaded sample image). A `format: IMAGE` header
   REQUIRES a runtime header component (link or media id) on every send — the
   uploaded sample is only for template review, not a send-time default
   (confirmed by Meta docs: a header component is required when the template uses
   a media header). Content was rephrased for compliance with licensing
   restrictions. Source:
   [Meta — send message templates (header required for image header)](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates/carousel-template-messages/).

2. **BODY** — NAMED parameters. `example.body_text_named_params` declares **8**
   params in this exact first-occurrence order (matches the body text scan):

   | # | param_name       |
   |---|------------------|
   | 1 | `event`          |
   | 2 | `guest_name`     |
   | 3 | `event_name`     |
   | 4 | `event_date`     |
   | 5 | `venue_name`     |
   | 6 | `allowed_guests` |
   | 7 | `pass_url`       |
   | 8 | `card_url`       |

   (The requirements/design assumed 6 named params ending at `allowed_guests`.
   The LIVE template has **8** — it additionally has `pass_url` and `card_url`.
   The fix derives the names from the live `template.body` at run time, so the
   code adapts automatically; only the docs example order text is updated to the
   real 8-name list. The derivation code is unchanged.)

3. **BUTTONS** — ONE `URL` button, `text: "Confirm Your Visit"`,
   `url: "https://invitation.kmcitymathura.com/{{1}}"` → **DYNAMIC** (contains a
   `{{1}}` suffix variable). `buttonUrlIsDynamic(template.buttons)` returns true
   for this, so the send requires a `buttonParam` (the URL suffix). A missing
   `buttonParam` yields a pre-charge 400 — correct, and replaces the old literal
   `"rsvp"` fallback bug.

### Auth-template media-header check (Finding 2)

Design §5.1 applies the media-header 400 uniformly, including to authentication
templates, on the assumption that no auth template declares a media header.
`niqen_invite` is `MARKETING`, not auth. The product's authentication templates
(`otp_1`, etc.) are text-body + copy-code button only (no media header), so the
uniform media-header 400 does not regress any real auth send. If an auth template
with a media header is ever added, gate check (b) would need an auth carve-out.

## 2. Corrected payload shape the new code generates for `niqen_invite`

With the live structure (IMAGE header + 8 named body params + dynamic URL button),
a correct send MUST provide: the 8 named body params (via `templateParams` or a
positional `variables` array of 8), a header media source (`mediaUrl` /
`documentUrl` / base64), and a `buttonParam` for the dynamic URL button.

Named-map request (illustrative values):

```json
{
  "recipient": "917088970099",
  "templateName": "niqen_invite",
  "mediaUrl": "https://example.com/invite.jpg",
  "buttonParam": "abc123",
  "templateParams": {
    "event": "KM City Grand Launching",
    "guest_name": "Arun Agrawal",
    "event_name": "KM City Grand Launching",
    "event_date": "21/10/2026 | 7:00pm onwards",
    "venue_name": "KM City, Nr. Goverdhan Chowk, Mathura",
    "allowed_guests": "2",
    "pass_url": "https://niqen.app",
    "card_url": "https://niqen.app"
  }
}
```

Generated Meta `components` (header first, then body in declared order, then button):

```json
[
  { "type": "header", "parameters": [
      { "type": "image", "image": { "link": "https://example.com/invite.jpg" } } ] },
  { "type": "body", "parameters": [
      { "type": "text", "parameter_name": "event",          "text": "KM City Grand Launching" },
      { "type": "text", "parameter_name": "guest_name",     "text": "Arun Agrawal" },
      { "type": "text", "parameter_name": "event_name",     "text": "KM City Grand Launching" },
      { "type": "text", "parameter_name": "event_date",     "text": "21/10/2026 | 7:00pm onwards" },
      { "type": "text", "parameter_name": "venue_name",     "text": "KM City, Nr. Goverdhan Chowk, Mathura" },
      { "type": "text", "parameter_name": "allowed_guests", "text": "2" },
      { "type": "text", "parameter_name": "pass_url",       "text": "https://niqen.app" },
      { "type": "text", "parameter_name": "card_url",       "text": "https://niqen.app" }
    ] },
  { "type": "button", "sub_type": "url", "index": "0",
    "parameters": [ { "type": "text", "text": "abc123" } ] }
]
```

Every `parameter_name` is a member of the declared named set, the set is complete
(all 8 present), and there are no extras — this satisfies `#132000` (count/param
match) and `#100` (valid parameter), the two errors being fixed. The old
index-based mapping would have mis-named these; the new resolver maps strictly by
the de-duplicated declared order.

### Why the prior behavior failed (root cause confirmed)

The old `send-template.ts` built the body as `vars.map((v, idx) => ({ parameter_name: namedMatches[idx], ... }))` against a NON-de-duplicated scan, and only
emitted body params when the caller passed `variables` — but it injected a dummy
Unsplash IMAGE header and a literal `"rsvp"` button via the `niqen_invite`
hardcode. For this template that produced a wrong header image, a bogus button
value, and (with the real 8-param body) a param-count/name mismatch → the
`#132000`/`#100` failures. The new structure-driven path emits the correct image
header (from a caller-supplied source), the exact 8 named body params, and the
dynamic button from `buttonParam`.

## 3. Live test send (optional proof)

A live send was NOT performed in this iteration. `niqen_invite` requires a real
header image URL and a real dynamic button suffix in addition to the 8 body
params; sending dummy values to the real recipient `917088970099` would deliver a
broken/incorrect invitation to a real phone. The structural root-cause fix is
proven by: (a) the ground-truth structure above, (b) the generated payload shape
matching Meta's named-param contract, and (c) the 21 passing pure-function unit
tests (`node scripts/test-template-params.mjs`). The build gate (below) is the
authoritative AC15 gate. A live proof can be run by an operator with a valid
header image + button value once available.

## 4. Verification results

| Check | Result |
|-------|--------|
| `npm run build` | exit 0 (prisma generate + next build typechecked the whole tree) |
| `npm run lint` | clean (only pre-existing `react-hooks/exhaustive-deps` warnings in unrelated dashboard pages) |
| `node scripts/test-template-params.mjs` | 21/21 passed, exit 0 |

### Numbered-template non-regression (static trace)

For `otp_1` (body `{{1}}`) and `migration_alert_v2` (numbered body):
`parseTemplateBody` → `{ kind: "numbered", count }`; `resolveBodyParams` →
`{ kind: "numbered", values: variables }`; the BODY builder emits
`{ type: "text", text: v }` with **NO** `parameter_name` — byte-for-byte identical
to the previous `vars.map(v => ({ type:"text", text:v }))` branch. No header
component is emitted for a text/none header; no generic button component is
emitted for a non-dynamic button. Confirmed identical positional payload (AC6).

### Authentication #131008 button + OTP guard (confirmed intact)

- The early missing-OTP 400 guard
  (`if (template.category === "authentication" && !variables?.[0])`) is unchanged
  and still runs BEFORE the pre-charge gate and before any credit/row.
- The copy-code URL button
  (`sub_type:"url", index:"0", parameters:[{type:"text", text: variables[0]}]`) is
  still emitted for `category === "authentication" && variables?.[0]`, independent
  of `resolvedBody.kind`. Auth templates are exempt from the generic dynamic-URL
  button 400.

### Session route unchanged (confirmed)

`src/app/api/messages/send/route.ts` was NOT modified. It still destructures only
`numberId, recipient, templateId, variables`, never sets `templateParams`/`namedParams`,
passes positional `variables` into the same `sendTemplateMessage`, and keeps its
402→400 remap. Observably unchanged for existing callers (AC11).

## 5. Separate webhook/delivery note (FR6 / AC14 — documented, not fixed)

`Message.deliveredAt` staying null (Insights "Message delivered: 0") is a DISTINCT
problem from the `#132000` send bug. A send can be accepted by Meta (200 + wamid,
`status="sent"`) yet never receive a delivery status callback. Root cause is on the
webhook path: `/api/webhooks/whatsapp` verifies `X-Hub-Signature-256` against the
app secret — if `META_APP_SECRET` is unset on the deploy (or the WABA is not
subscribed to the `messages` webhook field), every signed status POST fails
verification (401) or is never sent, so `deliveredAt` is never written. Remediation
is a separate task (set `META_APP_SECRET`, confirm the WABA webhook subscription).
No code change for this in the current task.
