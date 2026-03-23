"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  UserCheck,
  UserX,
  Shield,
  ShieldOff,
  PlusCircle,
  MinusCircle,
  RefreshCw,
} from "lucide-react";

interface User {
  id: string;
  fullName: string;
  email: string;
  companyName: string | null;
  phone: string | null;
  isActive: boolean;
  role: string;
  createdAt: string;
  credits: { totalCredits: number; usedCredits: number } | null;
  _count: { messages: number; whatsappNumbers: number; templates: number };
}

export default function SubscribersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [creditInputs, setCreditInputs] = useState<Record<string, string>>({});

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        ...(search ? { search } : {}),
      });
      const res = await fetch(`/api/admin/users?${params}`);
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
        setTotal(data.total);
        setPages(data.pages);
      }
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const t = setTimeout(fetchUsers, 300);
    return () => clearTimeout(t);
  }, [fetchUsers]);

  const updateUser = async (id: string, payload: Record<string, unknown>) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) await fetchUsers();
    } finally {
      setActionLoading(null);
    }
  };

  const handleAddCredits = async (userId: string) => {
    const val = parseInt(creditInputs[userId] ?? "");
    if (!val || isNaN(val)) return;
    await updateUser(userId, { addCredits: val });
    setCreditInputs((p) => ({ ...p, [userId]: "" }));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Subscribers</h1>
          <p className="text-muted-foreground">
            {total} user{total !== 1 ? "s" : ""} registered
          </p>
        </div>
        <Button variant="outline" onClick={fetchUsers} disabled={loading}>
          <RefreshCw
            className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search by name, email or company..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Users</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">User</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Credits</th>
                  <th className="text-left px-4 py-3 font-medium">Activity</th>
                  <th className="text-left px-4 py-3 font-medium">Joined</th>
                  <th className="text-left px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-10 text-muted-foreground"
                    >
                      Loading...
                    </td>
                  </tr>
                )}
                {!loading && users.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-10 text-muted-foreground"
                    >
                      No users found.
                    </td>
                  </tr>
                )}
                {users.map((u) => {
                  const available =
                    (u.credits?.totalCredits ?? 0) -
                    (u.credits?.usedCredits ?? 0);
                  return (
                    <tr
                      key={u.id}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium">{u.fullName}</p>
                        <p className="text-xs text-muted-foreground">
                          {u.email}
                        </p>
                        {u.companyName && (
                          <p className="text-xs text-muted-foreground">
                            {u.companyName}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <Badge
                            variant={u.isActive ? "default" : "destructive"}
                            className="w-fit text-xs"
                          >
                            {u.isActive ? "Active" : "Disabled"}
                          </Badge>
                          {u.role === "admin" && (
                            <Badge
                              variant="secondary"
                              className="w-fit text-xs bg-yellow-100 text-yellow-800"
                            >
                              Admin
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{available}</p>
                        <p className="text-xs text-muted-foreground">
                          {u.credits?.usedCredits ?? 0} used
                        </p>
                        {/* Add credits input */}
                        <div className="flex items-center gap-1 mt-1">
                          <Input
                            type="number"
                            placeholder="±credits"
                            className="h-6 text-xs w-20 px-2"
                            value={creditInputs[u.id] ?? ""}
                            onChange={(e) =>
                              setCreditInputs((p) => ({
                                ...p,
                                [u.id]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) =>
                              e.key === "Enter" && handleAddCredits(u.id)
                            }
                          />
                          <button
                            onClick={() => handleAddCredits(u.id)}
                            disabled={actionLoading === u.id}
                            className="text-green-600 hover:text-green-800 disabled:opacity-50"
                            title="Apply credits change"
                          >
                            <PlusCircle className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        <p>{u._count.messages} msgs</p>
                        <p>{u._count.whatsappNumbers} numbers</p>
                        <p>{u._count.templates} templates</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {/* Toggle active */}
                          <button
                            onClick={() =>
                              updateUser(u.id, { isActive: !u.isActive })
                            }
                            disabled={actionLoading === u.id}
                            className="p-1.5 rounded hover:bg-muted disabled:opacity-50"
                            title={u.isActive ? "Disable user" : "Enable user"}
                          >
                            {u.isActive ? (
                              <UserX className="w-4 h-4 text-red-500" />
                            ) : (
                              <UserCheck className="w-4 h-4 text-green-600" />
                            )}
                          </button>
                          {/* Toggle admin */}
                          <button
                            onClick={() =>
                              updateUser(u.id, {
                                role: u.role === "admin" ? "user" : "admin",
                              })
                            }
                            disabled={actionLoading === u.id}
                            className="p-1.5 rounded hover:bg-muted disabled:opacity-50"
                            title={
                              u.role === "admin" ? "Remove admin" : "Make admin"
                            }
                          >
                            {u.role === "admin" ? (
                              <ShieldOff className="w-4 h-4 text-gray-500" />
                            ) : (
                              <Shield className="w-4 h-4 text-yellow-500" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
