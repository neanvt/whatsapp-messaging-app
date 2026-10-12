"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

// Shape returned by GET /api/meta-app. The secret value is never returned —
// hasSecret only reports whether a tenant secret is STORED (not whether valid).
interface MetaAppConfig {
  appId: string | null;
  configId: string | null;
  source: "tenant" | "platform";
  hasSecret: boolean;
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<MetaAppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Form fields. The secret input is write-only and never pre-filled.
  const [metaAppId, setMetaAppId] = useState("");
  const [configId, setConfigId] = useState("");
  const [metaAppSecret, setMetaAppSecret] = useState("");

  const loadConfig = async () => {
    setError("");
    try {
      const res = await fetch("/api/meta-app");
      const data = await res.json();
      if (!res.ok) {
        // Surface API errors (including 401) inline. The /dashboard server
        // layout is the auth boundary — this page never self-redirects.
        setError(data.error || "Failed to load Meta app settings");
        return;
      }
      const next = data as MetaAppConfig;
      setCfg(next);
      setMetaAppId(next.appId ?? "");
      setConfigId(next.configId ?? "");
      setMetaAppSecret(""); // never pre-fill the secret
    } catch {
      setError("Something went wrong while loading settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);

    try {
      const body: {
        metaAppId: string;
        metaAppSecret?: string;
        configId?: string | null;
      } = { metaAppId: metaAppId.trim() };

      // Send the secret ONLY if the user typed one (write-only rule).
      const typedSecret = metaAppSecret.trim();
      if (typedSecret) body.metaAppSecret = typedSecret;

      // configId rule: send the string when set; send null to clear a
      // previously-set value; omit the key when untouched/empty-and-unset.
      const typedConfig = configId.trim();
      if (typedConfig) {
        body.configId = typedConfig;
      } else if (cfg?.configId) {
        // Field cleared but a value was previously stored → explicit clear.
        body.configId = null;
      }

      const res = await fetch("/api/meta-app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to save Meta app settings");
        setSaving(false);
        return;
      }
      const next = data as MetaAppConfig;
      setCfg(next);
      setMetaAppId(next.appId ?? "");
      setConfigId(next.configId ?? "");
      setMetaAppSecret("");
      setNotice("Settings saved.");
    } catch {
      setError("Something went wrong while saving");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setError("");
    setNotice("");
    setClearing(true);

    try {
      const res = await fetch("/api/meta-app", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to disconnect your Meta app");
        setClearing(false);
        return;
      }
      // Re-fetch to reflect the reverted platform state.
      await loadConfig();
      setNotice("Disconnected your Meta app. Using the platform app.");
    } catch {
      setError("Something went wrong while disconnecting");
    } finally {
      setClearing(false);
    }
  };

  const isTenant = cfg?.source === "tenant";
  const secretHelper =
    cfg?.hasSecret && isTenant
      ? "Secret is stored"
      : "No tenant secret stored (using platform app)";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Manage the Meta app your WhatsApp onboarding runs under.
        </p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Meta App</CardTitle>
              <CardDescription>
                Connect your own Meta app so onboarding, OAuth, and inbound
                webhooks run under it. Leave it blank to use the platform app.
              </CardDescription>
            </div>
            {cfg && (
              <span className="shrink-0 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
                {isTenant ? "Using your own app" : "Using platform app"}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md flex items-start">
              <AlertCircle className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div className="p-3 text-sm text-green-600 bg-green-50 rounded-md">
              {notice}
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="metaAppId">Meta App ID</Label>
                <Input
                  id="metaAppId"
                  value={metaAppId}
                  onChange={(e) => setMetaAppId(e.target.value)}
                  placeholder="Your Meta App ID"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="configId">Embedded Signup Configuration ID</Label>
                <Input
                  id="configId"
                  value={configId}
                  onChange={(e) => setConfigId(e.target.value)}
                  placeholder="Configuration ID (optional)"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="metaAppSecret">Meta App Secret</Label>
                <Input
                  id="metaAppSecret"
                  type="password"
                  value={metaAppSecret}
                  onChange={(e) => setMetaAppSecret(e.target.value)}
                  placeholder="Enter to set or replace the secret"
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">{secretHelper}</p>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={saving || clearing}>
                  {saving ? "Saving..." : "Save"}
                </Button>
                {isTenant && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleClear}
                    disabled={saving || clearing}
                  >
                    {clearing ? "Disconnecting..." : "Disconnect own app"}
                  </Button>
                )}
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
