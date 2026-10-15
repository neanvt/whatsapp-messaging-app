"use client";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
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
  Send,
  MessageSquare,
  AlertCircle,
  CheckCircle,
  Upload,
  XCircle,
  Users,
  FileText,
} from "lucide-react";
import Link from "next/link";

interface WhatsAppNumber {
  id: string;
  phoneNumber: string;
  verificationStatus: string;
}

interface Template {
  id: string;
  name: string;
  body: string;
  headerType: string | null;
  headerContent: string | null;
  footerContent: string | null;
  buttons: string | null;
  category: string;
  status: string;
}

// Parse a template body into its parameter model. Named params ({{event}}) and
// numbered params ({{1}}) are mutually exclusive in a WhatsApp template; we pick
// named if ANY non-numeric placeholder appears. Names/numbers are returned in
// first-occurrence order, de-duplicated — matching the backend's parsing.
function parseBodyParams(
  body: string,
): { kind: "named"; names: string[] } | { kind: "numbered"; numbers: number[] } {
  const tokens = Array.from(body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map(
    (m) => m[1],
  );
  const hasNamed = tokens.some((t) => isNaN(Number(t)));
  if (hasNamed) {
    const names: string[] = [];
    for (const t of tokens) if (isNaN(Number(t)) && !names.includes(t)) names.push(t);
    return { kind: "named", names };
  }
  const numbers: number[] = [];
  for (const t of tokens) {
    const n = parseInt(t, 10);
    if (!Number.isNaN(n) && !numbers.includes(n)) numbers.push(n);
  }
  numbers.sort((a, b) => a - b);
  return { kind: "numbered", numbers };
}

// Does the template's buttons JSON contain a dynamic URL (a {{...}} placeholder)?
function templateHasDynamicButton(buttonsJson: string | null): boolean {
  if (!buttonsJson) return false;
  try {
    const btns = JSON.parse(buttonsJson);
    return (
      Array.isArray(btns) &&
      btns.some(
        (b) =>
          (b?.type === "URL" || b?.type === "url") &&
          typeof b?.url === "string" &&
          b.url.includes("{{"),
      )
    );
  } catch {
    // Non-array/plain string buttons payload — fall back to a loose scan.
    return buttonsJson.includes("{{");
  }
}

interface CreditBalance {
  totalCredits: number;
  usedCredits: number;
}

interface SendResult {
  phone: string;
  status: "sent" | "failed";
  error?: string;
}

export default function SendMessagePage() {
  const searchParams = useSearchParams();
  const preselectedTemplate = searchParams.get("template");

  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [loading, setLoading] = useState(true);

  const [formData, setFormData] = useState({
    numberId: "",
    templateId: preselectedTemplate || "",
  });

  const [variables, setVariables] = useState<Record<number, string>>({});
  // Named-template param values (keyed by name) + media-header URL + dynamic
  // button value, for templates that need them (e.g. niqen_invite).
  const [namedValues, setNamedValues] = useState<Record<string, string>>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState("");
  const [buttonValue, setButtonValue] = useState("");
  // Header image upload: base64 payload (data stripped of the data: prefix) +
  // original filename. When set, it is sent instead of the URL — the server
  // stores it in MediaStore and gives Meta a public URL to fetch.
  const [headerMediaBase64, setHeaderMediaBase64] = useState("");
  const [headerMediaFileName, setHeaderMediaFileName] = useState("");
  const [headerMediaUploading, setHeaderMediaUploading] = useState(false);
  const headerMediaInputRef = useRef<HTMLInputElement>(null);

  // Recipients — manual textarea or CSV
  const [recipientMode, setRecipientMode] = useState<"manual" | "csv">(
    "manual",
  );
  const [recipientText, setRecipientText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [parsedRecipients, setParsedRecipients] = useState<string[]>([]);
  // Per-recipient variable values parsed from CSV (phone → {varNum: value})
  const [csvPerRecipientVars, setCsvPerRecipientVars] = useState<
    Record<string, Record<number, string>>
  >({});
  const csvInputRef = useRef<HTMLInputElement>(null);

  // Send progress
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState({
    total: 0,
    sent: 0,
    failed: 0,
    current: "",
  });
  const [results, setResults] = useState<SendResult[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (preselectedTemplate) {
      setFormData((prev) => ({ ...prev, templateId: preselectedTemplate }));
    }
  }, [preselectedTemplate]);

  // Parse recipients whenever text changes (manual mode)
  useEffect(() => {
    if (recipientMode === "manual") {
      const phones = recipientText
        .split(/[\n,;]+/)
        .map((p) => p.trim().replace(/\s+/g, ""))
        .filter((p) => p.length >= 7);
      setParsedRecipients(phones);
    }
  }, [recipientText, recipientMode]);

  const fetchData = async () => {
    try {
      const [numbersRes, templatesRes, creditsRes] = await Promise.all([
        fetch("/api/numbers"),
        fetch("/api/templates"),
        fetch("/api/credits/balance"),
      ]);
      if (numbersRes.ok) {
        const data = await numbersRes.json();
        setNumbers(
          data.filter(
            (n: WhatsAppNumber) => n.verificationStatus === "verified",
          ),
        );
      }
      if (templatesRes.ok) {
        const data = await templatesRes.json();
        setTemplates(data.filter((t: Template) => t.status === "approved"));
      }
      if (creditsRes.ok) setCredits(await creditsRes.json());
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split(/\r?\n/).filter(Boolean);

      // Detect header row and find the phone column + any numeric variable columns
      let phoneColIndex = 0;
      let start = 0;
      const varColMap: Array<{ colIndex: number; varNum: number }> = [];

      if (/[a-zA-Z\d]/.test(lines[0])) {
        const rawHeaders = lines[0].split(",").map((h) => h.trim());
        const headers = rawHeaders.map((h) => h.toLowerCase());
        const phoneIdx = headers.findIndex((h) =>
          /phone|mobile|tel|contact/.test(h),
        );
        // Only treat first row as header if it has a phone-like column or a non-pure-digit column
        const looksLikeHeader =
          phoneIdx >= 0 || headers.some((h) => /[a-zA-Z]/.test(h));
        if (looksLikeHeader) {
          start = 1;
          phoneColIndex = phoneIdx >= 0 ? phoneIdx : 0;
          // Columns with purely numeric headers map to template variables
          rawHeaders.forEach((h, i) => {
            if (/^\d+$/.test(h) && i !== phoneColIndex) {
              varColMap.push({ colIndex: i, varNum: parseInt(h) });
            }
          });
        }
      }

      const recipients = lines
        .slice(start)
        .map((line) => {
          const cols = line.split(",");
          let col = (cols[phoneColIndex] ?? "").trim();
          if (!col || col.replace(/[^\d]/g, "").length < 7) {
            col =
              cols.find((c) => c.trim().replace(/[^\d]/g, "").length >= 7) ??
              col;
          }
          const phone = col.trim().replace(/[^\d+]/g, "");
          const vars: Record<number, string> = {};
          varColMap.forEach(({ colIndex, varNum }) => {
            vars[varNum] = (cols[colIndex] ?? "").trim();
          });
          return { phone, vars };
        })
        .filter(({ phone }) => phone.replace(/[^\d]/g, "").length >= 7);

      setParsedRecipients(recipients.map((r) => r.phone));
      if (varColMap.length > 0) {
        const perVars: Record<string, Record<number, string>> = {};
        recipients.forEach(({ phone, vars }) => {
          perVars[phone] = vars;
        });
        setCsvPerRecipientVars(perVars);
      } else {
        setCsvPerRecipientVars({});
      }
    };
    reader.readAsText(file);
  };

  // Read an uploaded header image/video/document into base64 for the send.
  const handleHeaderMediaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Guard: keep uploads reasonable (WhatsApp image limit is 5MB).
    if (file.size > 5 * 1024 * 1024) {
      setError("Header media must be 5MB or smaller.");
      if (headerMediaInputRef.current) headerMediaInputRef.current.value = "";
      return;
    }
    setError("");
    setHeaderMediaUploading(true);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = (ev.target?.result as string) || "";
      // Strip the "data:<mime>;base64," prefix — the server stores raw base64.
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      setHeaderMediaBase64(base64);
      setHeaderMediaFileName(file.name);
      setHeaderMediaUrl(""); // uploaded file takes precedence over a pasted URL
      setHeaderMediaUploading(false);
    };
    reader.onerror = () => {
      setError("Could not read the selected file.");
      setHeaderMediaUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const clearHeaderMedia = () => {
    setHeaderMediaBase64("");
    setHeaderMediaFileName("");
    if (headerMediaInputRef.current) headerMediaInputRef.current.value = "";
  };

  const selectedTemplate = templates.find((t) => t.id === formData.templateId);

  const paramModel = selectedTemplate
    ? parseBodyParams(selectedTemplate.body)
    : ({ kind: "numbered", numbers: [] } as ReturnType<typeof parseBodyParams>);
  const isNamed = paramModel.kind === "named";

  // Numbered placeholders (empty for named templates).
  const templateVariables = paramModel.kind === "numbered" ? paramModel.numbers : [];
  // Named placeholders in declared order (empty for numbered templates).
  const templateNamedVars = paramModel.kind === "named" ? paramModel.names : [];

  const headerTypeLc = (selectedTemplate?.headerType || "").toLowerCase();
  const isMediaHeader =
    headerTypeLc === "image" ||
    headerTypeLc === "video" ||
    headerTypeLc === "document";
  const hasDynamicButton =
    !!selectedTemplate &&
    selectedTemplate.category !== "authentication" &&
    templateHasDynamicButton(selectedTemplate.buttons);

  // Resolved preview: substitute the entered values into the body. Named by
  // name; numbered by {{n}} (indexed by the token value, not list position).
  const previewBody = selectedTemplate
    ? isNamed
      ? templateNamedVars.reduce(
          (acc, name) =>
            acc.replace(
              new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g"),
              namedValues[name] || `{{${name}}}`,
            ),
          selectedTemplate.body,
        )
      : templateVariables.reduce(
          (acc, v) => acc.replace(`{{${v}}}`, variables[v] || `{{${v}}}`),
          selectedTemplate.body,
        )
    : "";

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setDone(false);
    setResults([]);

    if (!formData.numberId) return setError("Please select a WhatsApp number");
    if (!formData.templateId) return setError("Please select a template");
    if (parsedRecipients.length === 0)
      return setError("Please enter at least one recipient phone number");

    if (isNamed) {
      const missingNamed = templateNamedVars.filter((n) => !namedValues[n]);
      if (missingNamed.length > 0) {
        return setError(
          `Fill in template variables: ${missingNamed.map((n) => `{{${n}}}`).join(", ")}`,
        );
      }
    } else {
      const hasCsvVars = Object.keys(csvPerRecipientVars).length > 0;
      const missingVars = templateVariables.filter((v) => {
        if (
          hasCsvVars &&
          Object.values(csvPerRecipientVars)[0]?.[v] !== undefined
        )
          return false;
        return !variables[v];
      });
      if (missingVars.length > 0) {
        return setError(
          `Fill in template variables: ${missingVars.map((v) => `{{${v}}}`).join(", ")}`,
        );
      }
    }

    // Media-header templates need a source: either a public URL or an upload.
    if (isMediaHeader && !headerMediaUrl.trim() && !headerMediaBase64) {
      return setError(
        `This template has a ${headerTypeLc} header — upload a file or provide a public media URL.`,
      );
    }
    if (hasDynamicButton && !buttonValue.trim()) {
      return setError("This template has a dynamic button — provide a button value.");
    }

    const needed = parsedRecipients.length;
    if ((credits?.totalCredits ?? 0) < needed) {
      return setError(
        `Insufficient credits. Need ${needed}, have ${credits?.totalCredits ?? 0}.`,
      );
    }

    setSending(true);
    setProgress({ total: needed, sent: 0, failed: 0, current: "" });
    const sendResults: SendResult[] = [];

    for (const phone of parsedRecipients) {
      setProgress((p) => ({ ...p, current: phone }));
      try {
        const res = await fetch("/api/messages/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            numberId: formData.numberId,
            recipient: phone.replace(/\D/g, ""),
            templateId: formData.templateId,
            // Body params: named map for named templates, positional array for
            // numbered (CSV per-recipient values still apply to numbered).
            ...(isNamed
              ? { namedParams: namedValues }
              : {
                  variables: templateVariables.map(
                    (v) => csvPerRecipientVars[phone]?.[v] ?? variables[v] ?? "",
                  ),
                }),
            // Media header source — an uploaded file (base64) takes precedence
            // over a pasted URL. The server stores base64 in MediaStore and
            // gives Meta a public URL to fetch.
            ...(isMediaHeader
              ? headerMediaBase64
                ? headerTypeLc === "document"
                  ? {
                      documentBase64: headerMediaBase64,
                      fileName: headerMediaFileName,
                    }
                  : { mediaBase64: headerMediaBase64 }
                : headerMediaUrl.trim()
                  ? headerTypeLc === "document"
                    ? { documentUrl: headerMediaUrl.trim() }
                    : { mediaUrl: headerMediaUrl.trim() }
                  : {}
              : {}),
            // Dynamic URL button value.
            ...(hasDynamicButton && buttonValue.trim()
              ? { buttonParam: buttonValue.trim() }
              : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          sendResults.push({ phone, status: "failed", error: data.error });
          setProgress((p) => ({ ...p, failed: p.failed + 1 }));
        } else {
          sendResults.push({ phone, status: "sent" });
          setProgress((p) => ({ ...p, sent: p.sent + 1 }));
        }
      } catch {
        sendResults.push({ phone, status: "failed", error: "Network error" });
        setProgress((p) => ({ ...p, failed: p.failed + 1 }));
      }
      setResults([...sendResults]);
    }

    setProgress((p) => ({ ...p, current: "" }));
    setSending(false);
    setDone(true);

    // Refresh credits
    const cr = await fetch("/api/credits/balance");
    if (cr.ok) setCredits(await cr.json());
  };

  const resetForm = () => {
    clearHeaderMedia();
    setRecipientText("");
    setParsedRecipients([]);
    setCsvPerRecipientVars({});
    setCsvFileName("");
    setResults([]);
    setDone(false);
    setError("");
    setProgress({ total: 0, sent: 0, failed: 0, current: "" });
    if (csvInputRef.current) csvInputRef.current.value = "";
  };

  if (loading)
    return (
      <div className="flex items-center justify-center py-12">Loading...</div>
    );

  const progressPct =
    progress.total > 0
      ? Math.round(((progress.sent + progress.failed) / progress.total) * 100)
      : 0;

  return (
    <div>
      <div className="mb-6">
        <Button variant="ghost" asChild className="mb-4">
          <Link href="/dashboard/messages">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Messages
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">Send Message</h1>
        <p className="text-muted-foreground">
          Send a WhatsApp message using an approved template
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Compose */}
        <Card>
          <CardHeader>
            <CardTitle>Compose Message</CardTitle>
            <CardDescription>
              Select a template and fill in the details
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSend}>
            <CardContent className="space-y-4">
              {error && (
                <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* From Number */}
              <div className="space-y-2">
                <Label htmlFor="number">From Number</Label>
                <select
                  id="number"
                  className="w-full h-10 px-3 border rounded-md bg-background text-sm"
                  value={formData.numberId}
                  onChange={(e) =>
                    setFormData({ ...formData, numberId: e.target.value })
                  }
                  required
                >
                  <option value="">Select a number</option>
                  {numbers.map((num) => (
                    <option key={num.id} value={num.id}>
                      {num.phoneNumber}
                    </option>
                  ))}
                </select>
                {numbers.length === 0 && (
                  <p className="text-xs text-amber-600">
                    No verified numbers.{" "}
                    <Link href="/dashboard/numbers/add" className="underline">
                      Add one
                    </Link>
                  </p>
                )}
              </div>

              {/* Template */}
              <div className="space-y-2">
                <Label htmlFor="template">Template</Label>
                <select
                  id="template"
                  className="w-full h-10 px-3 border rounded-md bg-background text-sm"
                  value={formData.templateId}
                  onChange={(e) => {
                    setFormData({ ...formData, templateId: e.target.value });
                    setVariables({});
                    setNamedValues({});
                    setHeaderMediaUrl("");
                    setButtonValue("");
                    clearHeaderMedia();
                  }}
                  required
                >
                  <option value="">Select a template</option>
                  {templates.map((tmpl) => (
                    <option key={tmpl.id} value={tmpl.id}>
                      {tmpl.name} ({tmpl.category})
                    </option>
                  ))}
                </select>
                {templates.length === 0 && (
                  <p className="text-xs text-amber-600">
                    No approved templates.{" "}
                    <Link href="/dashboard/templates/new" className="underline">
                      Create one
                    </Link>
                  </p>
                )}
              </div>

              {/* Named template variables (e.g. {{event}}, {{guest_name}}) */}
              {isNamed && templateNamedVars.length > 0 && (
                <div className="space-y-3 pt-1">
                  <Label>Template Variables</Label>
                  {templateNamedVars.map((name) => (
                    <div key={name}>
                      <Label className="text-xs text-muted-foreground mb-1 block">
                        {"{{" + name + "}}"}
                      </Label>
                      <Input
                        placeholder={`Value for {{${name}}}`}
                        value={namedValues[name] || ""}
                        onChange={(e) =>
                          setNamedValues({
                            ...namedValues,
                            [name]: e.target.value,
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Media header: upload a file OR paste a public URL */}
              {isMediaHeader && (
                <div className="space-y-2 pt-1">
                  <Label className="text-xs text-muted-foreground">
                    Header media ({headerTypeLc})
                  </Label>

                  {/* Upload */}
                  {headerMediaFileName ? (
                    <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{headerMediaFileName}</span>
                      </span>
                      <button
                        type="button"
                        onClick={clearHeaderMedia}
                        className="shrink-0 text-xs text-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div
                      className="border-2 border-dashed rounded-md p-4 text-center cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => headerMediaInputRef.current?.click()}
                    >
                      <input
                        ref={headerMediaInputRef}
                        type="file"
                        accept={
                          headerTypeLc === "image"
                            ? "image/*"
                            : headerTypeLc === "video"
                              ? "video/*"
                              : "application/pdf"
                        }
                        className="hidden"
                        onChange={handleHeaderMediaUpload}
                      />
                      <Upload className="w-6 h-6 mx-auto mb-1 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        {headerMediaUploading
                          ? "Reading file…"
                          : `Click to upload ${headerTypeLc} (max 5MB)`}
                      </p>
                    </div>
                  )}

                  {/* OR paste a URL (disabled once a file is chosen) */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">or URL:</span>
                    <Input
                      placeholder="https://… (public URL Meta can fetch)"
                      value={headerMediaUrl}
                      onChange={(e) => setHeaderMediaUrl(e.target.value)}
                      disabled={!!headerMediaFileName}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This template has a {headerTypeLc} header. Upload a file or
                    paste a public URL — Meta fetches the media to send it.
                  </p>
                </div>
              )}

              {/* Dynamic URL button value */}
              {hasDynamicButton && (
                <div className="space-y-1 pt-1">
                  <Label className="text-xs text-muted-foreground">
                    Button value
                  </Label>
                  <Input
                    placeholder="Value for the button's dynamic URL"
                    value={buttonValue}
                    onChange={(e) => setButtonValue(e.target.value)}
                  />
                </div>
              )}

              {/* Numbered template variables */}
              {!isNamed && templateVariables.length > 0 && (
                <div className="space-y-3 pt-1">
                  <div className="flex items-center gap-2">
                    <Label>Template Variables</Label>
                    {recipientMode === "csv" &&
                      Object.keys(csvPerRecipientVars).length > 0 && (
                        <span className="text-xs text-green-600 font-medium bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                          Per-recipient from CSV
                        </span>
                      )}
                  </div>
                  {templateVariables.map((varNum) => {
                    const fromCsv =
                      recipientMode === "csv" &&
                      Object.values(csvPerRecipientVars)[0]?.[varNum] !==
                        undefined;
                    return (
                      <div key={varNum}>
                        <div className="flex items-center gap-2 mb-1">
                          <Label className="text-xs text-muted-foreground">
                            Variable {"{{" + varNum + "}}"}
                          </Label>
                          {fromCsv && (
                            <span className="text-xs text-blue-600 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">
                              CSV column &ldquo;{varNum}&rdquo;
                            </span>
                          )}
                        </div>
                        <Input
                          placeholder={
                            fromCsv
                              ? `Fallback if CSV missing (e.g. ${Object.values(csvPerRecipientVars)[0]?.[varNum]})`
                              : "Value for {{" + varNum + "}}"
                          }
                          value={variables[varNum] || ""}
                          onChange={(e) =>
                            setVariables({
                              ...variables,
                              [varNum]: e.target.value,
                            })
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Recipients */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Recipients</Label>
                  <div className="flex text-xs gap-1 border rounded-md overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setRecipientMode("manual")}
                      className={`px-3 py-1 transition-colors ${recipientMode === "manual" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
                    >
                      <Users className="w-3 h-3 inline mr-1" />
                      Manual
                    </button>
                    <button
                      type="button"
                      onClick={() => setRecipientMode("csv")}
                      className={`px-3 py-1 transition-colors ${recipientMode === "csv" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
                    >
                      <FileText className="w-3 h-3 inline mr-1" />
                      CSV
                    </button>
                  </div>
                </div>

                {recipientMode === "manual" ? (
                  <>
                    <textarea
                      className="w-full px-3 py-2 border rounded-md bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                      rows={4}
                      placeholder={
                        "Enter one phone number per line (with country code):\n+919876543210\n+917012345678\n919998887776"
                      }
                      value={recipientText}
                      onChange={(e) => setRecipientText(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Separate by newline, comma, or semicolon.
                      {parsedRecipients.length > 0 && (
                        <span className="ml-1 text-primary font-medium">
                          {parsedRecipients.length} number
                          {parsedRecipients.length !== 1 ? "s" : ""} detected.
                        </span>
                      )}
                    </p>
                  </>
                ) : (
                  <div
                    className="border-2 border-dashed rounded-md p-6 text-center cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => csvInputRef.current?.click()}
                  >
                    <input
                      ref={csvInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={handleCsvUpload}
                    />
                    <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    {csvFileName ? (
                      <>
                        <p className="text-sm font-medium">{csvFileName}</p>
                        <p className="text-xs text-primary mt-1">
                          {parsedRecipients.length} number
                          {parsedRecipients.length !== 1 ? "s" : ""} loaded
                        </p>
                        {Object.keys(csvPerRecipientVars).length > 0 && (
                          <p className="text-xs text-green-600 mt-1">
                            Variable columns:{" "}
                            {[
                              ...new Set(
                                Object.values(csvPerRecipientVars).flatMap(
                                  (v) => Object.keys(v),
                                ),
                              ),
                            ]
                              .sort()
                              .map((k) => `{{${k}}}`)
                              .join(", ")}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Click to upload a CSV file
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Include a &quot;Phone&quot; column with country codes,
                          or one column of numbers only
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Progress bar (shown while sending or after done) */}
              {(sending || done) && progress.total > 0 && (
                <div className="space-y-2 pt-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {sending ? `Sending to ${progress.current}…` : "Complete"}
                    </span>
                    <span>
                      {progress.sent + progress.failed} / {progress.total}
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-2 rounded-full transition-all duration-300 ${progress.failed > 0 && progress.sent === 0 ? "bg-red-500" : progress.failed > 0 ? "bg-amber-500" : "bg-green-500"}`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  <div className="flex gap-4 text-xs">
                    <span className="text-green-600 font-medium">
                      ✓ {progress.sent} sent
                    </span>
                    {progress.failed > 0 && (
                      <span className="text-red-500 font-medium">
                        ✗ {progress.failed} failed
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="pt-2 flex gap-2">
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={sending || parsedRecipients.length === 0}
                >
                  {sending ? (
                    <>
                      <span className="animate-spin mr-2 inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                      Sending…
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      Send to {parsedRecipients.length || "…"} Recipient
                      {parsedRecipients.length !== 1 ? "s" : ""}
                    </>
                  )}
                </Button>
                {done && (
                  <Button type="button" variant="outline" onClick={resetForm}>
                    Reset
                  </Button>
                )}
              </div>
            </CardContent>
          </form>
        </Card>

        {/* Right: Preview + Results */}
        <div className="space-y-6">
          {/* Template Preview */}
          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>How your message will look</CardDescription>
            </CardHeader>
            <CardContent>
              {selectedTemplate ? (
                <div className="space-y-4">
                  {selectedTemplate.headerType &&
                    selectedTemplate.headerType !== "none" && (
                      <div className="p-3 bg-gray-100 rounded-lg">
                        <p className="text-sm text-muted-foreground mb-1">
                          Header
                        </p>
                        <p className="font-medium">
                          {selectedTemplate.headerType === "text"
                            ? "Text Header"
                            : "Media"}
                        </p>
                      </div>
                    )}
                  <div className="p-4 bg-[#DCF8C6] rounded-lg">
                    <div className="flex items-start space-x-3">
                      <div className="w-10 h-10 bg-[#25D366] rounded-full flex items-center justify-center flex-shrink-0">
                        <MessageSquare className="w-5 h-5 text-white" />
                      </div>
                      <p className="text-sm whitespace-pre-wrap flex-1">
                        {previewBody || selectedTemplate.body}
                      </p>
                    </div>
                  </div>
                  {selectedTemplate.footerContent && (
                    <p className="text-xs text-muted-foreground text-center">
                      {selectedTemplate.footerContent}
                    </p>
                  )}
                  <div className="border-t pt-4 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        Cost per message:
                      </span>
                      <Badge variant="secondary">1 Credit</Badge>
                    </div>
                    {parsedRecipients.length > 1 && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          Total cost:
                        </span>
                        <Badge variant="secondary">
                          {parsedRecipients.length} Credits
                        </Badge>
                      </div>
                    )}
                    {credits && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">
                          Your balance:
                        </span>
                        <span
                          className={
                            credits.totalCredits >= parsedRecipients.length
                              ? "text-green-600"
                              : "text-red-600"
                          }
                        >
                          {credits.totalCredits} Credits
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>Select a template to see the preview</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Results table — shown after send */}
          {results.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Send Results
                  {done && progress.failed === 0 && (
                    <CheckCircle className="w-4 h-4 text-green-500" />
                  )}
                  {done && progress.failed > 0 && (
                    <AlertCircle className="w-4 h-4 text-amber-500" />
                  )}
                </CardTitle>
                <CardDescription>
                  {progress.sent} of {progress.total} messages sent successfully
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {results.map((r, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between px-3 py-2 rounded-md text-sm ${r.status === "sent" ? "bg-green-50" : "bg-red-50"}`}
                    >
                      <span className="font-mono">{r.phone}</span>
                      <div className="flex items-center gap-1">
                        {r.status === "sent" ? (
                          <>
                            <CheckCircle className="w-3 h-3 text-green-500" />
                            <span className="text-green-600 text-xs">Sent</span>
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3 h-3 text-red-500" />
                            <span className="text-red-500 text-xs">
                              {r.error || "Failed"}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
