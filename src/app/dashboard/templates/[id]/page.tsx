"use client";

import { useState, useEffect } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
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
  CheckCircle,
  XCircle,
  Clock,
  Send,
  Trash2,
  Copy,
} from "lucide-react";
import Link from "next/link";

interface Template {
  id: string;
  name: string;
  category: string;
  body: string;
  headerType: string | null;
  headerContent: string | null;
  footerContent: string | null;
  status: string;
  rejectionReason: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function TemplateDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [template, setTemplate] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const justSubmitted = searchParams.get("submitted") === "true";

  const handleDuplicate = async () => {
    if (!template) return;
    setDuplicating(true);
    try {
      const res = await fetch(`/api/templates/${template.id}/duplicate`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        router.push(`/dashboard/templates/${data.id}`);
      } else {
        alert(data.error || "Failed to duplicate template");
        setDuplicating(false);
      }
    } catch {
      alert("Something went wrong");
      setDuplicating(false);
    }
  };

  const handleSubmitToMeta = async () => {
    if (!template) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`/api/templates/${template.id}/submit`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        setTemplate(data);
        router.replace(`/dashboard/templates/${template.id}?submitted=true`);
      } else {
        setSubmitError(data.error || "Failed to submit to Meta");
      }
    } catch {
      setSubmitError("Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!template) return;
    if (!confirm(`Delete template "${template.name}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/templates/${template.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        router.push("/dashboard/templates");
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete template");
        setDeleting(false);
      }
    } catch {
      alert("Something went wrong");
      setDeleting(false);
    }
  };

  useEffect(() => {
    fetchTemplate();
  }, [params.id]);

  const fetchTemplate = async () => {
    try {
      const res = await fetch(`/api/templates/${params.id}`);
      if (res.ok) {
        const data = await res.json();
        setTemplate(data);
      }
    } catch (error) {
      console.error("Failed to fetch template:", error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "approved":
        return (
          <Badge variant="success" className="flex items-center gap-1">
            <CheckCircle className="w-3 h-3" /> Approved
          </Badge>
        );
      case "pending":
        return (
          <Badge variant="warning" className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> Pending
          </Badge>
        );
      case "submitted":
        return (
          <Badge variant="secondary" className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> Submitted
          </Badge>
        );
      case "rejected":
        return (
          <Badge variant="destructive" className="flex items-center gap-1">
            <XCircle className="w-3 h-3" /> Rejected
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">Loading...</div>
    );
  }

  if (!template) {
    return <div className="text-center py-12">Template not found</div>;
  }

  return (
    <div className="max-w-2xl">
      <Button variant="ghost" asChild className="mb-4">
        <Link href="/dashboard/templates">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Templates
        </Link>
      </Button>

      {justSubmitted && (
        <Card className="mb-6 bg-blue-50 border-blue-200">
          <CardContent className="flex items-center gap-3 py-4">
            <Clock className="w-5 h-5 text-blue-600" />
            <div>
              <p className="font-medium text-blue-900">Template Submitted!</p>
              <p className="text-sm text-blue-700">
                Meta will review your template within 24-48 hours.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-xl">{template.name}</CardTitle>
              <CardDescription>
                Created {new Date(template.createdAt).toLocaleDateString()}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {getStatusBadge(template.status)}
              <Button
                variant="outline"
                size="sm"
                title="Duplicate as draft"
                onClick={handleDuplicate}
                disabled={duplicating}
              >
                <Copy className="w-4 h-4 mr-1" />
                {duplicating ? "Duplicating..." : "Duplicate"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                {deleting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-2">
              Category
            </h4>
            <span className="capitalize px-3 py-1 bg-gray-100 rounded-full text-sm">
              {template.category}
            </span>
          </div>

          {template.headerType && template.headerType !== "none" && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Header ({template.headerType})
              </h4>
              <p className="p-3 bg-gray-50 rounded-md">
                {template.headerContent}
              </p>
            </div>
          )}

          <div>
            <h4 className="text-sm font-medium text-muted-foreground mb-2">
              Message Body
            </h4>
            <p className="p-3 bg-gray-50 rounded-md whitespace-pre-wrap">
              {template.body}
            </p>
          </div>

          {template.footerContent && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Footer
              </h4>
              <p className="p-3 bg-gray-50 rounded-md">
                {template.footerContent}
              </p>
            </div>
          )}

          {submitError && (
            <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
              {submitError}
            </div>
          )}

          {template.status === "rejected" && template.rejectionReason && (
            <div>
              <h4 className="text-sm font-medium text-red-600 mb-2">
                Rejection Reason
              </h4>
              <p className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700">
                {template.rejectionReason}
              </p>
            </div>
          )}

          {(template.status === "draft" || template.status === "rejected") && (
            <div className="pt-4">
              <Button onClick={handleSubmitToMeta} disabled={submitting}>
                <Send className="w-4 h-4 mr-2" />
                {submitting ? "Saving..." : "Save"}
              </Button>
            </div>
          )}

          {template.status === "approved" && (
            <div className="pt-4">
              <Button asChild>
                <Link href={`/dashboard/messages?template=${template.id}`}>
                  <Send className="w-4 h-4 mr-2" />
                  Send Message with this Template
                </Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
