"use client";

import { useSession, signOut } from "next-auth/react";
import { Bell, LogOut, Menu, User } from "lucide-react";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  isOpen: boolean;
  onMenuClick: () => void;
}

export function Header({ isOpen, onMenuClick }: HeaderProps) {
  const { data: session } = useSession();

  return (
    <header className="flex h-16 items-center justify-between gap-2 border-b bg-white px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle navigation menu"
          aria-expanded={isOpen}
          onClick={onMenuClick}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <h2 className="truncate text-base font-semibold sm:text-lg">
          Welcome back, {session?.user?.name}
        </h2>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <Button variant="ghost" size="icon">
          <Bell className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200">
            <User className="h-4 w-4 text-gray-500" />
          </div>
          <span className="hidden text-sm font-medium md:inline">
            {session?.user?.email}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => signOut({ callbackUrl: "/login" })}
          aria-label="Log out"
        >
          <LogOut className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
