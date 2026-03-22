"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, FileText, RefreshCw, Send, Trash2, Copy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Template {
  id: string;
  name: string;
  category: string;
  body: string;
  status: string;
  createdAt: string;
  headerType: string | null;
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const router = useRouter();

  const handleDuplicate = async (id: string) => {
    setDuplicatingId(id);
    try {
      const res = await fetch(`/api/templates/${id}/duplicate`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        router.push(`/dashboard/templates/${data.id}`);
      } else {
        alert(data.error || "Failed to duplicate template");
      }
    } catch {
      alert("Something went wrong");
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/templates/${id}`, { method: "DELETE" });
      if (res.ok) {
        setTemplates((prev) => prev.filter((t) => t.id !== id));
      } else {
        const data = await res.json();
        alert(data.error || "Failed to delete template");
      }
    } catch {
      alert("Something went wrong");
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    try {
      const res = await fetch("/api/templates");
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch (error) {
      console.error("Failed to fetch templates:", error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "approved":
        return <Badge variant="success">Approved</Badge>;
      case "pending":
        return <Badge variant="warning">Pending</Badge>;
      case "submitted":
        return <Badge variant="secondary">Submitted</Badge>;
      case "rejected":
        return <Badge variant="destructive">Rejected</Badge>;
      case "draft":
      default:
        return <Badge variant="outline">Draft</Badge>;
    }
  };

  const getCategoryBadge = (category: string) => {
    const colors: Record<string, string> = {
      marketing: "bg-purple-100 text-purple-800",
      utility: "bg-blue-100 text-blue-800",
      authentication: "bg-green-100 text-green-800",
    };
    return (
      <span
        className={`px-2 py-1 text-xs font-medium rounded-full ${colors[category] || "bg-gray-100"}`}
      >
        {category}
      </span>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Message Templates</h1>
          <p className="text-muted-foreground">
            Create and manage your WhatsApp message templates
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/templates/new">
            <Plus className="w-4 h-4 mr-2" />
            Create Template
          </Link>
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FileText className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No Templates Yet</h3>
            <p className="text-muted-foreground text-center mb-4">
              Create your first message template to start sending WhatsApp
              messages.
            </p>
            <Button asChild>
              <Link href="/dashboard/templates/new">
                Create Your First Template
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {templates.map((template) => (
            <Card key={template.id}>
              <CardContent className="flex items-center justify-between p-6">
                <div className="flex items-start space-x-4 flex-1">
                  <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FileText className="w-6 h-6 text-gray-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-1">
                      <h3 className="font-medium text-lg">{template.name}</h3>
                      {getCategoryBadge(template.category)}
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                      {template.body.substring(0, 100)}
                      {template.body.length > 100 ? "..." : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Created{" "}
                      {new Date(template.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  {getStatusBadge(template.status)}
                  {template.status === "approved" && (
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        href={`/dashboard/messages?template=${template.id}`}
                      >
                        <Send className="w-4 h-4 mr-1" />
                        Send
                      </Link>
                    </Button>
                  )}
                  <Button variant="outline" asChild>
                    <Link href={`/dashboard/templates/${template.id}`}>
                      View
                    </Link>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    title="Duplicate as draft"
                    onClick={() => handleDuplicate(template.id)}
                    disabled={duplicatingId === template.id}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => handleDelete(template.id, template.name)}
                    disabled={deletingId === template.id}
                  >
                    <Trash2 className="w-4 h-4" />
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
