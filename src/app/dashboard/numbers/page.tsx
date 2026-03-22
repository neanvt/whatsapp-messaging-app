"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Phone, RefreshCw, X } from "lucide-react";
import Link from "next/link";

interface WhatsAppNumber {
  id: string;
  phoneNumber: string;
  verificationStatus: string;
  verifiedAt: string | null;
  createdAt: string;
}

export default function NumbersPage() {
  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  useEffect(() => {
    fetchNumbers();
  }, []);

  const fetchNumbers = async () => {
    try {
      const res = await fetch("/api/numbers");
      if (res.ok) {
        const data = await res.json();
        setNumbers(data);
      }
    } catch (error) {
      console.error("Failed to fetch numbers:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm("Are you sure you want to remove this number?")) return;
    setCancellingId(id);
    try {
      const res = await fetch(`/api/numbers/${id}`, { method: "DELETE" });
      if (res.ok) {
        setNumbers((prev) => prev.filter((n) => n.id !== id));
      }
    } catch (error) {
      console.error("Failed to cancel number:", error);
    } finally {
      setCancellingId(null);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "verified":
        return <Badge variant="success">Verified</Badge>;
      case "pending":
        return <Badge variant="warning">Pending</Badge>;
      case "in_progress":
        return <Badge variant="secondary">In Progress</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">WhatsApp Numbers</h1>
          <p className="text-muted-foreground">Manage your WhatsApp Business numbers</p>
        </div>
        <Button asChild>
          <Link href="/dashboard/numbers/add">
            <Plus className="w-4 h-4 mr-2" />
            Add Number
          </Link>
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : numbers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Phone className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No WhatsApp Numbers</h3>
            <p className="text-muted-foreground text-center mb-4">
              Add your Meta-verified WhatsApp number to start sending messages.
            </p>
            <Button asChild>
              <Link href="/dashboard/numbers/add">Add Your First Number</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {numbers.map((number) => (
            <Card key={number.id}>
              <CardContent className="flex items-center justify-between p-6">
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center">
                    <Phone className="w-6 h-6 text-gray-600" />
                  </div>
                  <div>
                    <p className="font-medium text-lg">{number.phoneNumber}</p>
                    <p className="text-sm text-muted-foreground">
                      Added {new Date(number.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-4">
                  {getStatusBadge(number.verificationStatus)}
                  {number.verificationStatus !== "verified" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCancel(number.id)}
                      disabled={cancellingId === number.id}
                      className="text-red-500 hover:text-red-700 hover:border-red-300"
                    >
                      <X className="w-4 h-4 mr-1" />
                      {cancellingId === number.id ? "Cancelling..." : "Cancel"}
                    </Button>
                  )}
                  <Button variant="outline" asChild>
                    <Link href={`/dashboard/numbers/${number.id}`}>View</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
