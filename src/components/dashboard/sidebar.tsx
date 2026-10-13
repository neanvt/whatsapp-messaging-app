"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  MessageSquare,
  Phone,
  FileText,
  CreditCard,
  LayoutDashboard,
  Settings,
  MessagesSquare,
  BookOpen,
} from "lucide-react";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const navigation = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "WhatsApp Numbers", href: "/dashboard/numbers", icon: Phone },
  { name: "Templates", href: "/dashboard/templates", icon: FileText },
  { name: "Bulk Messages", href: "/dashboard/messages", icon: MessageSquare },
  { name: "Chat", href: "/dashboard/chat", icon: MessagesSquare },
  { name: "Payments", href: "/dashboard/payments", icon: CreditCard },
];

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <>
      {/* Backdrop — only below lg, only when open (FR2.3) */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-30 bg-black/50 transition-opacity lg:hidden",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Panel: off-canvas drawer below lg, static column at lg+ */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-gray-900 text-white",
          "transition-transform duration-200 ease-in-out",
          isOpen ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:z-auto lg:min-h-screen lg:translate-x-0",
        )}
      >
        <div className="p-6">
          <h1 className="text-xl font-bold">WhatsApp Business</h1>
        </div>
        <nav className="flex-1 px-4 space-y-1">
          {navigation.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center px-4 py-3 text-sm font-medium rounded-lg transition-colors",
                  isActive
                    ? "bg-gray-800 text-white"
                    : "text-gray-300 hover:bg-gray-800 hover:text-white",
                )}
              >
                <item.icon className="w-5 h-5 mr-3" />
                {item.name}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-gray-800 space-y-1">
          <Link
            href="/docs"
            className="flex items-center px-4 py-3 text-sm font-medium text-gray-300 rounded-lg hover:bg-gray-800 hover:text-white transition-colors"
          >
            <BookOpen className="w-5 h-5 mr-3" />
            Developer Docs
          </Link>
          <Link
            href="/dashboard/settings"
            className="flex items-center px-4 py-3 text-sm font-medium text-gray-300 rounded-lg hover:bg-gray-800 hover:text-white transition-colors"
          >
            <Settings className="w-5 h-5 mr-3" />
            Settings
          </Link>
        </div>
      </div>
    </>
  );
}
