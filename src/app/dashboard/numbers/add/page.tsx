"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
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
import { ArrowLeft, AlertCircle } from "lucide-react";
import Link from "next/link";

const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID;
const META_CONFIG_ID = process.env.NEXT_PUBLIC_META_CONFIG_ID;

// Minimal typing for the FB JS SDK we rely on.
interface FBStatic {
  init: (opts: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }) => void;
  login: (
    cb: (response: { authResponse?: { code?: string } | null }) => void,
    opts: {
      config_id?: string;
      response_type: string;
      override_default_response_type: boolean;
      extras: {
        setup: Record<string, unknown>;
        featureType: string;
        sessionInfoVersion: string;
      };
    }
  ) => void;
}

declare global {
  interface Window {
    FB?: FBStatic;
    fbAsyncInit?: () => void;
  }
}

export default function ConnectNumberPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [sdkReady, setSdkReady] = useState(false);

  // Captured from the WA_EMBEDDED_SIGNUP postMessage event.
  const sessionInfo = useRef<{ phoneNumberId?: string; wabaId?: string }>({});

  // Manual form state
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [label, setLabel] = useState("");
  const [manualLoading, setManualLoading] = useState(false);

  useEffect(() => {
    // Capture the embedded-signup session info from Meta's popup.
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== "https://www.facebook.com" &&
        event.origin !== "https://web.facebook.com"
      ) {
        return;
      }
      try {
        const data =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP") {
          sessionInfo.current = {
            phoneNumberId: data?.data?.phone_number_id,
            wabaId: data?.data?.waba_id,
          };
        }
      } catch {
        // Non-JSON messages are not from the embedded signup flow — ignore.
      }
    };
    window.addEventListener("message", onMessage);

    // Inject the FB JS SDK once.
    if (!META_APP_ID) {
      window.removeEventListener("message", onMessage);
      return;
    }

    const initFB = () => {
      if (window.FB) {
        window.FB.init({
          appId: META_APP_ID,
          autoLogAppEvents: true,
          xfbml: false,
          version: "v19.0",
        });
        setSdkReady(true);
      }
    };

    if (window.FB) {
      initFB();
    } else {
      window.fbAsyncInit = initFB;
      const existing = document.getElementById("facebook-jssdk");
      if (!existing) {
        const script = document.createElement("script");
        script.id = "facebook-jssdk";
        script.src = "https://connect.facebook.net/en_US/sdk.js";
        script.async = true;
        script.defer = true;
        script.crossOrigin = "anonymous";
        document.body.appendChild(script);
      }
    }

    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const handleConnect = () => {
    setError("");

    if (!META_APP_ID || !META_CONFIG_ID) {
      setError(
        "Embedded Signup is not configured yet. Set NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_META_CONFIG_ID, or enter credentials manually."
      );
      return;
    }
    if (!window.FB || !sdkReady) {
      setError("Facebook SDK is still loading. Please try again in a moment.");
      return;
    }

    setConnecting(true);
    sessionInfo.current = {};

    window.FB.login(
      async (response) => {
        const code = response?.authResponse?.code;
        if (!code) {
          setConnecting(false);
          setError("Connection cancelled or failed. Please try again.");
          return;
        }

        try {
          const res = await fetch("/api/numbers/embedded-signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              phoneNumberId: sessionInfo.current.phoneNumberId,
              wabaId: sessionInfo.current.wabaId,
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            setError(data.error || "Failed to connect WhatsApp number");
            setConnecting(false);
            return;
          }
          router.push("/dashboard/numbers");
          router.refresh();
        } catch {
          setError("Something went wrong while connecting");
          setConnecting(false);
        }
      },
      {
        config_id: META_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          featureType: "",
          sessionInfoVersion: "3",
        },
      }
    );
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setManualLoading(true);

    try {
      const res = await fetch("/api/numbers/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wabaId: wabaId.trim(),
          phoneNumberId: phoneNumberId.trim(),
          accessToken: accessToken.trim(),
          label: label.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Surface Meta's exact message when the API returns one.
        setError(data.error || "Failed to connect number");
        setManualLoading(false);
        return;
      }
      router.push("/dashboard/numbers");
      router.refresh();
    } catch {
      setError("Something went wrong");
      setManualLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <Button variant="ghost" asChild className="mb-4">
          <Link href="/dashboard/numbers">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Numbers
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">Connect WhatsApp</h1>
        <p className="text-muted-foreground">
          Connect your own WhatsApp Business number through Meta
        </p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Connect your number</CardTitle>
          <CardDescription>
            Sign in with Meta to connect your WhatsApp Business Account. Your
            number, IDs, and access token are captured automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md flex items-start">
              <AlertCircle className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="button"
            className="w-full"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? "Connecting..." : "Connect WhatsApp"}
          </Button>

          <div className="text-center">
            <button
              type="button"
              className="text-sm text-muted-foreground underline hover:text-foreground"
              onClick={() => {
                setShowManual((v) => !v);
                setError("");
              }}
            >
              {showManual ? "Hide manual setup" : "Enter credentials manually"}
            </button>
          </div>

          {showManual && (
            <form onSubmit={handleManualSubmit} className="space-y-4 pt-2 border-t">
              <p className="text-xs text-muted-foreground">
                Enter the IDs and a permanent access token from your Meta app.
              </p>
              <div className="space-y-2">
                <Label htmlFor="wabaId">WhatsApp Business Account ID</Label>
                <Input
                  id="wabaId"
                  value={wabaId}
                  onChange={(e) => setWabaId(e.target.value)}
                  placeholder="WABA ID"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phoneNumberId">Phone Number ID</Label>
                <Input
                  id="phoneNumberId"
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="Phone Number ID"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accessToken">Access Token</Label>
                <Input
                  id="accessToken"
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="Permanent access token"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="label">Label (optional)</Label>
                <Input
                  id="label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Support line"
                />
              </div>
              <Button type="submit" className="w-full" disabled={manualLoading}>
                {manualLoading ? "Connecting..." : "Connect with credentials"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
