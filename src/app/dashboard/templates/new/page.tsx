"use client";

import { useState } from "react";
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
import { ArrowLeft, Plus, X } from "lucide-react";
import Link from "next/link";

export default function CreateTemplatePage() {
  const router = useRouter();
  const [formData, setFormData] = useState({
    name: "",
    category: "utility",
    language: "en",
    body: "",
    headerType: "none",
    headerContent: "",
    footerContent: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [variables, setVariables] = useState<string[]>([]);

  // Extract variables from body (e.g., {{1}}, {{2}})
  const extractVariables = (text: string) => {
    const regex = /\{\{(\d+)\}\}/g;
    const found: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!found.includes(match[1])) {
        found.push(match[1]);
      }
    }
    return found.sort((a, b) => parseInt(a) - parseInt(b));
  };

  const handleBodyChange = (value: string) => {
    setFormData({ ...formData, body: value });
    setVariables(extractVariables(value));
  };

  const handleSubmit = async (e: React.FormEvent, submit: boolean = false) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    if (!formData.name.trim()) {
      setError("Template name is required");
      setLoading(false);
      return;
    }

    if (!formData.body.trim()) {
      setError("Template body is required");
      setLoading(false);
      return;
    }

    // Validate header content if header type is not none
    if (formData.headerType !== "none" && !formData.headerContent.trim()) {
      setError("Header content is required when header type is not none");
      setLoading(false);
      return;
    }

    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          status: submit ? "submitted" : "draft",
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create template");
      } else {
        if (submit) {
          router.push(`/dashboard/templates/${data.id}?submitted=true`);
        } else {
          router.push("/dashboard/templates");
        }
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const insertVariable = () => {
    const nextNum =
      variables.length > 0 ? Math.max(...variables.map(Number)) + 1 : 1;
    const newBody = formData.body + ` {{${nextNum}}}`;
    handleBodyChange(newBody);
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Button variant="ghost" asChild className="mb-4">
          <Link href="/dashboard/templates">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Templates
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">Create Template</h1>
        <p className="text-muted-foreground">
          Design a new WhatsApp message template
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Template Details</CardTitle>
          <CardDescription>
            Create a message template for Meta approval
          </CardDescription>
        </CardHeader>
        <form onSubmit={(e) => handleSubmit(e, false)}>
          <CardContent className="space-y-6">
            {error && (
              <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Template Name</Label>
              <Input
                id="name"
                placeholder="e.g., order_confirmation"
                value={formData.name}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    name: e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9_]/g, "_"),
                  })
                }
                required
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and underscores only
              </p>
            </div>

            <div className="space-y-2">
              <Label>Category</Label>
              <div className="flex space-x-4">
                {["marketing", "utility", "authentication"].map((cat) => (
                  <label
                    key={cat}
                    className="flex items-center space-x-2 cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="category"
                      value={cat}
                      checked={formData.category === cat}
                      onChange={(e) =>
                        setFormData({ ...formData, category: e.target.value })
                      }
                      className="w-4 h-4"
                    />
                    <span className="text-sm capitalize">{cat}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="language">Language</Label>
              <select
                id="language"
                className="w-full h-10 px-3 border rounded-md bg-background text-sm"
                value={formData.language}
                onChange={(e) =>
                  setFormData({ ...formData, language: e.target.value })
                }
              >
                <option value="en">English</option>
                <option value="en_US">English (US)</option>
                <option value="hi">Hindi (हिन्दी)</option>
                <option value="mr">Marathi (मराठी)</option>
                <option value="gu">Gujarati (ગુજરાતી)</option>
                <option value="ta">Tamil (தமிழ்)</option>
                <option value="te">Telugu (తెలుగు)</option>
                <option value="kn">Kannada (ಕನ್ನಡ)</option>
                <option value="ml">Malayalam (മലയാളം)</option>
                <option value="bn">Bengali (বাংলা)</option>
                <option value="pa">Punjabi (ਪੰਜਾਬੀ)</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="headerType">Header (Optional)</Label>
              <select
                id="headerType"
                className="w-full h-10 px-3 border rounded-md bg-background text-sm"
                value={formData.headerType}
                onChange={(e) =>
                  setFormData({ ...formData, headerType: e.target.value })
                }
              >
                <option value="none">No Header</option>
                <option value="text">Text</option>
                <option value="image">Image</option>
                <option value="video">Video</option>
                <option value="document">Document</option>
              </select>
              {formData.headerType !== "none" && (
                <Input
                  placeholder={
                    formData.headerType === "text"
                      ? "Header text"
                      : `Enter ${formData.headerType} URL`
                  }
                  value={formData.headerContent}
                  onChange={(e) =>
                    setFormData({ ...formData, headerContent: e.target.value })
                  }
                  className="mt-2"
                />
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="body">Message Body</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={insertVariable}
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add Variable
                </Button>
              </div>
              <textarea
                id="body"
                className="w-full min-h-[150px] px-3 py-2 border rounded-md bg-background text-sm"
                placeholder="Hi {{1}}, your order #{{2}} has been shipped."
                value={formData.body}
                onChange={(e) => handleBodyChange(e.target.value)}
                required
              />
              {variables.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Variables detected:{" "}
                  {variables.map((v) => `{{${v}}}`).join(", ")}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="footer">Footer (Optional)</Label>
              <Input
                id="footer"
                placeholder="Reply STOP to unsubscribe"
                value={formData.footerContent}
                onChange={(e) =>
                  setFormData({ ...formData, footerContent: e.target.value })
                }
              />
            </div>
          </CardContent>
          <div className="p-6 pt-0 flex space-x-4">
            <Button
              type="button"
              variant="outline"
              onClick={(e) => handleSubmit(e, false)}
              disabled={loading}
            >
              Save as Draft
            </Button>
            <Button
              type="button"
              onClick={(e) => handleSubmit(e, true)}
              disabled={loading}
            >
              {loading ? "Submitting..." : "Submit for Approval"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
