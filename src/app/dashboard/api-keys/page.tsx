"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  KeyRound,
  Plus,
  Copy,
  Check,
  AlertCircle,
  Trash2,
  ShieldAlert,
} from "lucide-react";

interface BoundNumber {
  id: string;
  phoneNumber: string;
  displayPhoneNumber: string | null;
}

interface ApiKeyRow {
  id: string;
  name: string | null;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  whatsappNumber: BoundNumber | null;
}

interface VerifiedNumber {
  id: string;
  phoneNumber: string;
  displayPhoneNumber: string | null;
  verificationStatus: string;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [numbers, setNumbers] = useState<VerifiedNumber[]>([]);
  const [error, setError] = useState("");

  // Create form state
  const [name, setName] = useState("");
  const [numberId, setNumberId] = useState("");
  const [creating, setCreating] = useState(false);

  // One-time reveal state
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = async () => {
    setError("");
    try {
      const res = await fetch("/api/api-keys");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to load API keys");
        return;
      }
      setKeys(data as ApiKeyRow[]);
    } catch {
      setError("Something went wrong while loading API keys");
    } finally {
      setLoadingKeys(false);
    }
  };

  const loadNumbers = async () => {
    try {
      const res = await fetch("/api/numbers");
      const data = await res.json();
      if (!res.ok) return;
      const verified = (data as VerifiedNumber[]).filter(
        (n) => n.verificationStatus === "verified",
      );
      setNumbers(verified);
      if (verified.length > 0) setNumberId((prev) => prev || verified[0].id);
    } catch {
      // Non-fatal — the create form will show no numbers.
    }
  };

  useEffect(() => {
    loadKeys();
    loadNumbers();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), numberId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to create API key");
        return;
      }
      // One-time reveal of the plaintext key.
      setNewKey(data.key);
      setCopied(false);
      setName("");
      await loadKeys();
    } catch {
      setError("Something went wrong while creating the key");
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable; the key is still visible to copy manually.
    }
  };

  const handleRevoke = async (id: string) => {
    if (
      !window.confirm(
        "Revoke this API key? Any integration using it will stop working immediately.",
      )
    ) {
      return;
    }
    setError("");
    try {
      const res = await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Failed to revoke API key");
        return;
      }
      await loadKeys();
    } catch {
      setError("Something went wrong while revoking the key");
    }
  };

  const numberLabel = (n: BoundNumber | null) =>
    n ? n.displayPhoneNumber ?? n.phoneNumber : "—";

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound className="w-6 h-6" />
        <h1 className="text-2xl font-bold">API Keys</h1>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Create a key to call the server-to-server API ({" "}
        <code className="font-mono text-xs">/api/v1</code> ). Each key is bound
        to one verified number — your third-party app never handles a Phone
        Number ID or Meta credential.
      </p>

      {error && (
        <div className="mb-6 p-3 text-sm text-red-700 bg-red-50 rounded-md flex items-start">
          <AlertCircle className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* One-time reveal callout */}
      {newKey && (
        <Card className="mb-6 border-amber-300 bg-amber-50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-amber-900">
              <ShieldAlert className="w-4 h-4" />
              Copy your new API key
            </CardTitle>
            <CardDescription className="text-amber-800">
              Copy this key now. For your security it will not be shown again.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <code className="flex-1 break-all rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-sm">
                {newKey}
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={handleCopy}
                className="shrink-0"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4 mr-2" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4 mr-2" />
                    Copy
                  </>
                )}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setNewKey(null)}
            >
              I&apos;ve copied it — dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Create form */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Create a new key</CardTitle>
          <CardDescription>
            Give it a name and bind it to one of your verified numbers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Key name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Orders server"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="numberId">Bound number</Label>
                <select
                  id="numberId"
                  value={numberId}
                  onChange={(e) => setNumberId(e.target.value)}
                  required
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {numbers.length === 0 ? (
                    <option value="" disabled>
                      No verified numbers
                    </option>
                  ) : (
                    numbers.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.displayPhoneNumber ?? n.phoneNumber}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>
            <Button
              type="submit"
              disabled={creating || numbers.length === 0}
            >
              <Plus className="w-4 h-4 mr-2" />
              {creating ? "Creating…" : "Create key"}
            </Button>
            {numbers.length === 0 && (
              <p className="text-xs text-gray-500">
                Connect and verify a WhatsApp number first to create a key.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Key list */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Your keys</h2>
        {loadingKeys ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-gray-500">
            You have no API keys yet.
          </p>
        ) : (
          keys.map((k) => {
            const revoked = !!k.revokedAt;
            return (
              <Card key={k.id}>
                <CardContent className="pt-6">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">
                          {k.name ?? "Unnamed key"}
                        </span>
                        <Badge
                          variant="default"
                          className={
                            revoked
                              ? "text-xs bg-gray-200 text-gray-700"
                              : "text-xs bg-green-100 text-green-700"
                          }
                        >
                          {revoked ? "Revoked" : "Active"}
                        </Badge>
                      </div>
                      <p className="font-mono text-xs text-gray-600 break-all">
                        {k.keyPrefix}…
                      </p>
                      <dl className="text-xs text-gray-500 space-y-0.5">
                        <div>
                          <span className="font-medium">Number:</span>{" "}
                          {numberLabel(k.whatsappNumber)}
                        </div>
                        <div>
                          <span className="font-medium">Last used:</span>{" "}
                          {k.lastUsedAt
                            ? new Date(k.lastUsedAt).toLocaleString()
                            : "Never"}
                        </div>
                        <div>
                          <span className="font-medium">Created:</span>{" "}
                          {new Date(k.createdAt).toLocaleDateString()}
                        </div>
                      </dl>
                    </div>
                    {!revoked && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleRevoke(k.id)}
                        className="shrink-0 text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        Revoke
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
