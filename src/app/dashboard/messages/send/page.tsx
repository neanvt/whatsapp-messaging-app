"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Send, MessageSquare, AlertCircle, CheckCircle } from "lucide-react";
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

export default function SendMessagePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedTemplate = searchParams.get("template");

  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const [formData, setFormData] = useState({
    numberId: "",
    recipient: "",
    templateId: preselectedTemplate || "",
  });

  const [variables, setVariables] = useState<Record<number, string>>({});

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (preselectedTemplate) {
      setFormData((prev) => ({ ...prev, templateId: preselectedTemplate }));
    }
  }, [preselectedTemplate]);

  const fetchData = async () => {
    try {
      const [numbersRes, templatesRes, creditsRes] = await Promise.all([
        fetch("/api/numbers"),
        fetch("/api/templates"),
        fetch("/api/credits/balance"),
      ]);

      if (numbersRes.ok) {
        const data = await numbersRes.json();
        setNumbers(data.filter((n: WhatsAppNumber) => n.verificationStatus === "verified"));
      }

      if (templatesRes.ok) {
        const data = await templatesRes.json();
        setTemplates(data.filter((t: Template) => t.status === "approved"));
      }

      if (creditsRes.ok) {
        const data = await creditsRes.json();
        setCredits(data);
      }
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  };

  const selectedTemplate = templates.find((t) => t.id === formData.templateId);

  const extractVariables = (text: string) => {
    const regex = /\{\{(\d+)\}\}/g;
    const found: number[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!found.includes(parseInt(match[1]))) {
        found.push(parseInt(match[1]));
      }
    }
    return found.sort((a, b) => a - b);
  };

  const templateVariables = selectedTemplate ? extractVariables(selectedTemplate.body) : [];

  const previewBody = selectedTemplate
    ? templateVariables.reduce((acc, varNum) => {
        return acc.replace(`{{${varNum}}}`, variables[varNum] || `{{${varNum}}}`);
      }, selectedTemplate.body)
    : "";

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!formData.numberId) {
      setError("Please select a WhatsApp number");
      return;
    }

    if (!formData.recipient) {
      setError("Please enter a recipient phone number");
      return;
    }

    if (!formData.templateId) {
      setError("Please select a template");
      return;
    }

    // Check if all variables are filled
    const missingVars = templateVariables.filter((v) => !variables[v]);
    if (missingVars.length > 0) {
      setError(`Please fill in all template variables (missing: ${missingVars.map((v) => `{{${v}}}`).join(", ")})`);
      return;
    }

    if ((credits?.totalCredits ?? 0) <= 0) {
      setError("Insufficient credits. Please purchase more credits.");
      return;
    }

    setSending(true);

    try {
      const res = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          numberId: formData.numberId,
          recipient: formData.recipient.replace(/\D/g, ""),
          templateId: formData.templateId,
          variables: templateVariables.map((v) => variables[v]),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to send message");
      } else {
        setSuccess(true);
        setVariables({});
        setFormData({ ...formData, recipient: "" });
      }
    } catch {
      setError("Something went wrong");
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12">Loading...</div>;
  }

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
        <p className="text-muted-foreground">Send a WhatsApp message using an approved template</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Compose Message</CardTitle>
            <CardDescription>Select a template and fill in the details</CardDescription>
          </CardHeader>
          <form onSubmit={handleSend}>
            <CardContent className="space-y-4">
              {error && (
                <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md flex items-center">
                  <AlertCircle className="w-4 h-4 mr-2" />
                  {error}
                </div>
              )}

              {success && (
                <div className="p-3 text-sm text-green-600 bg-green-50 rounded-md flex items-center">
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Message sent successfully!
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="number">From Number</Label>
                <select
                  id="number"
                  className="w-full h-10 px-3 border rounded-md bg-background text-sm"
                  value={formData.numberId}
                  onChange={(e) => setFormData({ ...formData, numberId: e.target.value })}
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
                    No verified numbers available.{" "}
                    <Link href="/dashboard/numbers/add" className="underline">Add one</Link>
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="recipient">Recipient Phone Number</Label>
                <Input
                  id="recipient"
                  type="tel"
                  placeholder="+91 98765 43210"
                  value={formData.recipient}
                  onChange={(e) => setFormData({ ...formData, recipient: e.target.value })}
                  required
                />
              </div>

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
                    <Link href="/dashboard/templates/new" className="underline">Create one</Link>
                  </p>
                )}
              </div>

              {templateVariables.length > 0 && (
                <div className="space-y-3 pt-2">
                  <Label>Template Variables</Label>
                  {templateVariables.map((varNum) => (
                    <div key={varNum}>
                      <Label className="text-xs text-muted-foreground">Variable {"{{" + varNum + "}}"}</Label>
                      <Input
                        placeholder={"Enter value for {{" + varNum + "}}"}
                        value={variables[varNum] || ""}
                        onChange={(e) => setVariables({ ...variables, [varNum]: e.target.value })}
                        className="mt-1"
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-4">
                <Button type="submit" className="w-full" disabled={sending}>
                  {sending ? (
                    <>Sending...</>
                  ) : (
                    <>
                      <Send className="w-4 h-4 mr-2" />
                      Send Message
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </form>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>How your message will look</CardDescription>
          </CardHeader>
          <CardContent>
            {selectedTemplate ? (
              <div className="space-y-4">
                {selectedTemplate.headerType && selectedTemplate.headerType !== "none" && (
                  <div className="p-3 bg-gray-100 rounded-lg">
                    <p className="text-sm text-muted-foreground mb-1">Header</p>
                    <p className="font-medium">{selectedTemplate.headerType === "text" ? "Text Header" : "Media"}</p>
                  </div>
                )}

                <div className="p-4 bg-[#DCF8C6] rounded-lg">
                  <div className="flex items-start space-x-3">
                    <div className="w-10 h-10 bg-[#25D366] rounded-full flex items-center justify-center flex-shrink-0">
                      <MessageSquare className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm whitespace-pre-wrap">{previewBody || selectedTemplate.body}</p>
                    </div>
                  </div>
                </div>

                {selectedTemplate.footerContent && (
                  <p className="text-xs text-muted-foreground text-center">
                    {selectedTemplate.footerContent}
                  </p>
                )}

                <div className="border-t pt-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Cost:</span>
                    <Badge variant="secondary">1 Credit</Badge>
                  </div>
                  {credits && (
                    <div className="flex items-center justify-between text-sm mt-2">
                      <span className="text-muted-foreground">Your Balance:</span>
                      <span className={credits.totalCredits > 0 ? "text-green-600" : "text-red-600"}>
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
      </div>
    </div>
  );
}
