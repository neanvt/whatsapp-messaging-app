"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Phone } from "lucide-react";
import Link from "next/link";

export default function AddNumberPage() {
  const router = useRouter();
  const [phoneNumber, setPhoneNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    // Basic phone validation
    const cleanedNumber = phoneNumber.replace(/\D/g, "");
    if (cleanedNumber.length < 10 || cleanedNumber.length > 15) {
      setError("Please enter a valid phone number");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: cleanedNumber }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to register number");
      } else {
        router.push(`/dashboard/numbers/${data.id}/verify`);
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
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
        <h1 className="text-2xl font-bold">Add WhatsApp Number</h1>
        <p className="text-muted-foreground">Register your Meta-verified WhatsApp number</p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Phone Number</CardTitle>
          <CardDescription>
            Enter your WhatsApp number with country code (e.g., +91XXXXXXXXXX)
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <div className="flex items-center space-x-2">
                <Phone className="w-5 h-5 text-muted-foreground" />
                <Input
                  id="phone"
                  type="tel"
                  placeholder="+91 98765 43210"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  className="flex-1"
                  required
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Make sure this number is verified with Meta and has WhatsApp installed.
              </p>
            </div>
          </CardContent>
          <div className="p-6 pt-0">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Registering..." : "Register Number"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
