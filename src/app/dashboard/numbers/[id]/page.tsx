"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Phone,
  CheckCircle,
  Clock,
  AlertCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";

interface WhatsAppNumber {
  id: string;
  phoneNumber: string;
  verificationStatus: string;
  verifiedAt: string | null;
  createdAt: string;
  connectionType?: string | null;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  qualityRating?: string | null;
  codeVerificationStatus?: string | null;
  platformType?: string | null;
}

interface NumberDetailPageProps {
  params: { id: string };
}

export default function NumberDetailPage({ params }: NumberDetailPageProps) {
  const router = useRouter();
  const [number, setNumber] = useState<WhatsAppNumber | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchNumber();
  }, [params.id]);

  const fetchNumber = async () => {
    try {
      const res = await fetch(`/api/numbers/${params.id}`);
      if (res.ok) {
        const data = await res.json();
        setNumber(data);
      } else {
        setError("Number not found");
      }
    } catch {
      setError("Failed to load number details");
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch(`/api/numbers/${params.id}/verify`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        setNumber(data);
      } else {
        setError(data.error || "Failed to refresh status");
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setRefreshing(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm("Are you sure you want to remove this number?")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/numbers/${params.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.push("/dashboard/numbers");
      } else {
        const data = await res.json();
        setError(data.error || "Failed to remove number");
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setDeleting(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "verified":
        return <CheckCircle className="w-8 h-8 text-green-600" />;
      case "in_progress":
        return <Clock className="w-8 h-8 text-blue-600" />;
      case "failed":
        return <AlertCircle className="w-8 h-8 text-red-600" />;
      default:
        return <Clock className="w-8 h-8 text-gray-600" />;
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !number) {
    return (
      <div>
        <Button variant="ghost" asChild className="mb-4">
          <Link href="/dashboard/numbers">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Numbers
          </Link>
        </Button>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
            <p className="text-muted-foreground">
              {error || "Number not found"}
            </p>
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
          <CardTitle>Number Details</CardTitle>
          <CardDescription>
            WhatsApp Business number information
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && (
            <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md flex items-center">
              <AlertCircle className="w-4 h-4 mr-2" />
              {error}
            </div>
          )}

          <div className="flex items-center space-x-4">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center">
              {getStatusIcon(number.verificationStatus)}
            </div>
            <div>
              <div className="flex items-center space-x-2 mb-1">
                <Phone className="w-4 h-4 text-muted-foreground" />
                <p className="font-semibold text-lg">
                  {number.displayPhoneNumber || number.phoneNumber}
                </p>
              </div>
              {getStatusBadge(number.verificationStatus)}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Added</p>
              <p className="font-medium">
                {new Date(number.createdAt).toLocaleDateString()}
              </p>
            </div>
            {number.verifiedAt && (
              <div>
                <p className="text-muted-foreground">Verified</p>
                <p className="font-medium">
                  {new Date(number.verifiedAt).toLocaleDateString()}
                </p>
              </div>
            )}
            {number.connectionType && (
              <div>
                <p className="text-muted-foreground">Connection</p>
                <p className="font-medium">
                  {number.connectionType === "embedded_signup"
                    ? "Embedded Signup"
                    : "Manual"}
                </p>
              </div>
            )}
            {number.verifiedName && (
              <div>
                <p className="text-muted-foreground">Verified Name</p>
                <p className="font-medium">{number.verifiedName}</p>
              </div>
            )}
            {number.codeVerificationStatus && (
              <div>
                <p className="text-muted-foreground">Code Verification</p>
                <p className="font-medium">{number.codeVerificationStatus}</p>
              </div>
            )}
            {number.qualityRating && (
              <div>
                <p className="text-muted-foreground">Quality Rating</p>
                <p className="font-medium">{number.qualityRating}</p>
              </div>
            )}
            {number.platformType && (
              <div>
                <p className="text-muted-foreground">Platform</p>
                <p className="font-medium">{number.platformType}</p>
              </div>
            )}
          </div>

          <div className="flex flex-col space-y-2 pt-2">
            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw
                className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
              />
              {refreshing ? "Refreshing..." : "Refresh status"}
            </Button>
            {number.verificationStatus === "verified" && (
              <Button asChild variant="outline">
                <Link href="/dashboard/messages/send">Send a Message</Link>
              </Button>
            )}
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={deleting}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {deleting ? "Removing..." : "Remove Number"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
