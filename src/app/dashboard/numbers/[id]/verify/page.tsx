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
import { ArrowLeft, CheckCircle, AlertCircle } from "lucide-react";
import Link from "next/link";

interface VerifyPageProps {
  params: { id: string };
}

export default function VerifyNumberPage({ params }: VerifyPageProps) {
  const [step, setStep] = useState<"otp" | "success" | "error">("otp");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [error, setError] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);

  useEffect(() => {
    fetchNumber();
  }, [params.id]);

  const fetchNumber = async () => {
    try {
      const res = await fetch(`/api/numbers/${params.id}`);
      if (res.ok) {
        const data = await res.json();
        setPhoneNumber(data.phoneNumber);
        if (data.verificationStatus === "verified") {
          setStep("success");
        } else {
          // Auto-send OTP when the page loads
          requestVerification();
        }
      }
    } catch (error) {
      console.error("Failed to fetch number:", error);
    }
  };

  const requestVerification = async () => {
    setSendingCode(true);
    setError("");
    setDevCode(null);

    try {
      const res = await fetch(`/api/numbers/${params.id}/verify`, {
        method: "POST",
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to send verification code");
      } else {
        // Display the code returned from the API (dev/testing fallback)
        if (data.code) {
          setDevCode(data.code);
        }
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setSendingCode(false);
    }
  };

  const verifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/numbers/${params.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: otp }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Invalid verification code");
      } else {
        setStep("success");
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  if (step === "success") {
    return (
      <div className="max-w-lg">
        <Button variant="ghost" asChild className="mb-4">
          <Link href="/dashboard/numbers">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Numbers
          </Link>
        </Button>

        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
              <CheckCircle className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold mb-2">Number Verified!</h2>
            <p className="text-muted-foreground text-center mb-6">
              {phoneNumber} has been successfully verified. You can now create
              templates and send messages.
            </p>
            <div className="flex space-x-4">
              <Button variant="outline" asChild>
                <Link href="/dashboard/numbers">View Numbers</Link>
              </Button>
              <Button asChild>
                <Link href="/dashboard/templates">Create Template</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-lg">
      <Button variant="ghost" asChild className="mb-4">
        <Link href="/dashboard/numbers">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Numbers
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Verify Phone Number</CardTitle>
          <CardDescription>
            Enter the 6-digit verification code sent to{" "}
            <strong>{phoneNumber}</strong>
          </CardDescription>
        </CardHeader>
        <form onSubmit={verifyOtp}>
          <CardContent className="space-y-4">
            {sendingCode && (
              <div className="p-3 text-sm text-blue-600 bg-blue-50 rounded-md">
                Sending verification code...
              </div>
            )}

            {error && (
              <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md flex items-center">
                <AlertCircle className="w-4 h-4 mr-2" />
                {error}
              </div>
            )}

            {devCode && (
              <div className="p-3 text-sm bg-yellow-50 border border-yellow-200 rounded-md">
                <p className="font-semibold text-yellow-800 mb-1">
                  Development Mode — Verification Code
                </p>
                <p className="text-yellow-700 text-xs mb-2">
                  No SMS gateway is configured. Use the code below to verify:
                </p>
                <p className="text-2xl font-mono font-bold tracking-widest text-center text-yellow-900">
                  {devCode}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="otp">Verification Code</Label>
              <Input
                id="otp"
                type="text"
                placeholder="000000"
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                className="text-center text-2xl tracking-widest font-mono"
                maxLength={6}
                required
              />
            </div>

            <p className="text-xs text-muted-foreground">
              A 6-digit verification code has been generated for your number. In
              production with an SMS gateway configured, it will be sent to your
              phone.
            </p>
          </CardContent>
          <div className="p-6 pt-0 space-y-4">
            <Button
              type="submit"
              className="w-full"
              disabled={loading || otp.length !== 6}
            >
              {loading ? "Verifying..." : "Verify Code"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={requestVerification}
              disabled={loading || sendingCode}
            >
              {sendingCode ? "Sending..." : "Resend Code"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
