"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  MessageSquare,
  RefreshCw,
  Send,
  Search,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import Link from "next/link";
import { resolveBodyPreview } from "@/lib/template-params";

interface Message {
  id: string;
  recipientPhone: string;
  status: string;
  direction: string;
  templateVariables: string | null;
  errorMessage: string | null;
  content: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  createdAt: string;
  template: { name: string; body: string | null } | null;
  whatsappNumber: { phoneNumber: string } | null;
}

// Parse the stored templateVariables JSON string defensively — never throw.
function safeParse(
  value: string | null,
): string[] | Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as string[];
    if (parsed && typeof parsed === "object")
      return parsed as Record<string, string>;
    return null;
  } catch {
    return null;
  }
}

export default function MessagesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetchMessages();
    // Auto-refresh every 10 seconds to pick up webhook delivery status updates
    const interval = setInterval(() => fetchMessages(true), 10000);
    return () => clearInterval(interval);
  }, []);

  const fetchMessages = async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const res = await fetch("/api/messages");
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
        setLastUpdated(new Date());
      }
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "delivered":
        return <Badge variant="success">Delivered</Badge>;
      case "read":
        return <Badge variant="default">Read</Badge>;
      case "sent":
        return <Badge variant="secondary">Sent</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "received":
        return <Badge variant="warning">Received</Badge>;
      case "queued":
      default:
        return <Badge variant="outline">Queued</Badge>;
    }
  };

  const filteredMessages = messages.filter(
    (m) =>
      m.recipientPhone.includes(search) ||
      m.template?.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div>
      <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Message History</h1>
          <p className="text-muted-foreground">
            View all sent messages and their status
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchMessages()}
            disabled={loading || refreshing}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
            />
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString()}`
              : "Refresh"}
          </Button>
          <Button asChild>
            <Link href="/dashboard/messages/send">
              <Send className="w-4 h-4 mr-2" />
              Send New Message
            </Link>
          </Button>
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by phone number or template..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : filteredMessages.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <MessageSquare className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              {search ? "No Messages Found" : "No Messages Yet"}
            </h3>
            <p className="text-muted-foreground text-center mb-4">
              {search
                ? "Try adjusting your search"
                : "Start by sending your first WhatsApp message."}
            </p>
            {!search && (
              <Button asChild>
                <Link href="/dashboard/messages/send">
                  Send Your First Message
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="w-10 px-2 py-3" aria-label="Expand" />
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                    Recipient
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                    Template
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                    From
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                    Sent
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredMessages.map((message) => {
                  const expanded = expandedId === message.id;
                  const vars = safeParse(message.templateVariables);
                  const varEntries = Array.isArray(vars)
                    ? vars.map((v, i) => [String(i + 1), v] as const)
                    : vars
                      ? Object.entries(vars)
                      : [];
                  const preview = resolveBodyPreview(
                    message.template?.body,
                    message.templateVariables,
                  );
                  return (
                    <React.Fragment key={message.id}>
                      <tr
                        className="border-b cursor-pointer hover:bg-gray-50"
                        onClick={() =>
                          setExpandedId(expanded ? null : message.id)
                        }
                      >
                        <td className="px-2 py-3 text-muted-foreground">
                          {expanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {message.recipientPhone}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {message.template?.name || "N/A"}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {message.whatsappNumber?.phoneNumber || "N/A"}
                        </td>
                        <td className="px-4 py-3">
                          {getStatusBadge(message.status)}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground">
                          {message.deliveredAt
                            ? `Delivered ${new Date(message.deliveredAt).toLocaleString()}`
                            : message.readAt
                              ? `Read ${new Date(message.readAt).toLocaleString()}`
                              : message.sentAt
                                ? new Date(message.sentAt).toLocaleString()
                                : "-"}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b bg-gray-50/60">
                          <td colSpan={6} className="px-4 py-4">
                            <div className="rounded-md bg-muted/40 p-4 space-y-3 text-sm">
                              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                                <div>
                                  <span className="font-medium">Template: </span>
                                  {message.template?.name ?? "Free-text / inbound"}
                                </div>
                                <div>
                                  <span className="font-medium">
                                    Direction:{" "}
                                  </span>
                                  {message.direction}
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">Status:</span>
                                  {getStatusBadge(message.status)}
                                </div>
                                <div>
                                  <span className="font-medium">Sent: </span>
                                  {message.sentAt
                                    ? new Date(message.sentAt).toLocaleString()
                                    : "-"}
                                </div>
                                <div>
                                  <span className="font-medium">
                                    Delivered:{" "}
                                  </span>
                                  {message.deliveredAt
                                    ? new Date(
                                        message.deliveredAt,
                                      ).toLocaleString()
                                    : "-"}
                                </div>
                                <div>
                                  <span className="font-medium">Read: </span>
                                  {message.readAt
                                    ? new Date(message.readAt).toLocaleString()
                                    : "-"}
                                </div>
                              </div>

                              {message.errorMessage && (
                                <div className="text-destructive">
                                  <span className="font-medium">Error: </span>
                                  {message.errorMessage}
                                </div>
                              )}

                              {varEntries.length > 0 && (
                                <div>
                                  <div className="font-medium mb-1">
                                    Variables
                                  </div>
                                  <ul className="space-y-0.5">
                                    {varEntries.map(([k, v]) => (
                                      <li key={k} className="font-mono text-xs">
                                        {k}: {String(v)}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {message.template ? (
                                preview && (
                                  <div>
                                    <div className="font-medium mb-1">
                                      Resolved body preview
                                    </div>
                                    <pre className="whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
                                      {preview}
                                    </pre>
                                  </div>
                                )
                              ) : (
                                message.content && (
                                  <div>
                                    <div className="font-medium mb-1">
                                      Content
                                    </div>
                                    <pre className="whitespace-pre-wrap break-words rounded bg-background p-2 text-xs">
                                      {message.content}
                                    </pre>
                                  </div>
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
