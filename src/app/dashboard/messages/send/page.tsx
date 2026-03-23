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
  category: string;
  status: string;
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

  // Recipients — manual textarea or CSV
  const [recipientMode, setRecipientMode] = useState<"manual" | "csv">(
    "manual",
  );
  const [recipientText, setRecipientText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [parsedRecipients, setParsedRecipients] = useState<string[]>([]);
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
      // Skip header if first row contains letters (e.g. "phone", "number")
      const start = /[a-zA-Z]/.test(lines[0]) ? 1 : 0;
      const phones = lines
        .slice(start)
        .map((line) => {
          // Take first column and strip non-digit chars except leading +
          const col = line.split(",")[0].trim();
          return col.replace(/[^\d+]/g, "");
        })
        .filter((p) => p.length >= 7);
      setParsedRecipients(phones);
    };
    reader.readAsText(file);
  };

  const selectedTemplate = templates.find((t) => t.id === formData.templateId);

  const extractVariables = (text: string) => {
    const regex = /\{\{(\d+)\}\}/g;
    const found: number[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!found.includes(parseInt(match[1]))) found.push(parseInt(match[1]));
    }
    return found.sort((a, b) => a - b);
  };

  const templateVariables = selectedTemplate
    ? extractVariables(selectedTemplate.body)
    : [];

  const previewBody = selectedTemplate
    ? templateVariables.reduce(
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

    const missingVars = templateVariables.filter((v) => !variables[v]);
    if (missingVars.length > 0) {
      return setError(
        `Fill in template variables: ${missingVars.map((v) => `{{${v}}}`).join(", ")}`,
      );
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
            variables: templateVariables.map((v) => variables[v]),
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
    setRecipientText("");
    setParsedRecipients([]);
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

              {/* Template Variables */}
              {templateVariables.length > 0 && (
                <div className="space-y-3 pt-1">
                  <Label>Template Variables</Label>
                  {templateVariables.map((varNum) => (
                    <div key={varNum}>
                      <Label className="text-xs text-muted-foreground">
                        Variable {"{{" + varNum + "}}"}
                      </Label>
                      <Input
                        placeholder={"Value for {{" + varNum + "}}"}
                        value={variables[varNum] || ""}
                        onChange={(e) =>
                          setVariables({
                            ...variables,
                            [varNum]: e.target.value,
                          })
                        }
                        className="mt-1"
                      />
                    </div>
                  ))}
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
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-muted-foreground">
                          Click to upload a CSV file
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          First column should contain phone numbers with country
                          code
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
