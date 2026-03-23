"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Send, RefreshCw, MessageCircle, Search } from "lucide-react";

interface Conversation {
  id: string;
  contactPhone: string;
  contactName: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null;
  unreadCount: number;
  whatsappNumber: { phoneNumber: string; phoneNumberId: string | null };
}

interface Message {
  id: string;
  direction: string;
  content: string | null;
  status: string;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  errorMessage: string | null;
  template: { name: string; category: string } | null;
  recipientPhone: string;
}

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return formatTime(iso);
  if (diff < 7 * 86400000)
    return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function MessageBubble({ msg }: { msg: Message }) {
  const isOutbound = msg.direction === "outbound";
  const text = msg.content ?? (msg.template ? `📋 ${msg.template.name}` : "");

  return (
    <div
      className={`flex ${isOutbound ? "justify-end" : "justify-start"} mb-1`}
    >
      <div
        className={`
          max-w-[70%] rounded-2xl px-4 py-2 text-sm shadow-sm
          ${
            isOutbound
              ? "bg-[#005C4B] text-white rounded-br-sm"
              : "bg-[#202C33] text-[#E9EDEF] rounded-bl-sm"
          }
        `}
      >
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          {text}
        </p>
        <div
          className={`flex items-center gap-1 mt-1 ${isOutbound ? "justify-end" : "justify-start"}`}
        >
          <span className="text-[10px] opacity-60">
            {formatTime(msg.sentAt ?? msg.createdAt)}
          </span>
          {isOutbound && (
            <span className="text-[10px] opacity-70">
              {msg.status === "read"
                ? "✓✓"
                : msg.status === "delivered"
                  ? "✓✓"
                  : msg.status === "sent"
                    ? "✓"
                    : msg.status === "failed"
                      ? "✗"
                      : "⏱"}
            </span>
          )}
        </div>
        {msg.status === "failed" && msg.errorMessage && (
          <p className="text-[10px] text-red-400 mt-1">{msg.errorMessage}</p>
        )}
      </div>
    </div>
  );
}

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center justify-center my-3">
      <span className="text-[11px] text-[#8696A0] bg-[#182229] px-3 py-1 rounded-full">
        {date}
      </span>
    </div>
  );
}

export default function ChatPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [inputText, setInputText] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newContact, setNewContact] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const contactParam = searchParams.get("contact");

  // Fetch conversations
  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) return;
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingConvs(false);
    }
  }, []);

  // Fetch messages for active conversation
  const fetchMessages = useCallback(async (phone: string, silent = false) => {
    if (!silent) setLoadingMsgs(true);
    try {
      const res = await fetch(
        `/api/chat/${encodeURIComponent(phone)}/messages`,
      );
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages ?? []);
      if (data.conversation) setActiveConversation(data.conversation);
    } catch {
      // ignore
    } finally {
      if (!silent) setLoadingMsgs(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Load messages when contact param changes
  useEffect(() => {
    if (!contactParam) return;
    fetchMessages(contactParam);
  }, [contactParam, fetchMessages]);

  // Set up polling for messages when a conversation is open
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!contactParam) return;

    pollRef.current = setInterval(() => {
      fetchMessages(contactParam, true);
      fetchConversations();
    }, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [contactParam, fetchMessages, fetchConversations]);

  // Scroll to bottom when messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const selectConversation = (conv: Conversation) => {
    router.push(
      `/dashboard/chat?contact=${encodeURIComponent(conv.contactPhone)}`,
    );
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || !contactParam || sending) return;

    setSending(true);
    setInputText("");

    // Optimistically add message
    const optimistic: Message = {
      id: `opt-${Date.now()}`,
      direction: "outbound",
      content: text,
      status: "queued",
      createdAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      deliveredAt: null,
      readAt: null,
      errorMessage: null,
      template: null,
      recipientPhone: contactParam,
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const res = await fetch(
        `/api/chat/${encodeURIComponent(contactParam)}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            whatsappNumberId: activeConversation?.whatsappNumber
              ? undefined
              : undefined,
          }),
        },
      );

      const data = await res.json();
      if (!res.ok && res.status !== 422) {
        // remove optimistic message on hard error
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        alert(data.error ?? "Failed to send message");
      } else {
        // Replace optimistic with actual message
        await fetchMessages(contactParam, true);
        await fetchConversations();
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const startNewChat = () => {
    const phone = newContact.trim().replace(/\D/g, "");
    if (!phone) return;
    setShowNewChat(false);
    setNewContact("");
    router.push(`/dashboard/chat?contact=${phone}`);
  };

  // Group messages with date separators
  const groupedMessages = () => {
    const result: Array<
      { type: "date"; label: string } | { type: "msg"; msg: Message }
    > = [];
    let lastDate = "";

    for (const msg of messages) {
      const d = new Date(msg.sentAt ?? msg.createdAt);
      const dateStr = d.toLocaleDateString([], {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      if (dateStr !== lastDate) {
        result.push({ type: "date", label: dateStr });
        lastDate = dateStr;
      }
      result.push({ type: "msg", msg });
    }

    return result;
  };

  const filteredConvs = conversations.filter(
    (c) =>
      c.contactPhone.includes(searchQuery) ||
      (c.contactName ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div className="flex h-[calc(100vh-0px)] bg-[#111B21] text-[#E9EDEF] overflow-hidden">
      {/* ============ LEFT PANEL — Conversation List ============ */}
      <div className="w-[340px] min-w-[280px] flex flex-col border-r border-[#2A3942]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#202C33]">
          <h2 className="font-semibold text-lg">Chats</h2>
          <button
            onClick={() => setShowNewChat(!showNewChat)}
            className="p-2 rounded-full hover:bg-[#2A3942] transition-colors"
            title="New chat"
          >
            <MessageCircle className="w-5 h-5 text-[#AEBAC1]" />
          </button>
        </div>

        {/* New chat input */}
        {showNewChat && (
          <div className="px-3 py-2 bg-[#182229] border-b border-[#2A3942]">
            <p className="text-xs text-[#8696A0] mb-2">
              Enter phone number (with country code, e.g. 917088970099)
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newContact}
                onChange={(e) => setNewContact(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startNewChat()}
                placeholder="917088970099"
                className="flex-1 bg-[#2A3942] border-0 rounded-lg px-3 py-2 text-sm text-[#E9EDEF] placeholder-[#8696A0] focus:outline-none focus:ring-1 focus:ring-[#00A884]"
              />
              <button
                onClick={startNewChat}
                className="px-3 py-2 bg-[#00A884] text-white rounded-lg text-sm font-medium hover:bg-[#02B98D] transition-colors"
              >
                Open
              </button>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="px-3 py-2 bg-[#111B21]">
          <div className="flex items-center gap-2 bg-[#202C33] rounded-lg px-3 py-2">
            <Search className="w-4 h-4 text-[#8696A0] flex-shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search or start new chat"
              className="bg-transparent text-sm text-[#E9EDEF] placeholder-[#8696A0] flex-1 focus:outline-none"
            />
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {loadingConvs ? (
            <div className="flex items-center justify-center h-32 text-[#8696A0] text-sm">
              Loading chats…
            </div>
          ) : filteredConvs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-[#8696A0] text-sm px-4 text-center">
              <MessageCircle className="w-10 h-10 mb-3 opacity-40" />
              <p>No conversations yet.</p>
              <p className="mt-1 text-xs">
                Click the icon above to start a new chat or wait for an inbound
                message.
              </p>
            </div>
          ) : (
            filteredConvs.map((conv) => {
              const isActive = contactParam === conv.contactPhone;
              return (
                <button
                  key={conv.id}
                  onClick={() => selectConversation(conv)}
                  className={`
                    w-full flex items-center gap-3 px-4 py-3 text-left transition-colors border-b border-[#2A3942]/50
                    ${isActive ? "bg-[#2A3942]" : "hover:bg-[#182229]"}
                  `}
                >
                  {/* Avatar */}
                  <div className="w-11 h-11 rounded-full bg-[#6B7C85] flex items-center justify-center flex-shrink-0 text-white font-semibold text-base">
                    {(conv.contactName ?? conv.contactPhone)
                      .slice(0, 2)
                      .toUpperCase()}
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm truncate">
                        {conv.contactName ?? conv.contactPhone}
                      </span>
                      <span className="text-xs text-[#8696A0] flex-shrink-0 ml-2">
                        {formatDate(conv.lastMessageAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-0.5">
                      <p className="text-xs text-[#8696A0] truncate">
                        {conv.lastMessagePreview ?? "No messages yet"}
                      </p>
                      {conv.unreadCount > 0 && (
                        <span className="ml-2 flex-shrink-0 bg-[#00A884] text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                          {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ============ RIGHT PANEL — Chat Thread ============ */}
      {!contactParam ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-[#222E35] text-center p-8">
          <div className="w-24 h-24 rounded-full bg-[#202C33] flex items-center justify-center mb-6">
            <MessageCircle className="w-12 h-12 text-[#00A884]" />
          </div>
          <h3 className="text-2xl font-light text-[#E9EDEF] mb-2">
            WhatsApp Business Chat
          </h3>
          <p className="text-[#8696A0] text-sm max-w-xs">
            Select a conversation from the left or start a new chat by clicking
            the icon above.
          </p>
          <p className="text-[#8696A0] text-xs mt-4 max-w-xs">
            Note: Free-text replies are only allowed within 24 hours of
            receiving a message from the contact (customer service window).
          </p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col bg-[#0C1317] min-w-0">
          {/* Chat header */}
          <div className="flex items-center gap-3 px-4 py-3 bg-[#202C33] border-b border-[#2A3942]">
            <div className="w-10 h-10 rounded-full bg-[#6B7C85] flex items-center justify-center flex-shrink-0 text-white font-semibold">
              {(activeConversation?.contactName ?? contactParam)
                .slice(0, 2)
                .toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-[#E9EDEF]">
                {activeConversation?.contactName ?? contactParam}
              </p>
              <p className="text-xs text-[#8696A0]">
                {activeConversation?.whatsappNumber?.phoneNumber ??
                  "WhatsApp Business"}
              </p>
            </div>
            <button
              onClick={() => fetchMessages(contactParam)}
              className="p-2 rounded-full hover:bg-[#2A3942] transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4 text-[#8696A0]" />
            </button>
          </div>

          {/* Messages area */}
          <div
            className="flex-1 overflow-y-auto px-4 py-4"
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml,%3Csvg width='300' height='300' xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='300' height='300' fill='%230C1317'/%3E%3C/svg%3E\")",
            }}
          >
            {loadingMsgs ? (
              <div className="flex items-center justify-center h-32 text-[#8696A0] text-sm">
                Loading messages…
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-center">
                <p className="text-[#8696A0] text-sm">
                  No messages yet with{" "}
                  <span className="text-[#E9EDEF]">{contactParam}</span>
                </p>
                <p className="text-[#8696A0] text-xs mt-2">
                  Type a message below to start the conversation.
                </p>
              </div>
            ) : (
              groupedMessages().map((item, i) =>
                item.type === "date" ? (
                  <DateSeparator key={`date-${i}`} date={item.label} />
                ) : (
                  <MessageBubble key={item.msg.id} msg={item.msg} />
                ),
              )
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input bar */}
          <div className="flex items-end gap-2 px-4 py-3 bg-[#202C33] border-t border-[#2A3942]">
            <div className="flex-1 bg-[#2A3942] rounded-2xl px-4 py-2">
              <textarea
                ref={inputRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message"
                rows={1}
                className="w-full bg-transparent text-sm text-[#E9EDEF] placeholder-[#8696A0] resize-none focus:outline-none leading-relaxed"
                style={{ maxHeight: "120px" }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
                }}
              />
            </div>
            <button
              onClick={sendMessage}
              disabled={!inputText.trim() || sending}
              className={`
                w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-colors
                ${
                  inputText.trim() && !sending
                    ? "bg-[#00A884] hover:bg-[#02B98D] text-white"
                    : "bg-[#2A3942] text-[#8696A0] cursor-not-allowed"
                }
              `}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>

          {/* 24h window notice */}
          <div className="px-4 pb-2 bg-[#202C33]">
            <p className="text-[10px] text-[#8696A0] text-center">
              Free-text replies allowed within 24h of receiving a message ·
              Press Enter to send, Shift+Enter for new line
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
