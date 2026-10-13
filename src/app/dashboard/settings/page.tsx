"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
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
  User,
  Lock,
  CheckCircle,
  AlertCircle,
  Building2,
  Phone,
  Mail,
  Calendar,
  Plug,
} from "lucide-react";

interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  companyName: string | null;
  createdAt: string;
  emailVerified: boolean;
}

// Shape returned by GET /api/meta-app. The secret value is never returned —
// hasSecret only reports whether a tenant secret is STORED (not whether valid).
interface MetaAppConfig {
  appId: string | null;
  configId: string | null;
  source: "tenant" | "platform";
  hasSecret: boolean;
}

type Tab = "profile" | "security" | "metaApp";

export default function SettingsPage() {
  const { data: session, update: updateSession } = useSession();
  const [activeTab, setActiveTab] = useState<Tab>("profile");

  // Profile state
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Password state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Meta App state
  const [cfg, setCfg] = useState<MetaAppConfig | null>(null);
  const [loadingCfg, setLoadingCfg] = useState(true);
  const [cfgError, setCfgError] = useState("");
  const [cfgNotice, setCfgNotice] = useState("");
  const [savingCfg, setSavingCfg] = useState(false);
  const [clearingCfg, setClearingCfg] = useState(false);
  // The secret input is write-only and never pre-filled.
  const [metaAppId, setMetaAppId] = useState("");
  const [configId, setConfigId] = useState("");
  const [metaAppSecret, setMetaAppSecret] = useState("");

  useEffect(() => {
    fetch("/api/settings/profile")
      .then((r) => r.json())
      .then((data) => {
        setProfile(data);
        setFullName(data.fullName ?? "");
        setPhone(data.phone ?? "");
        setCompanyName(data.companyName ?? "");
        setLoadingProfile(false);
      })
      .catch(() => setLoadingProfile(false));
  }, []);

  const loadConfig = async () => {
    setCfgError("");
    try {
      const res = await fetch("/api/meta-app");
      const data = await res.json();
      if (!res.ok) {
        // Surface API errors (including 401) inline. The /dashboard server
        // layout is the auth boundary — this page never self-redirects.
        setCfgError(data.error || "Failed to load Meta app settings");
        return;
      }
      const next = data as MetaAppConfig;
      setCfg(next);
      setMetaAppId(next.appId ?? "");
      setConfigId(next.configId ?? "");
      setMetaAppSecret(""); // never pre-fill the secret
    } catch {
      setCfgError("Something went wrong while loading settings");
    } finally {
      setLoadingCfg(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setProfileMessage(null);
    try {
      const res = await fetch("/api/settings/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, phone, companyName }),
      });
      const data = await res.json();
      if (res.ok) {
        setProfile(data);
        await updateSession({ name: data.fullName });
        setProfileMessage({
          type: "success",
          text: "Profile updated successfully.",
        });
      } else {
        setProfileMessage({
          type: "error",
          text: data.error || "Failed to update profile.",
        });
      }
    } catch {
      setProfileMessage({ type: "error", text: "Something went wrong." });
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMessage(null);
    if (newPassword !== confirmPassword) {
      setPasswordMessage({
        type: "error",
        text: "New passwords do not match.",
      });
      return;
    }
    if (newPassword.length < 8) {
      setPasswordMessage({
        type: "error",
        text: "Password must be at least 8 characters.",
      });
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch("/api/settings/password", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setPasswordMessage({
          type: "success",
          text: "Password changed successfully.",
        });
      } else {
        setPasswordMessage({
          type: "error",
          text: data.error || "Failed to change password.",
        });
      }
    } catch {
      setPasswordMessage({ type: "error", text: "Something went wrong." });
    } finally {
      setSavingPassword(false);
    }
  };

  const handleCfgSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setCfgError("");
    setCfgNotice("");
    setSavingCfg(true);

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
        setCfgError(data.error || "Failed to save Meta app settings");
        setSavingCfg(false);
        return;
      }
      const next = data as MetaAppConfig;
      setCfg(next);
      setMetaAppId(next.appId ?? "");
      setConfigId(next.configId ?? "");
      setMetaAppSecret("");
      setCfgNotice("Settings saved.");
    } catch {
      setCfgError("Something went wrong while saving");
    } finally {
      setSavingCfg(false);
    }
  };

  const handleCfgClear = async () => {
    setCfgError("");
    setCfgNotice("");
    setClearingCfg(true);

    try {
      const res = await fetch("/api/meta-app", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setCfgError(data.error || "Failed to disconnect your Meta app");
        setClearingCfg(false);
        return;
      }
      // Re-fetch to reflect the reverted platform state.
      await loadConfig();
      setCfgNotice("Disconnected your Meta app. Using the platform app.");
    } catch {
      setCfgError("Something went wrong while disconnecting");
    } finally {
      setClearingCfg(false);
    }
  };

  const isTenant = cfg?.source === "tenant";
  const secretHelper =
    cfg?.hasSecret && isTenant
      ? "Secret is stored"
      : "No tenant secret stored (using platform app)";

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      {/* Tabs */}
      <div className="flex flex-wrap space-x-1 border-b mb-6">
        <button
          onClick={() => setActiveTab("profile")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "profile"
              ? "border-gray-900 text-gray-900"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <User className="w-4 h-4" />
          Profile
        </button>
        <button
          onClick={() => setActiveTab("security")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "security"
              ? "border-gray-900 text-gray-900"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <Lock className="w-4 h-4" />
          Security
        </button>
        <button
          onClick={() => setActiveTab("metaApp")}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "metaApp"
              ? "border-gray-900 text-gray-900"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          <Plug className="w-4 h-4" />
          Meta App
        </button>
      </div>

      {activeTab === "profile" && (
        <div className="space-y-6">
          {/* Account Info */}
          {profile && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Account Info</CardTitle>
                <CardDescription>Read-only account details</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div className="flex items-center gap-2 text-gray-600">
                  <Mail className="w-4 h-4 shrink-0" />
                  <span className="truncate">{profile.email}</span>
                  {profile.emailVerified ? (
                    <Badge
                      variant="default"
                      className="ml-1 text-xs bg-green-100 text-green-700"
                    >
                      Verified
                    </Badge>
                  ) : (
                    <Badge
                      variant="default"
                      className="ml-1 text-xs bg-yellow-100 text-yellow-700"
                    >
                      Unverified
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 text-gray-600">
                  <Calendar className="w-4 h-4 shrink-0" />
                  <span>
                    Joined {new Date(profile.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}
          {/* Edit Profile */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Edit Profile</CardTitle>
              <CardDescription>
                Update your name, phone number, and company
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingProfile ? (
                <p className="text-sm text-gray-500">Loading…</p>
              ) : (
                <form onSubmit={handleProfileSave} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="fullName">Full Name</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        id="fullName"
                        className="pl-9"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone Number</Label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        id="phone"
                        className="pl-9"
                        placeholder="+91 XXXXXXXXXX"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="companyName">Company Name</Label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        id="companyName"
                        className="pl-9"
                        placeholder="Your company"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                      />
                    </div>
                  </div>
                  {profileMessage && (
                    <div
                      className={`flex items-center gap-2 text-sm p-3 rounded-md ${
                        profileMessage.type === "success"
                          ? "bg-green-50 text-green-700"
                          : "bg-red-50 text-red-700"
                      }`}
                    >
                      {profileMessage.type === "success" ? (
                        <CheckCircle className="w-4 h-4 shrink-0" />
                      ) : (
                        <AlertCircle className="w-4 h-4 shrink-0" />
                      )}
                      {profileMessage.text}
                    </div>
                  )}
                  <Button type="submit" disabled={savingProfile}>
                    {savingProfile ? "Saving…" : "Save Changes"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "security" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Change Password</CardTitle>
            <CardDescription>
              Use a strong password of at least 8 characters
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePasswordSave} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="currentPassword">Current Password</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">New Password</Label>
                <Input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirm New Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              {passwordMessage && (
                <div
                  className={`flex items-center gap-2 text-sm p-3 rounded-md ${
                    passwordMessage.type === "success"
                      ? "bg-green-50 text-green-700"
                      : "bg-red-50 text-red-700"
                  }`}
                >
                  {passwordMessage.type === "success" ? (
                    <CheckCircle className="w-4 h-4 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 shrink-0" />
                  )}
                  {passwordMessage.text}
                </div>
              )}
              <Button type="submit" disabled={savingPassword}>
                {savingPassword ? "Updating…" : "Update Password"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {activeTab === "metaApp" && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle className="text-base">Meta App</CardTitle>
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
            {cfgError && (
              <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md flex items-start">
                <AlertCircle className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
                <span>{cfgError}</span>
              </div>
            )}

            {cfgNotice && (
              <div className="p-3 text-sm text-green-600 bg-green-50 rounded-md">
                {cfgNotice}
              </div>
            )}

            {loadingCfg ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <form onSubmit={handleCfgSave} className="space-y-4">
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
                  <Label htmlFor="configId">
                    Embedded Signup Configuration ID
                  </Label>
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
                  <Button type="submit" disabled={savingCfg || clearingCfg}>
                    {savingCfg ? "Saving..." : "Save"}
                  </Button>
                  {isTenant && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCfgClear}
                      disabled={savingCfg || clearingCfg}
                    >
                      {clearingCfg ? "Disconnecting..." : "Disconnect own app"}
                    </Button>
                  )}
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
