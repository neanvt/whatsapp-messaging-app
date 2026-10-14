import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Developer Documentation — WhatsApp Business",
  description:
    "Connect your WhatsApp number to the platform and integrate the messaging APIs into your own application: tokens, endpoints, webhooks, and an end-to-end walkthrough.",
};

// Small presentational helper for code/JSON samples. Content is passed as a
// plain string child so JSX never has to parse braces/quotes inside samples.
function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 rounded-md p-4 overflow-x-auto text-sm">
      <code>{children}</code>
    </pre>
  );
}

function Method({ children }: { children: string }) {
  return (
    <span className="inline-block rounded bg-gray-200 text-gray-800 font-mono text-xs px-2 py-0.5 mr-2 align-middle">
      {children}
    </span>
  );
}

export default function DocsPage() {
  const lastUpdated = "October 14, 2026";

  const toc: Array<{ id: string; label: string }> = [
    { id: "overview", label: "1. Overview" },
    { id: "prerequisites", label: "2. Prerequisites" },
    { id: "access-token", label: "3. How to get a WhatsApp access token" },
    { id: "connecting", label: "4. Connecting a number in this app" },
    { id: "sending", label: "5. Sending messages" },
    {
      id: "m2m-api",
      label: "6. Connect a third-party application (Server-to-server API)",
    },
    { id: "receiving", label: "7. Receiving data (webhook)" },
    { id: "api-reference", label: "8. API reference" },
    { id: "walkthrough", label: "9. Integration walkthrough" },
    { id: "env", label: "10. Environment / configuration reference" },
    { id: "troubleshooting", label: "11. Troubleshooting" },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-gray-900">
            WhatsApp Business
          </Link>
          <Link href="/login" className="text-sm text-blue-600 hover:underline">
            Back to Login
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 py-12 space-y-8">
        {/* Intro card */}
        <div className="bg-white rounded-lg shadow-sm border p-8 space-y-4">
          <h1 className="text-3xl font-bold text-gray-900">
            Developer Documentation
          </h1>
          <p className="text-sm text-gray-500">Last updated: {lastUpdated}</p>
          <p className="text-gray-700 leading-relaxed">
            This guide shows a developer or tenant how to (A) connect a WhatsApp
            Business number to this platform and (B) integrate the platform APIs
            into their own application to send messages and read delivery and
            conversation data. Every endpoint below is documented from the real
            route handlers — method, path, auth, request body, and the status
            codes the code actually returns.
          </p>

          {/* Table of contents */}
          <nav className="bg-gray-50 rounded-md p-4">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">
              On this page
            </h2>
            <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
              {toc.map((item) => (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    className="text-blue-600 hover:underline"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {/* 1. Overview */}
        <section
          id="overview"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-4 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">1. Overview</h2>
          <p className="text-gray-700 leading-relaxed">
            This platform is a multi-tenant SaaS built on the Meta WhatsApp Cloud
            API. Each tenant connects their own WhatsApp Business number, manages
            Meta-approved message templates, sends template messages, and holds a
            two-way chat with contacts. Every tenant&apos;s per-number
            credentials — WABA ID, Phone Number ID, and access token — are stored
            encrypted (AES-256-GCM) and scoped to that tenant. A tenant can only
            ever read or act on records they own.
          </p>
          <p className="text-gray-700 leading-relaxed">
            There are two ways the platform talks to Meta on your behalf:
          </p>
          <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
            <li>
              <strong>Model A — shared platform Meta app.</strong> The platform
              owns a Meta app (set in environment variables). If you have not
              connected your own Meta app, your Embedded Signup OAuth exchange and
              inbound-webhook signature verification run against the platform app.
              This is the default fallback.
            </li>
            <li>
              <strong>Model B — bring your own Meta app.</strong> From{" "}
              <strong>Dashboard → Settings → Meta App</strong> you can connect
              your own Meta app (App ID, write-only App Secret, and optional
              Embedded Signup Config ID). When present, it overrides the platform
              app for your OAuth exchange and webhook verification. Your app
              secret is stored encrypted and is never returned by the API.
            </li>
          </ul>
          <p className="text-gray-700 leading-relaxed">
            Model A and Model B describe the <em>app</em> used for onboarding and
            webhook verification. The <em>per-number</em> credentials (WABA ID,
            Phone Number ID, access token) always live encrypted in the database
            per number — they are not environment variables.
          </p>
        </section>

        {/* 2. Prerequisites */}
        <section
          id="prerequisites"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-4 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            2. Prerequisites
          </h2>
          <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
            <li>A Meta Business account (business.facebook.com).</li>
            <li>
              A WhatsApp Business Account (WABA) with at least one registered
              phone number.
            </li>
            <li>
              For Model B only: a Meta app (developers.facebook.com) with the
              WhatsApp product added, plus App Review approval for the two
              WhatsApp permissions if you use Embedded Signup.
            </li>
            <li>
              An account on this platform (register with name, email, password —
              see the API reference).
            </li>
          </ul>
        </section>

        {/* 3. Access token */}
        <section
          id="access-token"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-5 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            3. How to get a WhatsApp access token
          </h2>
          <p className="text-gray-700 leading-relaxed">
            The manual connect flow needs a Meta access token for your phone
            number. There are three kinds of token. Choose based on whether you
            are testing or running in production.
          </p>

          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              (a) Temporary token — testing only (~24 hours)
            </h3>
            <p className="text-gray-700 leading-relaxed">
              In developers.facebook.com, open your app →{" "}
              <strong>WhatsApp → API Setup</strong>. A temporary access token is
              shown there. It is convenient for a quick test but expires in about
              24 hours. Once it expires, sends fail with a &quot;not
              connected&quot; / auth error, so do not use it for anything but a
              smoke test.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              (b) System User token — recommended, never expires
            </h3>
            <p className="text-gray-700 leading-relaxed">
              A permanent System User token is the right choice for production.
              Create it in Meta Business Settings:
            </p>
            <ol className="list-decimal list-inside space-y-1 text-gray-700 pl-2">
              <li>
                Open <strong>Business Settings → Users → System Users</strong>.
              </li>
              <li>
                Click <strong>Add</strong> to create a system user (give it a
                name and the Admin or Employee role).
              </li>
              <li>
                Assign the <strong>app</strong> as an asset to the system user
                with <strong>Full control</strong>.
              </li>
              <li>
                Assign the <strong>WABA</strong> as an asset to the system user
                with <strong>Full control</strong>.
              </li>
              <li>
                Click <strong>Generate New Token</strong> and select the app.
              </li>
              <li>
                Set the token expiration to <strong>Never</strong>.
              </li>
              <li>
                Check the scopes{" "}
                <code className="font-mono text-sm">
                  whatsapp_business_messaging
                </code>{" "}
                and{" "}
                <code className="font-mono text-sm">
                  whatsapp_business_management
                </code>
                .
              </li>
              <li>
                Click <strong>Generate</strong> and copy the token immediately —
                it is shown once.
              </li>
            </ol>
            <div className="bg-amber-50 border border-amber-200 rounded-md p-4 text-sm text-amber-900 space-y-2">
              <p className="font-semibold">Common pitfalls</p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <strong>&quot;No permissions available&quot;</strong> when
                  generating the token means the system user has no app role yet.
                  Assign the app to the system user first, then generate.
                </li>
                <li>
                  <strong>
                    &quot;App can&apos;t be updated / complete confirmation
                    steps&quot;
                  </strong>{" "}
                  means the app has pending Required Actions in
                  developers.facebook.com. Clear them first: accept the developer
                  terms, enable two-factor authentication, and add a privacy
                  policy URL.
                </li>
              </ul>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              (c) Embedded Signup — automatic token capture
            </h3>
            <p className="text-gray-700 leading-relaxed">
              Embedded Signup captures a token automatically through a Meta OAuth
              popup, with no copy-paste. It requires an Embedded Signup Config ID
              and App Review approval for the two WhatsApp permissions. The
              platform exchanges the returned OAuth code for a business token and
              stores it encrypted — you never see or paste the token. Note that an
              Embedded Signup business token may still carry an expiry; for a
              non-expiring guarantee in production, a System User token is
              preferred.
            </p>
          </div>
        </section>

        {/* 4. Connecting */}
        <section
          id="connecting"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-5 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            4. Connecting a number in this app
          </h2>
          <p className="text-gray-700 leading-relaxed">
            A number is only ever marked <strong>verified</strong> by connecting
            real Meta credentials. There is no &quot;enter a code we
            generated&quot; flow. Both paths validate against Meta before any
            database write and reject a number already owned by another tenant
            with a 409.
          </p>

          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              Manual path
            </h3>
            <ol className="list-decimal list-inside space-y-1 text-gray-700 pl-2">
              <li>
                Go to <strong>Dashboard → WhatsApp Numbers → Add Number</strong>.
              </li>
              <li>
                Choose <strong>Enter credentials manually</strong>.
              </li>
              <li>
                Paste your <strong>WABA ID</strong>, <strong>Phone Number ID</strong>,
                and <strong>Access Token</strong> (and an optional label).
              </li>
            </ol>
            <p className="text-gray-700 leading-relaxed">
              Those three inputs map exactly to the{" "}
              <code className="font-mono text-sm">POST /api/numbers/manual</code>{" "}
              request body fields <code className="font-mono text-sm">wabaId</code>,{" "}
              <code className="font-mono text-sm">phoneNumberId</code>, and{" "}
              <code className="font-mono text-sm">accessToken</code>.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              Embedded Signup button
            </h3>
            <p className="text-gray-700 leading-relaxed">
              On the same Add Number page, the <strong>Connect with
              Facebook</strong> button opens Meta&apos;s OAuth popup. On success
              the browser posts the returned OAuth code to{" "}
              <code className="font-mono text-sm">
                POST /api/numbers/embedded-signup
              </code>
              , and the server exchanges it for a token and stores everything
              encrypted. No token copy-paste.
            </p>
          </div>

          <p className="text-gray-700 leading-relaxed">
            The <em>app-level</em> App ID / App Secret / Config ID are separate
            from the per-number fields above: they come from environment variables
            (Model A) or from <strong>Settings → Meta App</strong> (Model B).
          </p>
        </section>

        {/* 5. Sending */}
        <section
          id="sending"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-5 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            5. Sending messages
          </h2>
          <p className="text-gray-700 leading-relaxed">
            There are two send paths:
          </p>
          <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
            <li>
              <strong>Template send</strong> via{" "}
              <code className="font-mono text-sm">POST /api/messages/send</code>.
              You supply <code className="font-mono text-sm">numberId</code>,{" "}
              <code className="font-mono text-sm">recipient</code>, and{" "}
              <code className="font-mono text-sm">templateId</code> (plus optional{" "}
              <code className="font-mono text-sm">variables</code>). The number
              must be verified and the template approved. Each successful send
              costs <strong>1 credit</strong> (superadmins are exempt); if the
              send fails, the credit is refunded.
            </li>
            <li>
              <strong>Free-text reply</strong> via{" "}
              <code className="font-mono text-sm">
                POST /api/chat/[contactPhone]/send
              </code>
              . Free-text is only allowed inside WhatsApp&apos;s 24-hour customer
              service window (after the contact messages you first). No credit is
              deducted on this path.
            </li>
          </ul>
          <div className="bg-blue-50 border border-blue-200 rounded-md p-4 text-sm text-blue-900">
            <strong>Authentication templates:</strong> a template whose category
            is <code className="font-mono">authentication</code> requires the OTP
            code as the first entry of{" "}
            <code className="font-mono">variables</code>. If it is missing, the
            send is rejected with a 400 before any message record or credit
            change. The route also attaches the OTP to the template&apos;s
            copy-code URL button; without it Meta returns error (#131008).
          </div>
        </section>

        {/* 6. Connect a third-party application (Server-to-server API) */}
        <section
          id="m2m-api"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-5 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            6. Connect a third-party application (Server-to-server API)
          </h2>
          <p className="text-gray-700 leading-relaxed">
            The public <code className="font-mono text-sm">/api/v1</code> API lets
            your own backend send messages and read data without ever touching a
            Meta credential, a Phone Number ID, or a WABA ID. You mint an API key
            in the dashboard, bind it to one of your verified numbers, and your
            third-party server authenticates with just that key.
          </p>

          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              Create a key
            </h3>
            <ol className="list-decimal list-inside space-y-1 text-gray-700 pl-2">
              <li>
                Go to <strong>Dashboard → API Keys</strong>.
              </li>
              <li>
                Give the key a name and pick one of your{" "}
                <strong>verified</strong> numbers to bind it to.
              </li>
              <li>
                Click <strong>Create key</strong> and copy the{" "}
                <code className="font-mono text-sm">wa_live_…</code> secret. It is
                shown <strong>once</strong> — if you lose it, revoke the key and
                create a new one.
              </li>
            </ol>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-md p-4 text-sm text-blue-900 space-y-2">
            <p className="font-semibold">The bearer scheme</p>
            <p>
              Send the key on every request as{" "}
              <code className="font-mono">
                Authorization: Bearer wa_live_xxx
              </code>
              . Your third party supplies <strong>zero</strong> Meta credentials
              and <strong>zero</strong> number information — the key is bound to a
              number server-side, so the platform fills in the Phone Number ID and
              decrypted token for you. A key only ever acts on its owner&apos;s
              data; it can never read or send for another tenant.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              Lifecycle
            </h3>
            <ul className="list-disc list-inside space-y-1 text-gray-700 pl-2">
              <li>The plaintext key is revealed once, at creation.</li>
              <li>
                Revoke a key from <strong>Dashboard → API Keys</strong>; a revoked
                key returns <code className="font-mono text-sm">401</code>{" "}
                immediately.
              </li>
              <li>
                To point a key at a different number, revoke it and create a new
                one (the number binding is fixed at creation).
              </li>
            </ul>
          </div>

          {/* POST /api/v1/messages */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/v1/messages
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> API key (Bearer). Sends an approved template
              through the key&apos;s bound number. Costs 1 credit on success
              (refunded on failure; superadmins exempt).
            </p>
            <p className="text-gray-700">
              <strong>Body (JSON):</strong>{" "}
              <code className="font-mono text-sm">recipient</code> (string, req —
              phone, non-digits are stripped), exactly one of{" "}
              <code className="font-mono text-sm">templateName</code> or{" "}
              <code className="font-mono text-sm">templateId</code> (string, req —
              an approved template you own), and the template&apos;s variables in{" "}
              <strong>one</strong> of two forms (not both). There is no number
              field — the bound number is always used.
            </p>
            <p className="text-gray-700">
              <strong>Variables — positional (back-compat):</strong>{" "}
              <code className="font-mono text-sm">variables</code> (string[]) — an
              ordered array of values. For a <em>numbered</em> template (
              <code className="font-mono text-sm">{"{{1}}"}</code>,{" "}
              <code className="font-mono text-sm">{"{{2}}"}</code>…) they map to{" "}
              <code className="font-mono text-sm">{"{{1}}..{{n}}"}</code> in order.
              For a <em>named</em> template they map, in order, to the
              template&apos;s declared parameter names (see the deterministic
              order below). For an authentication template,{" "}
              <code className="font-mono text-sm">variables[0]</code> must be the
              OTP code.
            </p>
            <p className="text-gray-700">
              <strong>Variables — named map (new):</strong>{" "}
              <code className="font-mono text-sm">templateParams</code> (object)
              — a map of{" "}
              <code className="font-mono text-sm">
                {'{ "<name>": "<value>" }'}
              </code>{" "}
              whose keys are the template&apos;s declared named parameters. Key
              order in the JSON does not matter; values are emitted in the
              template&apos;s declared order. Use this for named templates (e.g.{" "}
              <code className="font-mono text-sm">niqen_invite</code>).
            </p>
            <p className="text-gray-700">
              <strong>Deterministic order &amp; disambiguation:</strong> a
              named template&apos;s declared order is the{" "}
              <strong>
                first-occurrence, distinct, left-to-right order of{" "}
                <code className="font-mono text-sm">{"{{name}}"}</code>{" "}
                placeholders in the body
              </strong>{" "}
              (a name that repeats consumes exactly one value). Read{" "}
              <code className="font-mono text-sm">namedParams</code> from{" "}
              <code className="font-mono text-sm">GET /api/v1/templates</code> to
              get this list. A request is treated as the named-map form iff{" "}
              <code className="font-mono text-sm">templateParams</code> is present
              and non-empty; otherwise it uses{" "}
              <code className="font-mono text-sm">variables</code>. Sending both
              is a 400. Names/counts are validated against the template{" "}
              <strong>before any credit is charged</strong>: a missing/extra name
              or wrong count returns a 400 (echoing expected vs provided) with no
              credit deducted and no message row persisted.
            </p>
            <CodeBlock>{`# Positional (numbered template)
curl -X POST https://wa.digineanv.app/api/v1/messages \\
  -H "Authorization: Bearer wa_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"recipient":"15551234567","templateName":"order_update","variables":["1234"]}'

# Named map (named template, e.g. niqen_invite)
# This template also has an IMAGE header (send mediaUrl) and a dynamic
# URL button (send buttonParam) in addition to its named body params.
curl -X POST https://wa.digineanv.app/api/v1/messages \\
  -H "Authorization: Bearer wa_live_xxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"recipient":"15551234567","templateName":"niqen_invite","mediaUrl":"https://example.com/invite.jpg","buttonParam":"abc123","templateParams":{"event":"E","guest_name":"G","event_name":"N","event_date":"D","venue_name":"V","allowed_guests":"2","pass_url":"https://example.com/pass","card_url":"https://example.com/card"}}'`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong>
            </p>
            <CodeBlock>{`{ "id": "msg_789", "status": "sent", "metaMessageId": "wamid.XXXX" }`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 missing/invalid key; 400 invalid body
              (missing recipient, not exactly one of templateName/templateId, both
              variables and templateParams supplied, a named-parameter name/count
              mismatch, a media header with no media source, a dynamic URL button
              with no buttonParam, or a missing OTP variable) or the template
              exists but is not approved; 402 insufficient credits (before
              contacting Meta); 404 the template is not found for your account; 500
              the bound number is not connected or Meta rejected the send (the
              credit is refunded).
            </p>
          </div>

          {/* GET /api/v1/messages/[id] */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/v1/messages/[id]
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> API key (Bearer). Returns the status of one
              message sent through the key&apos;s bound number.
            </p>
            <CodeBlock>{`curl https://wa.digineanv.app/api/v1/messages/MESSAGE_ID \\
  -H "Authorization: Bearer wa_live_xxxxxxxx"`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong>
            </p>
            <CodeBlock>{`{
  "id": "msg_789",
  "recipientPhone": "15551234567",
  "templateId": "tpl_456",
  "templateName": "order_update",
  "status": "delivered",
  "metaMessageId": "wamid.XXXX",
  "errorMessage": null,
  "sentAt": "2026-10-13T12:00:00.000Z",
  "deliveredAt": "2026-10-13T12:00:03.000Z",
  "readAt": null,
  "createdAt": "2026-10-13T12:00:00.000Z",
  "direction": "outbound",
  "templateVariables": ["1234"],
  "bodyPreview": "Hi 1234, your order has shipped."
}`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <code className="font-mono text-sm">templateVariables</code> is the
              values actually sent, normalized to an array (numbered templates),
              an object (named templates), or{" "}
              <code className="font-mono text-sm">null</code>;{" "}
              <code className="font-mono text-sm">bodyPreview</code> is the
              template body with those values substituted (placeholders with no
              value are left intact).
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 missing/invalid key; 404 unknown
              message id (an id that does not exist, or one owned by another
              user/number, returns the same 404 — no existence oracle).
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Note on delivery status:</strong> a{" "}
              <code className="font-mono text-sm">status</code> of{" "}
              <code className="font-mono text-sm">sent</code> with a{" "}
              <code className="font-mono text-sm">metaMessageId</code> but a null{" "}
              <code className="font-mono text-sm">deliveredAt</code> (Insights
              showing &quot;Message delivered: 0&quot;) is a{" "}
              <strong>separate</strong> concern from the send call itself. The
              send was accepted by Meta; the delivery/read callbacks arrive on the
              status webhook. If they never arrive, the usual causes are the
              app-level webhook secret (<code className="font-mono text-sm">META_APP_SECRET</code>) not being set on the deploy
              so signed status POSTs fail verification, or the WABA not being
              subscribed to the <code className="font-mono text-sm">messages</code>{" "}
              webhook field. This is unrelated to template-variable formatting.
            </p>
          </div>

          {/* GET /api/v1/messages (LIST) */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/v1/messages
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> API key (Bearer). Lists messages sent through
              the key&apos;s bound number (owner + number scoped) so you can pull
              delivery/read status in bulk. Ordered newest first (
              <code className="font-mono text-sm">createdAt</code> descending).
            </p>
            <p className="text-gray-700">
              <strong>Query (all optional):</strong>
            </p>
            <ul className="list-disc pl-6 text-gray-700 text-sm space-y-1">
              <li>
                <code className="font-mono text-sm">limit</code> — page size,
                default <code className="font-mono text-sm">50</code>, max{" "}
                <code className="font-mono text-sm">100</code> (values above 100
                are clamped; a non-integer or non-positive value falls back to
                50).
              </li>
              <li>
                <code className="font-mono text-sm">status</code> — filter;
                accepts only{" "}
                <code className="font-mono text-sm">
                  queued | sent | delivered | read | failed
                </code>
                . An unknown value returns 400. (Note: inbound rows may be
                returned with{" "}
                <code className="font-mono text-sm">status: &quot;received&quot;</code>{" "}
                in an unfiltered page even though{" "}
                <code className="font-mono text-sm">received</code> cannot be
                filtered for.)
              </li>
              <li>
                <code className="font-mono text-sm">since</code> — an ISO 8601
                instant with a <code className="font-mono text-sm">Z</code> or a{" "}
                <code className="font-mono text-sm">±HH:mm</code> offset
                (fractional seconds optional), e.g.{" "}
                <code className="font-mono text-sm">
                  2026-10-13T12:00:00.000Z
                </code>{" "}
                or{" "}
                <code className="font-mono text-sm">
                  2026-10-13T12:00:00+05:30
                </code>
                . Returns only rows with{" "}
                <code className="font-mono text-sm">createdAt</code> strictly
                after it. An invalid value returns 400.
              </li>
              <li>
                <code className="font-mono text-sm">after</code> — keyset
                pagination cursor; pass the previous response&apos;s{" "}
                <code className="font-mono text-sm">nextCursor</code>. An unknown
                or deleted cursor returns an empty page (not an error).
              </li>
            </ul>
            <p className="text-gray-700">
              <strong>Envelope:</strong>{" "}
              <code className="font-mono text-sm">
                {"{ data, nextCursor, hasMore }"}
              </code>
              . Keep requesting with{" "}
              <code className="font-mono text-sm">?after=&lt;nextCursor&gt;</code>{" "}
              while <code className="font-mono text-sm">hasMore</code> is true.
              Each item in <code className="font-mono text-sm">data</code> has the
              same shape as the single{" "}
              <code className="font-mono text-sm">GET /api/v1/messages/[id]</code>{" "}
              response above (id, recipientPhone, templateId, templateName,
              status, metaMessageId, errorMessage, sentAt, deliveredAt, readAt,
              createdAt, direction, normalized templateVariables, and
              bodyPreview).
            </p>
            <CodeBlock>{`curl "https://wa.digineanv.app/api/v1/messages?limit=50&status=delivered&since=2026-10-13T12:00:00+05:30" \\
  -H "Authorization: Bearer wa_live_xxxxxxxx"`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong>
            </p>
            <CodeBlock>{`{
  "data": [
    {
      "id": "msg_789",
      "recipientPhone": "15551234567",
      "templateId": "tpl_456",
      "templateName": "order_update",
      "status": "delivered",
      "metaMessageId": "wamid.XXXX",
      "errorMessage": null,
      "sentAt": "2026-10-13T12:00:00.000Z",
      "deliveredAt": "2026-10-13T12:00:03.000Z",
      "readAt": null,
      "createdAt": "2026-10-13T12:00:00.000Z",
      "direction": "outbound",
      "templateVariables": ["1234"],
      "bodyPreview": "Hi 1234, your order has shipped."
    }
  ],
  "nextCursor": "msg_789",
  "hasMore": true
}`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 missing/invalid key; 400 invalid{" "}
              <code className="font-mono text-sm">status</code> or{" "}
              <code className="font-mono text-sm">since</code>.
            </p>
          </div>

          {/* Live-status sync pattern */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              Live-status sync pattern
            </h3>
            <p className="text-gray-700">
              To keep your own records in sync with delivery/read status without
              running a webhook on your side:
            </p>
            <ol className="list-decimal pl-6 text-gray-700 text-sm space-y-1">
              <li>
                On <code className="font-mono text-sm">POST /api/v1/messages</code>
                , store the returned{" "}
                <code className="font-mono text-sm">id</code> (and optionally{" "}
                <code className="font-mono text-sm">metaMessageId</code>) against
                your own record.
              </li>
              <li>
                Poll{" "}
                <code className="font-mono text-sm">
                  GET /api/v1/messages/{"{id}"}
                </code>{" "}
                for one record, <strong>or</strong>{" "}
                <code className="font-mono text-sm">
                  GET /api/v1/messages?since=&lt;lastSyncISO&gt;
                </code>{" "}
                (then page with{" "}
                <code className="font-mono text-sm">after</code>) to pull all
                status changes in bulk.
              </li>
              <li>
                Reconcile{" "}
                <code className="font-mono text-sm">delivered</code>/
                <code className="font-mono text-sm">read</code>/
                <code className="font-mono text-sm">failed</code> plus the
                timestamps and{" "}
                <code className="font-mono text-sm">errorMessage</code> onto your
                own data.
              </li>
            </ol>
            <p className="text-gray-700 text-sm">
              The delivery-status caveat noted on the single-message endpoint (the
              app-level webhook secret and the{" "}
              <code className="font-mono text-sm">messages</code> subscription
              must be configured on this platform) still applies — if those are
              not set, statuses stay at{" "}
              <code className="font-mono text-sm">sent</code> and the sync will not
              observe <code className="font-mono text-sm">delivered</code>/
              <code className="font-mono text-sm">read</code> transitions.
            </p>
          </div>

          {/* GET /api/v1/templates */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/v1/templates
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> API key (Bearer). Lists your templates with
              their full content so the integration can render a preview and know
              how many variables to collect.{" "}
              <strong>Query (optional):</strong>{" "}
              <code className="font-mono text-sm">status</code> (one of{" "}
              <code className="font-mono text-sm">draft</code>,{" "}
              <code className="font-mono text-sm">pending</code>,{" "}
              <code className="font-mono text-sm">submitted</code>,{" "}
              <code className="font-mono text-sm">approved</code>,{" "}
              <code className="font-mono text-sm">rejected</code>).
            </p>
            <CodeBlock>{`curl "https://wa.digineanv.app/api/v1/templates?status=approved" \\
  -H "Authorization: Bearer wa_live_xxxxxxxx"`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong> each template includes its body (with{" "}
              <code className="font-mono text-sm">{"{{n}}"}</code> or{" "}
              <code className="font-mono text-sm">{"{{name}}"}</code>{" "}
              placeholders), header/footer/buttons, a{" "}
              <code className="font-mono text-sm">variableCount</code>, and a{" "}
              <code className="font-mono text-sm">namedParams</code> array.
            </p>
            <p className="text-gray-700 text-sm">
              <code className="font-mono text-sm">variableCount</code> is the
              number of <strong>numbered</strong> (
              <code className="font-mono text-sm">{"{{1}}"}</code>,{" "}
              <code className="font-mono text-sm">{"{{2}}"}</code>…) placeholders;
              for a <strong>named-parameter</strong> template it is{" "}
              <code className="font-mono text-sm">0</code>.{" "}
              <code className="font-mono text-sm">namedParams</code> lists the
              template&apos;s declared parameter names in the exact order to send
              (first-occurrence, distinct, left-to-right over the body); it is{" "}
              <code className="font-mono text-sm">[]</code> for numbered or
              no-placeholder templates. Send those values either as a{" "}
              <code className="font-mono text-sm">templateParams</code> object
              keyed by those names, or as a positional{" "}
              <code className="font-mono text-sm">variables</code> array in that
              same order.
            </p>
            <CodeBlock>{`[
  {
    "id": "tpl_456",
    "name": "order_update",
    "category": "utility",
    "language": "en",
    "status": "approved",
    "body": "Hi {{1}}, your order {{2}} has shipped.",
    "headerType": "text",
    "headerContent": "Order Update",
    "footerContent": "Reply STOP to opt out",
    "buttons": [{ "type": "URL", "text": "Track", "url": "https://..." }],
    "variableCount": 2,
    "namedParams": []
  },
  {
    "id": "tpl_789",
    "name": "niqen_invite",
    "category": "marketing",
    "language": "en",
    "status": "approved",
    "body": "VIP Invitation to {{event}} ... Dear {{guest_name}} ...",
    "headerType": "image",
    "headerContent": null,
    "footerContent": null,
    "buttons": [{ "type": "URL", "text": "Confirm Your Visit", "url": "https://.../{{1}}" }],
    "variableCount": 0,
    "namedParams": ["event", "guest_name", "event_name", "event_date", "venue_name", "allowed_guests", "pass_url", "card_url"]
  }
]`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 missing/invalid key; 400 an unknown{" "}
              <code className="font-mono">status</code> value.
            </p>
          </div>

          {/* GET /api/v1/templates/[id] */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/v1/templates/[id]
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> API key (Bearer). Returns one template&apos;s
              full content + <code className="font-mono text-sm">variableCount</code>,
              scoped to the key owner. A template that does not exist or belongs to
              another account returns an identical 404.
            </p>
            <CodeBlock>{`curl https://wa.digineanv.app/api/v1/templates/TEMPLATE_ID \\
  -H "Authorization: Bearer wa_live_xxxxxxxx"`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong>
            </p>
            <CodeBlock>{`{
  "id": "tpl_456",
  "name": "order_update",
  "category": "utility",
  "language": "en",
  "status": "approved",
  "body": "Hi {{1}}, your order {{2}} has shipped.",
  "headerType": "text",
  "headerContent": "Order Update",
  "footerContent": "Reply STOP to opt out",
  "buttons": [{ "type": "URL", "text": "Track", "url": "https://..." }],
  "variableCount": 2
}`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 missing/invalid key; 404 not found or
              not yours.
            </p>
          </div>

          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              Status codes
            </h3>
            <ul className="list-disc list-inside space-y-1 text-gray-700 pl-2">
              <li>
                <strong>401</strong> — missing/malformed{" "}
                <code className="font-mono text-sm">Authorization</code> header, a
                token not matching the <code className="font-mono text-sm">
                  wa_live_
                </code>{" "}
                shape, an unknown key, or a revoked key.
              </li>
              <li>
                <strong>400</strong> — body validation failure (missing{" "}
                <code className="font-mono text-sm">recipient</code>, not exactly
                one of <code className="font-mono text-sm">templateName</code>/
                <code className="font-mono text-sm">templateId</code>, a bad{" "}
                <code className="font-mono text-sm">?status</code>), a resolved
                template that is not approved, or a missing OTP variable on an
                authentication-category template.
              </li>
              <li>
                <strong>402</strong> — insufficient credits (non-superadmin,
                balance ≤ 0), returned before contacting Meta.
              </li>
              <li>
                <strong>404</strong> — unknown message id (or one not owned by the
                key&apos;s user/number), or a template not found for the given
                name/id.
              </li>
              <li>
                <strong>500</strong> — the send failed and the credit was
                refunded: either the bound number is not connected (&quot;WhatsApp
                number is not connected. Reconnect it to send messages.&quot;) or
                Meta returned a non-2xx error.
              </li>
            </ul>
          </div>
        </section>

        {/* 7. Receiving */}
        <section
          id="receiving"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-5 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            7. Receiving data (webhook)
          </h2>
          <p className="text-gray-700 leading-relaxed">
            Meta delivers delivery/read/failed statuses and inbound messages to a
            single platform webhook at{" "}
            <code className="font-mono text-sm">/api/webhooks/whatsapp</code>.
          </p>
          <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
            <li>
              <strong>GET</strong> is the verification handshake. Meta sends{" "}
              <code className="font-mono text-sm">hub.mode</code>,{" "}
              <code className="font-mono text-sm">hub.verify_token</code>, and{" "}
              <code className="font-mono text-sm">hub.challenge</code>. The route
              echoes the challenge with 200 when the mode is{" "}
              <code className="font-mono text-sm">subscribe</code> and the token
              matches{" "}
              <code className="font-mono text-sm">META_WEBHOOK_VERIFY_TOKEN</code>
              , else 403.
            </li>
            <li>
              <strong>POST</strong> carries signed events. The route reads the raw
              body and verifies the{" "}
              <code className="font-mono text-sm">X-Hub-Signature-256</code>{" "}
              header (HMAC-SHA256 over the raw body) against the app secret of the
              app that owns the number — your own app secret (Model B) or the
              platform secret (Model A). A missing/invalid signature returns 401;
              otherwise the route always returns 200 so Meta does not retry.
            </li>
            <li>
              <strong>Status updates</strong> update the matching message record
              by its Meta message id — setting{" "}
              <code className="font-mono text-sm">delivered</code>,{" "}
              <code className="font-mono text-sm">read</code>, or{" "}
              <code className="font-mono text-sm">failed</code> (with timestamps
              or an error message).
            </li>
            <li>
              <strong>Inbound messages</strong> are matched strictly to the owning
              number by{" "}
              <code className="font-mono text-sm">phone_number_id</code> (no
              fallback), then upsert a conversation and create an inbound message
              record.
            </li>
          </ul>
          <p className="text-gray-700 leading-relaxed">
            To read that data back out of the platform, use these authenticated
            GET endpoints (documented in full below):
          </p>
          <ul className="list-disc list-inside space-y-1 text-gray-700 pl-2">
            <li>
              <code className="font-mono text-sm">
                GET /api/chat/conversations
              </code>{" "}
              — list conversations.
            </li>
            <li>
              <code className="font-mono text-sm">
                GET /api/chat/[contactPhone]/messages
              </code>{" "}
              — messages for one contact.
            </li>
            <li>
              <code className="font-mono text-sm">GET /api/messages</code> — your
              last 100 messages.
            </li>
            <li>
              <code className="font-mono text-sm">GET /api/credits/balance</code>{" "}
              — your remaining credits.
            </li>
          </ul>
        </section>

        {/* 8. API reference */}
        <section
          id="api-reference"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-6 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">8. API reference</h2>

          <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 text-sm text-yellow-900 space-y-2">
            <p className="font-semibold">Authentication model — read first</p>
            <p>
              Except for registration and the webhook, every endpoint is a
              session-guarded Next.js route handler using{" "}
              <code className="font-mono">getServerSession</code>. Calls are
              authenticated by the <strong>NextAuth session cookie</strong>, not
              by a bearer token or API key. These session-cookie routes power the{" "}
              <strong>dashboard UI</strong>. To call them from your own backend
              you would log in through the NextAuth credentials flow and reuse the
              returned session cookie (the curl examples below pass it via{" "}
              <code className="font-mono">--cookie</code>); a request with no valid
              session returns <code className="font-mono">401 Unauthorized</code>.
              For <strong>server-to-server integration</strong>, use the{" "}
              <a href="#m2m-api" className="text-blue-600 hover:underline">
                public <code className="font-mono">/api/v1</code> API
              </a>{" "}
              instead — it authenticates with a per-tenant API key over a{" "}
              <code className="font-mono">Bearer</code> token, so your backend
              never needs a session cookie or any Meta credential.
            </p>
          </div>

          {/* Register */}
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/auth/register
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> none (public). Creates a new user (role{" "}
              <code className="font-mono text-sm">admin</code>) and a zero-balance
              credits record.
            </p>
            <p className="text-gray-700">
              <strong>Body:</strong>{" "}
              <code className="font-mono text-sm">fullName</code> (string, req),{" "}
              <code className="font-mono text-sm">email</code> (string, req),{" "}
              <code className="font-mono text-sm">password</code> (string, req),{" "}
              <code className="font-mono text-sm">companyName</code> (string,
              optional).
            </p>
            <CodeBlock>{`curl -X POST https://wa.digineanv.app/api/auth/register \\
  -H "Content-Type: application/json" \\
  -d '{"fullName":"Jane Dev","email":"jane@example.com","password":"s3cret","companyName":"Acme"}'`}</CodeBlock>
            <p className="text-gray-700">
              <strong>201:</strong>
            </p>
            <CodeBlock>{`{ "message": "User created successfully", "userId": "clx..." }`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 400 missing fields or email already
              registered; 500 server error.
            </p>
          </div>

          {/* Login note */}
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/auth/callback/credentials (NextAuth login)
            </h3>
            <p className="text-gray-700">
              Login is handled by NextAuth&apos;s credentials provider at{" "}
              <code className="font-mono text-sm">/api/auth/[...nextauth]</code>.
              Submitting valid email + password returns a session cookie; reuse
              that cookie on every subsequent call. In a browser, the dashboard
              login page performs this for you.
            </p>
          </div>

          {/* Numbers list */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/numbers
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Lists your WhatsApp numbers (the
              encrypted access token is stripped from the response).
            </p>
            <CodeBlock>{`curl https://wa.digineanv.app/api/numbers --cookie "next-auth.session-token=YOUR_SESSION_COOKIE"`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong> an array of number objects, e.g.
            </p>
            <CodeBlock>{`[
  {
    "id": "num_123",
    "phoneNumber": "15551234567",
    "wabaId": "YOUR_WABA_ID",
    "phoneNumberId": "YOUR_PHONE_NUMBER_ID",
    "verificationStatus": "verified",
    "connectionType": "manual",
    "displayPhoneNumber": "+1 555 123 4567",
    "verifiedName": "Acme"
  }
]`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 500 server error.
            </p>
          </div>

          {/* Numbers POST deprecated */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/numbers (deprecated)
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Registering a bare phone number is
              no longer supported. After the 401 auth check, this always returns{" "}
              <strong>400</strong> directing you to Embedded Signup or the manual
              path.
            </p>
            <CodeBlock>{`{ "error": "Registering a bare phone number is no longer supported. Connect your number via Embedded Signup (POST /api/numbers/embedded-signup) or manual credentials (POST /api/numbers/manual)." }`}</CodeBlock>
          </div>

          {/* Numbers manual */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/numbers/manual
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Validates the token against Meta,
              performs a WABA tie-check, then stores the encrypted token per
              tenant.
            </p>
            <p className="text-gray-700">
              <strong>Body (zod):</strong>{" "}
              <code className="font-mono text-sm">wabaId</code> (string 1–100,
              req), <code className="font-mono text-sm">phoneNumberId</code>{" "}
              (string 1–100, req),{" "}
              <code className="font-mono text-sm">accessToken</code> (string
              10–5000, req),{" "}
              <code className="font-mono text-sm">label</code> (string ≤100,
              optional).
            </p>
            <CodeBlock>{`curl -X POST https://wa.digineanv.app/api/numbers/manual \\
  -H "Content-Type: application/json" \\
  --cookie "next-auth.session-token=YOUR_SESSION_COOKIE" \\
  -d '{"wabaId":"YOUR_WABA_ID","phoneNumberId":"YOUR_PHONE_NUMBER_ID","accessToken":"YOUR_ACCESS_TOKEN","label":"Support line"}'`}</CodeBlock>
            <p className="text-gray-700">
              <strong>201:</strong> the serialized number object (same shape as
              the list entry above).
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 400 invalid body, token
              failed Meta validation, or the phone is not under that WABA; 409 the
              number is connected to another account; 500 server error.
            </p>
          </div>

          {/* Numbers embedded-signup */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/numbers/embedded-signup
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Exchanges a Meta OAuth code for a
              business token (using your app via Model B, else the platform app),
              resolves the WABA and phone number, then stores the token encrypted.
            </p>
            <p className="text-gray-700">
              <strong>Body (zod):</strong>{" "}
              <code className="font-mono text-sm">code</code> (string 1–4000,
              req), <code className="font-mono text-sm">phoneNumberId</code>{" "}
              (string, optional), <code className="font-mono text-sm">wabaId</code>{" "}
              (string, optional — resolved from the token if omitted).
            </p>
            <CodeBlock>{`curl -X POST https://wa.digineanv.app/api/numbers/embedded-signup \\
  -H "Content-Type: application/json" \\
  --cookie "next-auth.session-token=YOUR_SESSION_COOKIE" \\
  -d '{"code":"OAUTH_CODE_FROM_POPUP"}'`}</CodeBlock>
            <p className="text-gray-700">
              <strong>201:</strong> the serialized number object.
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 400 invalid body, code
              exchange failed, WABA/phone could not be resolved; 409 number owned
              by another account; 500 server not configured for Embedded Signup or
              server error.
            </p>
          </div>

          {/* Number [id] */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/numbers/[id] &nbsp;·&nbsp;{" "}
              <Method>DELETE</Method>/api/numbers/[id]
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. GET returns one number you own;
              DELETE removes it.
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 404 not found (not yours
              or absent); 500 server error. DELETE 200 returns{" "}
              <code className="font-mono">
                {`{ "message": "Number deleted successfully" }`}
              </code>
              .
            </p>
          </div>

          {/* Number verify */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/numbers/[id]/verify
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Refreshes the live Meta health/status
              fields (display phone, verified name, quality rating, etc.) using
              the number&apos;s stored token. No request body.
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 404 not found; 400 the
              number has no stored token (reconnect it) or Meta refused the
              refresh; 500 server error. 200 returns the updated number object.
            </p>
          </div>

          {/* Number confirm 410 */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/numbers/[id]/confirm (removed)
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Manual code confirmation is gone.
              After the 401 auth check this always returns{" "}
              <strong>410 Gone</strong> directing you to connect via Embedded
              Signup or manual credentials.
            </p>
          </div>

          {/* messages/send */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/messages/send
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Sends an approved template through
              Meta. Costs 1 credit on success (refunded on failure; superadmins
              exempt).
            </p>
            <p className="text-gray-700">
              <strong>Body (destructured):</strong>{" "}
              <code className="font-mono text-sm">numberId</code> (string, req —
              a verified number you own),{" "}
              <code className="font-mono text-sm">recipient</code> (string, req —
              phone, non-digits are stripped),{" "}
              <code className="font-mono text-sm">templateId</code> (string, req —
              an approved template you own),{" "}
              <code className="font-mono text-sm">variables</code> (string[],
              optional — for authentication templates,{" "}
              <code className="font-mono text-sm">variables[0]</code> must be the
              OTP code).
            </p>
            <CodeBlock>{`curl -X POST https://wa.digineanv.app/api/messages/send \\
  -H "Content-Type: application/json" \\
  --cookie "next-auth.session-token=YOUR_SESSION_COOKIE" \\
  -d '{"numberId":"num_123","recipient":"15551234567","templateId":"tpl_456","variables":["123456"]}'`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong>
            </p>
            <CodeBlock>{`{ "id": "msg_789", "status": "sent", "message": "Message sent successfully" }`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 400 missing fields,
              number not verified, template not approved, missing OTP variable for
              an authentication template, or insufficient credits; 500 the Meta
              send failed (the credit is refunded) or server error.
            </p>
          </div>

          {/* messages list */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/messages
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Returns your most recent 100
              messages (newest first), each with its template name and the
              sending number&apos;s phone.
            </p>
            <CodeBlock>{`curl https://wa.digineanv.app/api/messages --cookie "next-auth.session-token=YOUR_SESSION_COOKIE"`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 500 server error.
            </p>
          </div>

          {/* chat conversations */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/chat/conversations
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Lists your conversations (newest
              activity first) with the related number&apos;s phone.
            </p>
            <CodeBlock>{`{ "conversations": [ { "id": "conv_1", "contactPhone": "15559876543", "unreadCount": 2, "lastMessagePreview": "Hi!" } ] }`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 500 server error.
            </p>
          </div>

          {/* chat messages */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/chat/[contactPhone]/messages
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session.{" "}
              <strong>Path param:</strong>{" "}
              <code className="font-mono text-sm">contactPhone</code>{" "}
              (URL-encoded). Returns the conversation and its messages (oldest
              first); fetching also resets the unread count. If no conversation
              exists it returns{" "}
              <code className="font-mono text-sm">
                {`{ "messages": [], "conversation": null }`}
              </code>
              .
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 500 server error.
            </p>
          </div>

          {/* chat send */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/chat/[contactPhone]/send
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Sends a free-text reply within the
              24-hour window. <strong>Path param:</strong>{" "}
              <code className="font-mono text-sm">contactPhone</code>.
            </p>
            <p className="text-gray-700">
              <strong>Body:</strong>{" "}
              <code className="font-mono text-sm">message</code> (string, req),{" "}
              <code className="font-mono text-sm">whatsappNumberId</code> (string,
              optional — defaults to your first verified number).
            </p>
            <CodeBlock>{`curl -X POST https://wa.digineanv.app/api/chat/15559876543/send \\
  -H "Content-Type: application/json" \\
  --cookie "next-auth.session-token=YOUR_SESSION_COOKIE" \\
  -d '{"message":"Thanks for reaching out!","whatsappNumberId":"num_123"}'`}</CodeBlock>
            <p className="text-gray-700">
              <strong>200:</strong>{" "}
              <code className="font-mono text-sm">
                {`{ "message": { ... }, "conversation": { ... } }`}
              </code>
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 400 empty message, no
              verified number, or the number is not connected; 422 Meta rejected
              the send (the message row is saved as failed); 500 server error.
            </p>
          </div>

          {/* templates list/create */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/templates &nbsp;·&nbsp;{" "}
              <Method>POST</Method>/api/templates
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. GET lists your templates. POST
              creates a draft template locally (it is <em>not</em> sent to Meta
              until you submit).
            </p>
            <p className="text-gray-700">
              <strong>POST body:</strong>{" "}
              <code className="font-mono text-sm">name</code> (string, req —
              lowercase, start with a letter, only{" "}
              <code className="font-mono">[a-z0-9_]</code>),{" "}
              <code className="font-mono text-sm">category</code> (string, req —
              marketing / utility / authentication),{" "}
              <code className="font-mono text-sm">body</code> (string, req),{" "}
              <code className="font-mono text-sm">language</code>,{" "}
              <code className="font-mono text-sm">headerType</code>,{" "}
              <code className="font-mono text-sm">headerContent</code>,{" "}
              <code className="font-mono text-sm">footerContent</code>,{" "}
              <code className="font-mono text-sm">buttons</code>,{" "}
              <code className="font-mono text-sm">mediaAttachments</code>,{" "}
              <code className="font-mono text-sm">status</code> (all optional).
            </p>
            <CodeBlock>{`curl -X POST https://wa.digineanv.app/api/templates \\
  -H "Content-Type: application/json" \\
  --cookie "next-auth.session-token=YOUR_SESSION_COOKIE" \\
  -d '{"name":"order_update","category":"utility","language":"en","body":"Your order {{1}} has shipped."}'`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 400 missing required
              fields, invalid name format, or duplicate name; 500 server error.
              201 returns the created template.
            </p>
          </div>

          {/* template [id] */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/templates/[id] &nbsp;·&nbsp;{" "}
              <Method>PUT</Method>/api/templates/[id] &nbsp;·&nbsp;{" "}
              <Method>DELETE</Method>/api/templates/[id]
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. GET reads one template you own. PUT
              edits a <code className="font-mono text-sm">draft</code> or{" "}
              <code className="font-mono text-sm">rejected</code> template.
              DELETE removes it locally and best-effort deletes it from Meta.
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 404 not found; 400 (PUT)
              only draft/rejected templates can be edited; 500 server error.
            </p>
          </div>

          {/* template submit */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/templates/[id]/submit
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Submits a draft/rejected template to
              Meta for approval using your connected number&apos;s WABA
              credentials.
            </p>
            <p className="text-gray-700">
              <strong>Body (optional):</strong>{" "}
              <code className="font-mono text-sm">sampleValues</code> (string[] —
              example values for body variables),{" "}
              <code className="font-mono text-sm">numberId</code> (string —
              required when you have more than one connected number).
            </p>
            <CodeBlock>{`curl -X POST https://wa.digineanv.app/api/templates/tpl_456/submit \\
  -H "Content-Type: application/json" \\
  --cookie "next-auth.session-token=YOUR_SESSION_COOKIE" \\
  -d '{"sampleValues":["12345"],"numberId":"num_123"}'`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized (or 401{" "}
              <code className="font-mono">META_TOKEN_EXPIRED</code> if Meta&apos;s
              token expired); 404 template not found; 400 not draft/rejected, body
              too long, selected number not connected, ambiguous number, or Meta
              rejected the template; 409 no connected number; 500 credential or
              server error.
            </p>
          </div>

          {/* template sync */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>POST</Method>/api/templates/sync
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. No body. Pulls the latest
              status/category for your templates from every connected WABA and
              imports Meta-only templates.
            </p>
            <CodeBlock>{`{ "synced": 4, "updated": 1, "imported": 2, "duplicatesRemoved": 0 }`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized (or{" "}
              <code className="font-mono">META_TOKEN_EXPIRED</code>); 409 no
              connected number; 400 Meta fetch failed; 500 credential or server
              error.
            </p>
          </div>

          {/* credits */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/credits/balance
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Returns your credit balance.
              Superadmins report unlimited credits.
            </p>
            <CodeBlock>{`{ "totalCredits": 100, "usedCredits": 12, "availableCredits": 88 }`}</CodeBlock>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 500 server error.
            </p>
          </div>

          {/* meta-app */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/meta-app &nbsp;·&nbsp;{" "}
              <Method>PUT</Method>/api/meta-app &nbsp;·&nbsp;{" "}
              <Method>DELETE</Method>/api/meta-app
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> session. Manages your tenant Meta app (Model
              B). The app secret is <strong>write-only</strong> — the value is
              never returned.
            </p>
            <p className="text-gray-700">
              <strong>GET</strong> returns the effective config:
            </p>
            <CodeBlock>{`{ "appId": "YOUR_APP_ID", "configId": "YOUR_CONFIG_ID", "source": "tenant", "hasSecret": true }`}</CodeBlock>
            <p className="text-gray-700">
              <strong>PUT body (zod):</strong>{" "}
              <code className="font-mono text-sm">metaAppId</code> (string 1–100,
              req), <code className="font-mono text-sm">metaAppSecret</code>{" "}
              (string 10–500 — required on first create, omit to keep the stored
              secret), <code className="font-mono text-sm">configId</code> (string
              | null — null clears, omit keeps).
            </p>
            <CodeBlock>{`curl -X PUT https://wa.digineanv.app/api/meta-app \\
  -H "Content-Type: application/json" \\
  --cookie "next-auth.session-token=YOUR_SESSION_COOKIE" \\
  -d '{"metaAppId":"YOUR_APP_ID","metaAppSecret":"YOUR_APP_SECRET","configId":"YOUR_CONFIG_ID"}'`}</CodeBlock>
            <p className="text-gray-700">
              <strong>DELETE</strong> reverts you to the platform app and returns{" "}
              <code className="font-mono text-sm">{`{ "ok": true }`}</code>.
            </p>
            <p className="text-gray-700 text-sm">
              <strong>Errors:</strong> 401 unauthorized; 400 invalid body or app
              secret missing on first create; 500 server error.
            </p>
          </div>

          {/* webhook */}
          <div className="space-y-2 border-t pt-5">
            <h3 className="text-lg font-semibold text-gray-900">
              <Method>GET</Method>/api/webhooks/whatsapp &nbsp;·&nbsp;{" "}
              <Method>POST</Method>/api/webhooks/whatsapp
            </h3>
            <p className="text-gray-700">
              <strong>Auth:</strong> not a session route — this is Meta&apos;s
              webhook. GET is the verify handshake (echoes{" "}
              <code className="font-mono text-sm">hub.challenge</code> on a token
              match, else 403). POST verifies{" "}
              <code className="font-mono text-sm">X-Hub-Signature-256</code> and
              processes status + inbound events, then returns 200 (401 only on a
              missing/invalid signature).
            </p>
            <p className="text-gray-700 text-sm">
              You do not call this endpoint yourself — you configure it as the
              callback URL in your Meta app&apos;s WhatsApp webhook settings.
            </p>
          </div>
        </section>

        {/* 8. Walkthrough */}
        <section
          id="walkthrough"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-4 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            9. Integration walkthrough
          </h2>
          <p className="text-gray-700 leading-relaxed">
            An end-to-end example, from zero to a delivered message:
          </p>
          <ol className="list-decimal list-inside space-y-2 text-gray-700 pl-2">
            <li>
              <strong>Authenticate.</strong> Register with{" "}
              <code className="font-mono text-sm">POST /api/auth/register</code>,
              then log in through the NextAuth credentials flow and keep the
              session cookie.
            </li>
            <li>
              <strong>Connect a number.</strong> Either paste credentials via{" "}
              <code className="font-mono text-sm">POST /api/numbers/manual</code>{" "}
              or complete Embedded Signup via{" "}
              <code className="font-mono text-sm">
                POST /api/numbers/embedded-signup
              </code>
              . Confirm it shows as verified with{" "}
              <code className="font-mono text-sm">GET /api/numbers</code>.
            </li>
            <li>
              <strong>Create a template.</strong>{" "}
              <code className="font-mono text-sm">POST /api/templates</code>{" "}
              creates a local draft.
            </li>
            <li>
              <strong>Submit it to Meta.</strong>{" "}
              <code className="font-mono text-sm">
                POST /api/templates/[id]/submit
              </code>{" "}
              (pass <code className="font-mono text-sm">numberId</code> if you
              have several numbers).
            </li>
            <li>
              <strong>Sync approval status.</strong>{" "}
              <code className="font-mono text-sm">POST /api/templates/sync</code>{" "}
              until the template status is{" "}
              <code className="font-mono text-sm">approved</code>.
            </li>
            <li>
              <strong>Send.</strong>{" "}
              <code className="font-mono text-sm">POST /api/messages/send</code>{" "}
              with the number, recipient, template, and any variables.
            </li>
            <li>
              <strong>Track delivery.</strong> Poll{" "}
              <code className="font-mono text-sm">GET /api/messages</code> and/or
              let the Meta webhook update the message to{" "}
              <code className="font-mono text-sm">delivered</code>/
              <code className="font-mono text-sm">read</code>/
              <code className="font-mono text-sm">failed</code>.
            </li>
            <li>
              <strong>Read replies.</strong> When a contact replies, read it via{" "}
              <code className="font-mono text-sm">
                GET /api/chat/conversations
              </code>{" "}
              and{" "}
              <code className="font-mono text-sm">
                GET /api/chat/[contactPhone]/messages
              </code>
              , and reply within 24 hours via{" "}
              <code className="font-mono text-sm">
                POST /api/chat/[contactPhone]/send
              </code>
              .
            </li>
          </ol>
        </section>

        {/* 9. Env */}
        <section
          id="env"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-4 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            10. Environment / configuration reference
          </h2>
          <p className="text-gray-700 leading-relaxed">
            These are environment variable <strong>names only</strong> — never
            commit real values. Per-tenant WABA / phone / token are{" "}
            <strong>not</strong> environment variables; they live encrypted in the
            database per number.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="border-b text-gray-900">
                  <th className="py-2 pr-4 font-semibold">Variable</th>
                  <th className="py-2 pr-4 font-semibold">Meaning</th>
                  <th className="py-2 font-semibold">Scope</th>
                </tr>
              </thead>
              <tbody className="text-gray-700">
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">TURSO_DATABASE_URL</td>
                  <td className="py-2 pr-4">Turso/libSQL database URL (Prisma datasource).</td>
                  <td className="py-2">Platform</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">TURSO_AUTH_TOKEN</td>
                  <td className="py-2 pr-4">Turso database auth token.</td>
                  <td className="py-2">Platform</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">NEXTAUTH_SECRET</td>
                  <td className="py-2 pr-4">NextAuth session signing secret.</td>
                  <td className="py-2">Platform</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">NEXTAUTH_URL</td>
                  <td className="py-2 pr-4">Base URL NextAuth uses for callbacks.</td>
                  <td className="py-2">Platform</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">META_APP_ID</td>
                  <td className="py-2 pr-4">Platform Meta app ID (Model A OAuth exchange fallback).</td>
                  <td className="py-2">Model A fallback</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">META_APP_SECRET</td>
                  <td className="py-2 pr-4">Platform Meta app secret — OAuth exchange + webhook signature verification for Model A tenants.</td>
                  <td className="py-2">Model A fallback</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">META_WEBHOOK_VERIFY_TOKEN</td>
                  <td className="py-2 pr-4">Token the webhook GET handshake must echo.</td>
                  <td className="py-2">Platform (webhook)</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">NEXT_PUBLIC_META_APP_ID</td>
                  <td className="py-2 pr-4">Platform Meta app ID for the Facebook JS SDK (Embedded Signup).</td>
                  <td className="py-2">Embedded Signup (Model A)</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4 font-mono">NEXT_PUBLIC_META_CONFIG_ID</td>
                  <td className="py-2 pr-4">Platform Embedded Signup Configuration ID.</td>
                  <td className="py-2">Embedded Signup (Model A)</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 font-mono">ENCRYPTION_KEY</td>
                  <td className="py-2 pr-4">AES-256-GCM key (32 bytes, base64) encrypting per-tenant tokens at rest.</td>
                  <td className="py-2">Platform</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* 11. Troubleshooting */}
        <section
          id="troubleshooting"
          className="bg-white rounded-lg shadow-sm border p-8 space-y-4 scroll-mt-6"
        >
          <h2 className="text-2xl font-bold text-gray-900">
            11. Troubleshooting
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="border-b text-gray-900">
                  <th className="py-2 pr-4 font-semibold">Symptom</th>
                  <th className="py-2 font-semibold">What to do</th>
                </tr>
              </thead>
              <tbody className="text-gray-700">
                <tr className="border-b">
                  <td className="py-2 pr-4">&quot;number is not connected&quot;</td>
                  <td className="py-2">
                    The number has no usable stored token. Reconnect it (Embedded
                    Signup or manual) with a valid token.
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4">Sent but not delivered</td>
                  <td className="py-2">
                    Check Meta billing is not past-due, the recipient has opted
                    in, and your webhook is receiving status events.
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4">
                    (#131008) Required parameter is missing
                  </td>
                  <td className="py-2">
                    Authentication templates need the OTP value — pass it as{" "}
                    <code className="font-mono">variables[0]</code> so the
                    copy-code button is populated.
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 pr-4">Token expired / session expired</td>
                  <td className="py-2">
                    Regenerate a System User token (never expires) and reconnect
                    the number.
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">
                    Embedded Signup &quot;not configured&quot;
                  </td>
                  <td className="py-2">
                    Set <code className="font-mono">NEXT_PUBLIC_META_APP_ID</code>{" "}
                    and{" "}
                    <code className="font-mono">NEXT_PUBLIC_META_CONFIG_ID</code>{" "}
                    (or connect your own app under Settings → Meta App) and
                    redeploy.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-6 py-6 text-center text-sm text-gray-500">
        © {new Date().getFullYear()} WhatsApp Business Platform. All rights
        reserved.
        <span className="mx-2">·</span>
        <Link href="/login" className="hover:underline">
          Login
        </Link>
      </footer>
    </div>
  );
}
