"use client";

import Link from "next/link";

export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t bg-white px-4 py-4 text-sm text-gray-500 sm:px-6">
      <div className="flex flex-col items-center justify-between gap-2 sm:flex-row">
        <p>© {year} WhatsApp Business. All rights reserved.</p>
        <nav className="flex items-center gap-4">
          <Link href="/docs" className="hover:text-gray-900 hover:underline">
            Docs
          </Link>
          <Link
            href="/privacy-policy"
            className="hover:text-gray-900 hover:underline"
          >
            Privacy Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
