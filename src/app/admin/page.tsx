"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Users,
  MessageSquare,
  CreditCard,
  TrendingUp,
  UserCheck,
  Coins,
} from "lucide-react";

interface Stats {
  totalUsers: number;
  activeUsers: number;
  totalMessages: number;
  totalRevenue: number;
  totalCreditsIssued: number;
  totalCreditsUsed: number;
  recentUsers: {
    id: string;
    fullName: string;
    email: string;
    createdAt: string;
    isActive: boolean;
  }[];
  recentPayments: {
    id: string;
    amountInr: number;
    creditsPurchased: number;
    status: string;
    createdAt: string;
    user: { fullName: string; email: string };
  }[];
}

export default function AdminOverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/stats")
      .then((r) => r.json())
      .then((d) => setStats(d))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        Loading...
      </div>
    );
  }

  const statCards = [
    {
      label: "Total Users",
      value: stats?.totalUsers ?? 0,
      icon: Users,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "Active Users",
      value: stats?.activeUsers ?? 0,
      icon: UserCheck,
      color: "text-green-600",
      bg: "bg-green-50",
    },
    {
      label: "Messages Sent",
      value: stats?.totalMessages ?? 0,
      icon: MessageSquare,
      color: "text-purple-600",
      bg: "bg-purple-50",
    },
    {
      label: "Total Revenue",
      value: `₹${(stats?.totalRevenue ?? 0).toLocaleString()}`,
      icon: TrendingUp,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
    },
    {
      label: "Credits Issued",
      value: stats?.totalCreditsIssued ?? 0,
      icon: Coins,
      color: "text-yellow-600",
      bg: "bg-yellow-50",
    },
    {
      label: "Credits Used",
      value: stats?.totalCreditsUsed ?? 0,
      icon: CreditCard,
      color: "text-red-600",
      bg: "bg-red-50",
    },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-muted-foreground">Platform-wide statistics</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
        {statCards.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4">
              <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
                <s.icon className={`w-5 h-5 ${s.color}`} />
              </div>
              <p className="text-2xl font-bold">{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Signups */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Signups</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats?.recentUsers.length === 0 && (
                <p className="text-sm text-muted-foreground">No users yet.</p>
              )}
              {stats?.recentUsers.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between text-sm"
                >
                  <div>
                    <p className="font-medium">{u.fullName}</p>
                    <p className="text-xs text-muted-foreground">{u.email}</p>
                  </div>
                  <div className="text-right">
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${u.isActive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}
                    >
                      {u.isActive ? "Active" : "Disabled"}
                    </span>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Payments */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Payments</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats?.recentPayments.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No payments yet.
                </p>
              )}
              {stats?.recentPayments.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between text-sm"
                >
                  <div>
                    <p className="font-medium">{p.user.fullName}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.creditsPurchased} credits
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium">
                      ₹{p.amountInr.toLocaleString()}
                    </p>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        p.status === "completed"
                          ? "bg-green-100 text-green-700"
                          : p.status === "pending"
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-red-100 text-red-700"
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
