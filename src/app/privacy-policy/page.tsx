import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — WhatsApp Business",
  description: "Privacy Policy for WhatsApp Business Platform",
};

export default function PrivacyPolicyPage() {
  const lastUpdated = "March 22, 2026";

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
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="bg-white rounded-lg shadow-sm border p-8 space-y-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              Privacy Policy
            </h1>
            <p className="text-sm text-gray-500">Last updated: {lastUpdated}</p>
          </div>

          <p className="text-gray-700 leading-relaxed">
            This Privacy Policy describes how WhatsApp Business Platform ("we",
            "us", or "our") collects, uses, and protects your information when
            you use our service. By accessing or using the platform, you agree
            to the terms of this Privacy Policy.
          </p>

          {/* Section 1 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              1. Information We Collect
            </h2>
            <p className="text-gray-700 leading-relaxed">
              We collect the following types of information:
            </p>
            <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
              <li>
                <strong>Account Information:</strong> Your name, email address,
                and hashed password when you register for an account.
              </li>
              <li>
                <strong>WhatsApp Numbers:</strong> Phone numbers you register
                with our platform for use with the Meta WhatsApp Business API.
              </li>
              <li>
                <strong>Message Content:</strong> Message templates you create
                and the content of messages you send through the platform.
              </li>
              <li>
                <strong>Payment Information:</strong> Transaction details
                processed via Razorpay. We do not store full card numbers or
                sensitive payment credentials — these are handled directly by
                Razorpay.
              </li>
              <li>
                <strong>Usage Data:</strong> Logs of actions you perform on the
                platform, such as sending messages or managing numbers, for
                security and auditing purposes.
              </li>
            </ul>
          </section>

          {/* Section 2 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              2. How We Use Your Information
            </h2>
            <p className="text-gray-700 leading-relaxed">
              We use the collected information to:
            </p>
            <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
              <li>Authenticate you and manage your account securely.</li>
              <li>
                Enable you to register and verify WhatsApp numbers via the Meta
                WhatsApp Business API.
              </li>
              <li>
                Process and deliver messages to recipients through Meta's API on
                your behalf.
              </li>
              <li>
                Manage your message templates and submission to Meta for
                approval.
              </li>
              <li>Process payments and track your credit balance.</li>
              <li>
                Maintain platform security and detect fraudulent or abusive
                activity.
              </li>
              <li>
                Communicate important service updates, security alerts, or
                support responses.
              </li>
            </ul>
          </section>

          {/* Section 3 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              3. Third-Party Services
            </h2>
            <p className="text-gray-700 leading-relaxed">
              Our platform integrates with the following third-party services.
              Your use of these services is subject to their respective privacy
              policies:
            </p>
            <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
              <li>
                <strong>Meta (Facebook) WhatsApp Business API:</strong> Used to
                send and receive WhatsApp messages and manage number
                registration. Data is processed according to Meta's Data Policy.
              </li>
              <li>
                <strong>Razorpay:</strong> Used to process payments for platform
                credits. Razorpay processes your payment information in
                accordance with their Privacy Policy.
              </li>
            </ul>
          </section>

          {/* Section 4 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              4. Data Storage and Security
            </h2>
            <p className="text-gray-700 leading-relaxed">
              Your data is stored in a secure database. We take the following
              measures to protect your information:
            </p>
            <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
              <li>
                Passwords are hashed using bcrypt and are never stored in plain
                text.
              </li>
              <li>
                Authentication is managed via secure, server-side sessions
                (NextAuth).
              </li>
              <li>
                API credentials (Meta access tokens, Razorpay keys) are stored
                as environment variables and never exposed to the client.
              </li>
              <li>
                Access to your data is restricted — you can only view and manage
                records associated with your own account.
              </li>
            </ul>
          </section>

          {/* Section 5 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              5. Message Recipients
            </h2>
            <p className="text-gray-700 leading-relaxed">
              When you send messages through our platform, you are responsible
              for ensuring you have the appropriate consent from message
              recipients as required by Meta's WhatsApp Business Policy and
              applicable laws (including GDPR and India's PDPB). We act only as
              a conduit to the Meta API and do not independently contact your
              message recipients.
            </p>
          </section>

          {/* Section 6 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              6. Data Retention
            </h2>
            <p className="text-gray-700 leading-relaxed">
              We retain your account data for as long as your account is active.
              Message records and templates are retained to allow you to manage
              your sending history. You may request deletion of your account and
              associated data at any time by contacting us.
            </p>
          </section>

          {/* Section 7 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              7. Your Rights
            </h2>
            <p className="text-gray-700 leading-relaxed">
              You have the right to:
            </p>
            <ul className="list-disc list-inside space-y-2 text-gray-700 pl-2">
              <li>Access the personal data we hold about you.</li>
              <li>Request correction of inaccurate data.</li>
              <li>Request deletion of your account and data.</li>
              <li>Object to or restrict certain processing of your data.</li>
              <li>
                Withdraw consent at any time where processing is based on
                consent (e.g., marketing communications).
              </li>
            </ul>
            <p className="text-gray-700 leading-relaxed">
              To exercise any of these rights, please contact us using the
              details below.
            </p>
          </section>

          {/* Section 8 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">8. Cookies</h2>
            <p className="text-gray-700 leading-relaxed">
              We use a single session cookie to keep you logged in. This cookie
              is essential for the platform to function and does not track you
              across other websites. We do not use advertising or analytics
              cookies.
            </p>
          </section>

          {/* Section 9 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              9. Children's Privacy
            </h2>
            <p className="text-gray-700 leading-relaxed">
              This platform is not intended for use by anyone under the age of
              18. We do not knowingly collect personal information from minors.
              If you believe a minor has provided us with personal data, please
              contact us so we can remove it.
            </p>
          </section>

          {/* Section 10 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              10. Changes to This Policy
            </h2>
            <p className="text-gray-700 leading-relaxed">
              We may update this Privacy Policy from time to time. When we do,
              we will revise the "Last updated" date at the top. We encourage
              you to review this page periodically. Continued use of the
              platform after changes constitutes acceptance of the updated
              policy.
            </p>
          </section>

          {/* Section 11 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-gray-900">
              11. Contact Us
            </h2>
            <p className="text-gray-700 leading-relaxed">
              If you have questions, concerns, or requests regarding this
              Privacy Policy, please contact us at:
            </p>
            <div className="bg-gray-50 rounded-md p-4 text-gray-700 text-sm space-y-1">
              <p>
                <strong>WhatsApp Business Platform</strong>
              </p>
              <p>
                Email:{" "}
                <span className="text-blue-600">support@yourapp.com</span>
              </p>
            </div>
          </section>
        </div>
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
