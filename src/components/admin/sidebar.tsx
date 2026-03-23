"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Package,
  ArrowLeft,
  Shield,
} from "lucide-react";

const navigation = [
  { name: "Overview", href: "/admin", icon: LayoutDashboard },
  { name: "Subscribers", href: "/admin/subscribers", icon: Users },
  { name: "Packages", href: "/admin/packages", icon: Package },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col w-64 bg-gray-950 text-white min-h-screen">
      <div className="p-6 border-b border-gray-800">
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-5 h-5 text-yellow-400" />
          <h1 className="text-lg font-bold text-yellow-400">Super Admin</h1>
        </div>
        <p className="text-xs text-gray-400">WhatsApp Business</p>
      </div>
      <nav className="flex-1 px-4 py-4 space-y-1">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/admin" && pathname.startsWith(item.href + "/"));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center px-4 py-3 text-sm font-medium rounded-lg transition-colors",
                isActive
                  ? "bg-yellow-400/20 text-yellow-400"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white",
              )}
            >
              <item.icon className="w-5 h-5 mr-3" />
              {item.name}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-gray-800">
        <Link
          href="/dashboard"
          className="flex items-center px-4 py-3 text-sm font-medium text-gray-300 rounded-lg hover:bg-gray-800 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5 mr-3" />
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
