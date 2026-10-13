"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Header } from "@/components/dashboard/header";
import { Footer } from "@/components/dashboard/footer";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on route change (FR2.4)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape-to-close (FR2.5) + body scroll lock (FR2.6) — only while open AND
  // only below lg. Never lock scroll at lg+, where no overlay is shown and the
  // desktop page must scroll as today (AC1).
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    if (mq.matches) return; // at lg+ the drawer is irrelevant; do not lock

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Resize guard: if the drawer is opened below lg and the viewport then widens
  // past lg, force the drawer closed so `open` cannot linger as `true` at
  // desktop (keeps the scroll lock from going stale and aria-expanded honest).
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar isOpen={open} onClose={() => setOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header isOpen={open} onMenuClick={() => setOpen((v) => !v)} />
        <main className="flex min-w-0 flex-1 flex-col p-4 sm:p-6">
          {children}
        </main>
        <Footer />
      </div>
    </div>
  );
}
