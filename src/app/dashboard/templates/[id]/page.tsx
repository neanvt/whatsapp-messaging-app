"use client";

import { useState, useEffect } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
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
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Clock,
  Send,
  Trash2,
  Copy,
  Plus,
  X,
  Link as LinkIcon,
  Phone,
  MessageSquare,
  Paperclip,
} from "lucide-react";
import Link from "next/link";

interface TemplateButton {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
  text: string;
  url?: string;
  phone_number?: string;
}

interface MediaAttachment {
  type: "image" | "video" | "document" | "audio";
  url: string;
  name: string;
}

interface Template {
  id: string;
  name: string;
  category: string;
  language: string;
  body: string;
  headerType: string | null;
  headerContent: string | null;
  footerContent: string | null;
  buttons: string | null;
  mediaAttachments: string | null;
  status: string;
  rejectionReason: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "en_US", label: "English (US)" },
  { value: "hi", label: "Hindi (हिन्दी)" },
  { value: "mr", label: "Marathi (मराठी)" },
  { value: "gu", label: "Gujarati (ગુજરાતી)" },
  { value: "ta", label: "Tamil (தமிழ்)" },
  { value: "te", label: "Telugu (తెలుగు)" },
  { value: "kn", label: "Kannada (ಕನ್ನಡ)" },
  { value: "ml", label: "Malayalam (മലയാളം)" },
  { value: "bn", label: "Bengali (বাংলা)" },
  { value: "pa", label: "Punjabi (ਪੰਜਾਬੀ)" },
];

const BUTTON_TYPES = [
  { value: "QUICK_REPLY", label: "Quick Reply", icon: MessageSquare },
  { value: "URL", label: "URL Button", icon: LinkIcon },
  { value: "PHONE_NUMBER", label: "Phone Number", icon: Phone },
];

const MEDIA_TYPES = [
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "document", label: "Document" },
  { value: "audio", label: "Audio" },
];

export default function TemplateDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [template, setTemplate] = useState<Template | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [saveError, setSaveError] = useState("");
  const justSubmitted = searchParams.get("submitted") === "true";

  // Edit form state
  const [formData, setFormData] = useState({
    name: "",
    category: "utility",
    language: "en",
    body: "",
    headerType: "none",
    headerContent: "",
    footerContent: "",
  });
  const [variables, setVariables] = useState<string[]>([]);
  const [buttons, setButtons] = useState<TemplateButton[]>([]);
  const [mediaAttachments, setMediaAttachments] = useState<MediaAttachment[]>([]);

  const isEditable = (status: string) =>
    status === "draft" || status === "rejected";

  const extractVariables = (text: string) => {
    const regex = /\{\{(\d+)\}\}/g;
    const found: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!found.includes(match[1])) found.push(match[1]);
    }
    return found.sort((a, b) => parseInt(a) - parseInt(b));
  };

  const populateForm = (t: Template) => {
    setFormData({
      name: t.name,
      category: t.category,
      language: t.language || "en",
      body: t.body,
      headerType: t.headerType || "none",
      headerContent: t.headerContent || "",
      footerContent: t.footerContent || "",
    });
    setVariables(extractVariables(t.body));
    try {
      setButtons(t.buttons ? JSON.parse(t.buttons) : []);
    } catch {
      setButtons([]);
    }
    try {
      setMediaAttachments(t.mediaAttachments ? JSON.parse(t.mediaAttachments) : []);
    } catch {
      setMediaAttachments([]);
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
        populateForm(data);
      }
    } catch (error) {
      console.error("Failed to fetch template:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleBodyChange = (value: string) => {
    setFormData((f) => ({ ...f, body: value }));
    setVariables(extractVariables(value));
  };

  const insertVariable = () => {
    const nextNum =
      variables.length > 0 ? Math.max(...variables.map(Number)) + 1 : 1;
    handleBodyChange(formData.body + ` {{${nextNum}}}`);
  };

  // Buttons helpers
  const addButton = () => {
    if (buttons.length >= 4) return;
    setButtons([...buttons, { type: "QUICK_REPLY", text: "" }]);
  };

  const removeButton = (i: number) =>
    setButtons(buttons.filter((_, idx) => idx !== i));

  const updateButton = (i: number, changes: Partial<TemplateButton>) =>
    setButtons(buttons.map((b, idx) => (idx === i ? { ...b, ...changes } : b)));

  // Media helpers
  const addMedia = () => {
    if (mediaAttachments.length >= 4) return;
    setMediaAttachments([
      ...mediaAttachments,
      { type: "image", url: "", name: "" },
    ]);
  };

  const removeMedia = (i: number) =>
    setMediaAttachments(mediaAttachments.filter((_, idx) => idx !== i));

  const updateMedia = (i: number, changes: Partial<MediaAttachment>) =>
    setMediaAttachments(
      mediaAttachments.map((m, idx) => (idx === i ? { ...m, ...changes } : m))
    );

  const buildPayload = () => ({
    ...formData,
    headerType: formData.headerType === "none" ? null : formData.headerType,
    headerContent: formData.headerType === "none" ? null : formData.headerContent,
    buttons:
      buttons.length > 0
        ? JSON.stringify(
            buttons.map((b) => {
              const clean: Record<string, string> = {
                type: b.type,
                text: b.text,
              };
              if (b.type === "URL" && b.url) clean.url = b.url;
              if (b.type === "PHONE_NUMBER" && b.phone_number)
                clean.phone_number = b.phone_number;
              return clean;
            })
          )
        : null,
    mediaAttachments:
      mediaAttachments.filter((m) => m.url).length > 0
        ? JSON.stringify(mediaAttachments.filter((m) => m.url))
        : null,
  });

  const handleSaveDraft = async () => {
    if (!template) return;
    setSaving(true);
    setSaveError("");
    try {
      const res = await fetch(`/api/templates/${template.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (res.ok) {
        setTemplate(data);
        populateForm(data);
      } else {
        setSaveError(data.error || "Failed to save");
      }
    } catch {
      setSaveError("Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAndSubmit = async () => {
    if (!template) return;
    setSaving(true);
    setSaveError("");
    setSubmitError("");
    try {
      // Save first
      const putRes = await fetch(`/api/templates/${template.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const putData = await putRes.json();
      if (!putRes.ok) {
        setSaveError(putData.error || "Failed to save");
        setSaving(false);
        return;
      }
      // Then submit
      const submitRes = await fetch(`/api/templates/${template.id}/submit`, {
        method: "POST",
      });
      const submitData = await submitRes.json();
      if (submitRes.ok) {
        setTemplate(submitData);
        router.replace(`/dashboard/templates/${template.id}?submitted=true`);
      } else {
        setTemplate(putData);
        populateForm(putData);
        setSubmitError(
          submitData.error ||
            "Template saved but Meta submission failed. Retry from here."
        );
      }
    } catch {
      setSaveError("Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!template) return;
    setDuplicating(true);
    try {
      const res = await fetch(`/api/templates/${template.id}/duplicate`, {
        method: "POST",
      });
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

  const editable = isEditable(template.status);

  const actionButtons = (
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
  );

  // ── EDIT FORM (draft / rejected) ────────────────────────────────────────────
  if (editable) {
    return (
      <div className="max-w-2xl">
        <Button variant="ghost" asChild className="mb-4">
          <Link href="/dashboard/templates">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Templates
          </Link>
        </Button>

        {template.status === "rejected" && template.rejectionReason && (
          <Card className="mb-6 bg-red-50 border-red-200">
            <CardContent className="flex items-start gap-3 py-4">
              <XCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-red-900">Template Rejected</p>
                <p className="text-sm text-red-700 mt-1">
                  {template.rejectionReason}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-xl">Edit Template</CardTitle>
                <CardDescription>
                  Created {new Date(template.createdAt).toLocaleDateString()}
                </CardDescription>
              </div>
              {actionButtons}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Template Name</Label>
              <Input
                id="name"
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

            {/* Category */}
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

            {/* Language */}
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
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Header */}
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

            {/* Body */}
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
                  Variables: {variables.map((v) => `{{${v}}}`).join(", ")}
                </p>
              )}
            </div>

            {/* Footer */}
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

            {/* Buttons */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Buttons (max 4)</Label>
                {buttons.length < 4 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addButton}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add Button
                  </Button>
                )}
              </div>
              {buttons.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No buttons added. Up to 4 buttons supported.
                </p>
              )}
              {buttons.map((btn, i) => (
                <div
                  key={i}
                  className="p-3 border rounded-md bg-gray-50 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-600">
                      Button {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeButton(i)}
                      className="text-red-400 hover:text-red-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <select
                        className="w-full h-9 px-2 border rounded-md bg-white text-sm"
                        value={btn.type}
                        onChange={(e) =>
                          updateButton(i, {
                            type: e.target.value as TemplateButton["type"],
                            url: undefined,
                            phone_number: undefined,
                          })
                        }
                      >
                        {BUTTON_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Input
                      placeholder="Button text"
                      value={btn.text}
                      onChange={(e) => updateButton(i, { text: e.target.value })}
                      className="h-9 text-sm"
                    />
                  </div>
                  {btn.type === "URL" && (
                    <Input
                      placeholder="https://example.com"
                      value={btn.url || ""}
                      onChange={(e) => updateButton(i, { url: e.target.value })}
                      className="h-9 text-sm"
                    />
                  )}
                  {btn.type === "PHONE_NUMBER" && (
                    <Input
                      placeholder="+91XXXXXXXXXX"
                      value={btn.phone_number || ""}
                      onChange={(e) =>
                        updateButton(i, { phone_number: e.target.value })
                      }
                      className="h-9 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>

            {/* Media Attachments */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Media Attachments (max 4)</Label>
                {mediaAttachments.length < 4 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addMedia}
                  >
                    <Paperclip className="w-3 h-3 mr-1" />
                    Add Media
                  </Button>
                )}
              </div>
              {mediaAttachments.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No media attached. Add up to 4 images, videos, or documents.
                </p>
              )}
              {mediaAttachments.map((media, i) => (
                <div
                  key={i}
                  className="p-3 border rounded-md bg-gray-50 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-600">
                      Media {i + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeMedia(i)}
                      className="text-red-400 hover:text-red-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <select
                      className="h-9 px-2 border rounded-md bg-white text-sm"
                      value={media.type}
                      onChange={(e) =>
                        updateMedia(i, {
                          type: e.target.value as MediaAttachment["type"],
                        })
                      }
                    >
                      {MEDIA_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <Input
                      placeholder="Display name"
                      value={media.name}
                      onChange={(e) => updateMedia(i, { name: e.target.value })}
                      className="h-9 text-sm"
                    />
                    <Input
                      placeholder="URL"
                      value={media.url}
                      onChange={(e) => updateMedia(i, { url: e.target.value })}
                      className="h-9 text-sm col-span-3"
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Errors */}
            {(saveError || submitError) && (
              <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
                {saveError || submitError}
              </div>
            )}
          </CardContent>

          <div className="p-6 pt-0 flex gap-3">
            <Button
              variant="outline"
              onClick={handleSaveDraft}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save Draft"}
            </Button>
            <Button onClick={handleSaveAndSubmit} disabled={saving}>
              <Send className="w-4 h-4 mr-2" />
              {saving ? "Submitting…" : "Save & Submit"}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // ── READ-ONLY VIEW (submitted / pending / approved) ──────────────────────────
  const parsedButtons: TemplateButton[] = (() => {
    try {
      return template.buttons ? JSON.parse(template.buttons) : [];
    } catch {
      return [];
    }
  })();
  const parsedMedia: MediaAttachment[] = (() => {
    try {
      return template.mediaAttachments
        ? JSON.parse(template.mediaAttachments)
        : [];
    } catch {
      return [];
    }
  })();

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
            {actionButtons}
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

          {parsedButtons.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Buttons
              </h4>
              <div className="space-y-2">
                {parsedButtons.map((btn, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 p-2 bg-gray-50 rounded-md text-sm"
                  >
                    <span className="text-xs bg-gray-200 px-2 py-0.5 rounded font-mono">
                      {btn.type}
                    </span>
                    <span>{btn.text}</span>
                    {btn.url && (
                      <span className="text-gray-500 text-xs truncate">
                        → {btn.url}
                      </span>
                    )}
                    {btn.phone_number && (
                      <span className="text-gray-500 text-xs">
                        → {btn.phone_number}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {parsedMedia.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Media Attachments
              </h4>
              <div className="space-y-2">
                {parsedMedia.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 p-2 bg-gray-50 rounded-md text-sm"
                  >
                    <Paperclip className="w-4 h-4 text-gray-400 shrink-0" />
                    <span className="text-xs bg-gray-200 px-2 py-0.5 rounded font-mono">
                      {m.type}
                    </span>
                    <span>{m.name || "Untitled"}</span>
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 text-xs truncate hover:underline ml-auto"
                    >
                      {m.url}
                    </a>
                  </div>
                ))}
              </div>
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

