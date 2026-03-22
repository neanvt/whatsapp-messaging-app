"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MessageSquare, RefreshCw, Send, Search } from "lucide-react";
import Link from "next/link";

interface Message {
  id: string;
  recipientPhone: string;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  template: { name: string } | null;
  whatsappNumber: { phoneNumber: string } | null;
  errorMessage: string | null;
}

export default function MessagesPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchMessages();
  }, []);

  const fetchMessages = async () => {
    try {
      const res = await fetch("/api/messages");
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "delivered":
        return <Badge variant="success">Delivered</Badge>;
      case "sent":
        return <Badge variant="secondary">Sent</Badge>;
      case "read":
        return <Badge variant="success">Read</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "queued":
      default:
        return <Badge variant="outline">Queued</Badge>;
    }
  };

  const filteredMessages = messages.filter(
    (m) =>
      m.recipientPhone.includes(search) ||
      m.template?.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Message History</h1>
          <p className="text-muted-foreground">View all sent messages and their status</p>
        </div>
        <Button asChild>
          <Link href="/dashboard/messages/send">
            <Send className="w-4 h-4 mr-2" />
            Send New Message
          </Link>
        </Button>
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
                <Link href="/dashboard/messages/send">Send Your First Message</Link>
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
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Recipient</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Template</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">From</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Sent</th>
                </tr>
              </thead>
              <tbody>
                {filteredMessages.map((message) => (
                  <tr key={message.id} className="border-b">
                    <td className="px-4 py-3 text-sm">{message.recipientPhone}</td>
                    <td className="px-4 py-3 text-sm">{message.template?.name || "N/A"}</td>
                    <td className="px-4 py-3 text-sm">{message.whatsappNumber?.phoneNumber || "N/A"}</td>
                    <td className="px-4 py-3">{getStatusBadge(message.status)}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {message.sentAt ? new Date(message.sentAt).toLocaleString() : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
