"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Plus, Pencil, Trash2, X, Check } from "lucide-react";

interface Package {
  id: string;
  planId: string;
  name: string;
  credits: number;
  priceInr: number;
  pricePerMsg: number;
  isActive: boolean;
  isPopular: boolean;
  sortOrder: number;
}

const emptyForm = (): Omit<Package, "id" | "pricePerMsg"> => ({
  planId: "",
  name: "",
  credits: 0,
  priceInr: 0,
  isActive: true,
  isPopular: false,
  sortOrder: 0,
});

export default function PackagesPage() {
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] =
    useState<Omit<Package, "id" | "pricePerMsg">>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fetchPackages = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/packages?all=true");
      if (res.ok) {
        const data = await res.json();
        setPackages(data.packages ?? data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPackages();
  }, [fetchPackages]);

  const openNew = () => {
    setForm(emptyForm());
    setEditId(null);
    setShowForm(true);
  };

  const openEdit = (pkg: Package) => {
    setForm({
      planId: pkg.planId,
      name: pkg.name,
      credits: pkg.credits,
      priceInr: pkg.priceInr,
      isActive: pkg.isActive,
      isPopular: pkg.isPopular,
      sortOrder: pkg.sortOrder,
    });
    setEditId(pkg.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = editId
        ? `/api/admin/packages/${editId}`
        : "/api/admin/packages";
      const method = editId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setShowForm(false);
        await fetchPackages();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    setDeletingId(id);
    try {
      await fetch(`/api/admin/packages/${id}`, { method: "DELETE" });
      await fetchPackages();
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const toggleActive = async (pkg: Package) => {
    await fetch(`/api/admin/packages/${pkg.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !pkg.isActive }),
    });
    await fetchPackages();
  };

  const pricePerMsg = form.credits > 0 ? form.priceInr / form.credits : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Packages</h1>
          <p className="text-muted-foreground">
            Manage credit plans shown to users
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchPackages} disabled={loading}>
            <RefreshCw
              className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button onClick={openNew}>
            <Plus className="w-4 h-4 mr-2" /> New Package
          </Button>
        </div>
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <Card className="mb-6 border-primary/50">
          <CardHeader>
            <CardTitle className="text-base">
              {editId ? "Edit Package" : "New Package"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label>Plan ID (unique slug)</Label>
                <Input
                  placeholder="e.g. starter"
                  value={form.planId}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      planId: e.target.value.toLowerCase().replace(/\s+/g, "-"),
                    }))
                  }
                  disabled={!!editId}
                />
              </div>
              <div className="space-y-1">
                <Label>Display Name</Label>
                <Input
                  placeholder="e.g. Starter Plan"
                  value={form.name}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, name: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Credits</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.credits || ""}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      credits: parseInt(e.target.value) || 0,
                    }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Price (₹)</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.priceInr || ""}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      priceInr: parseInt(e.target.value) || 0,
                    }))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label>Price per message</Label>
                <Input
                  value={pricePerMsg > 0 ? `₹${pricePerMsg.toFixed(4)}` : "—"}
                  disabled
                />
              </div>
              <div className="space-y-1">
                <Label>Sort Order</Label>
                <Input
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      sortOrder: parseInt(e.target.value) || 0,
                    }))
                  }
                />
              </div>
              <div className="flex items-center gap-4 col-span-2 md:col-span-3 mt-1">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, isActive: e.target.checked }))
                    }
                    className="w-4 h-4"
                  />
                  Active (visible to users)
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.isPopular}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, isPopular: e.target.checked }))
                    }
                    className="w-4 h-4"
                  />
                  Mark as Popular
                </label>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <Button
                onClick={handleSave}
                disabled={
                  saving || !form.planId || !form.name || form.credits <= 0
                }
              >
                {saving ? "Saving..." : editId ? "Update" : "Create"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowForm(false);
                  setEditId(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Package cards */}
      {loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {packages.map((pkg) => (
            <Card
              key={pkg.id}
              className={`relative ${!pkg.isActive ? "opacity-60" : ""} ${pkg.isPopular ? "ring-2 ring-primary" : ""}`}
            >
              {pkg.isPopular && (
                <div className="absolute -top-2.5 left-1/2 -translate-x-1/2">
                  <Badge className="text-xs">Popular</Badge>
                </div>
              )}
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base">{pkg.name}</CardTitle>
                    <p className="text-xs text-muted-foreground font-mono">
                      {pkg.planId}
                    </p>
                  </div>
                  <Badge variant={pkg.isActive ? "default" : "secondary"}>
                    {pkg.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Credits</span>
                  <span className="font-semibold">
                    {pkg.credits.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Price</span>
                  <span className="font-semibold">
                    ₹{pkg.priceInr.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Per message</span>
                  <span>₹{pkg.pricePerMsg.toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sort</span>
                  <span>{pkg.sortOrder}</span>
                </div>
                <div className="flex gap-2 pt-3 border-t mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => toggleActive(pkg)}
                  >
                    {pkg.isActive ? (
                      <>
                        <X className="w-3 h-3 mr-1" /> Deactivate
                      </>
                    ) : (
                      <>
                        <Check className="w-3 h-3 mr-1" /> Activate
                      </>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(pkg)}
                  >
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant={
                      confirmDeleteId === pkg.id ? "destructive" : "outline"
                    }
                    disabled={deletingId === pkg.id}
                    onClick={() => handleDelete(pkg.id)}
                    onBlur={() => setConfirmDeleteId(null)}
                    title={
                      confirmDeleteId === pkg.id
                        ? "Click again to confirm"
                        : "Delete"
                    }
                  >
                    <Trash2 className="w-3 h-3" />
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
