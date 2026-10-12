import { NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/crypto";

// GET - Webhook verification challenge from Meta
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    console.log("[Webhook] Verification successful");
    return new Response(challenge, { status: 200 });
  }

  console.warn("[Webhook] Verification failed — token mismatch or wrong mode");
  return new Response("Forbidden", { status: 403 });
}

// Legit Meta payloads carry exactly one phone_number_id per change; the cap
// bounds the candidate lookup so an oversized crafted body cannot inflate it.
const MAX_CANDIDATE_PHONE_IDS = 10;

// POST - Receive status updates and inbound messages from Meta
export async function POST(request: Request) {
  // --- Verify the payload authenticity (X-Hub-Signature-256) BEFORE parsing ---
  // (1) Read the raw body exactly once so the HMAC is computed over the exact
  // bytes Meta signed; the body stream can only be read once.
  const raw = await request.text();

  // (2) Signature-header gate FIRST — before any JSON.parse or DB query. A
  // request without a well-formed signature header never costs a DB round-trip.
  const signatureHeader = request.headers.get("x-hub-signature-256");
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    console.warn("[Webhook] Missing or malformed X-Hub-Signature-256");
    return new Response("Unauthorized", { status: 401 });
  }
  const theirHex = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(theirHex, "hex");

  // (3) Parse the raw body for routing ONLY — to collect candidate
  // phone_number_ids (capped). This value is untrusted and grants no trust
  // until a signature matches below.
  let parsedPhoneIds: string[] = [];
  try {
    const peek = JSON.parse(raw);
    const ids = new Set<string>();
    outer: for (const entry of peek?.entry ?? [])
      for (const change of entry?.changes ?? []) {
        const id = change?.value?.metadata?.phone_number_id;
        if (typeof id === "string" && id) {
          ids.add(id);
          if (ids.size >= MAX_CANDIDATE_PHONE_IDS) break outer;
        }
      }
    parsedPhoneIds = [...ids];
  } catch {
    parsedPhoneIds = []; // unparseable body → platform secret only
  }

  // (4) Build the bounded candidate-secret set: the platform secret (if set)
  // plus the decrypted secret of each tenant that owns one of the capped ids.
  const secrets = new Set<string>();
  if (process.env.META_APP_SECRET) secrets.add(process.env.META_APP_SECRET);
  if (parsedPhoneIds.length) {
    const numbers = await prisma.whatsAppNumber.findMany({
      where: { phoneNumberId: { in: parsedPhoneIds } },
      select: { userId: true },
    });
    const userIds = [...new Set(numbers.map((n) => n.userId))];
    if (userIds.length) {
      const apps = await prisma.tenantMetaApp.findMany({
        where: { userId: { in: userIds } },
        select: { metaAppSecret: true },
      });
      for (const app of apps) {
        try {
          secrets.add(decrypt(app.metaAppSecret));
        } catch {
          /* undecryptable candidate: skip, never log, never crash */
        }
      }
    }
  }

  // (5) Fail closed if no candidate secret is available at all.
  if (secrets.size === 0) {
    console.error("[Webhook] No usable app secret — rejecting payload");
    return new Response("Unauthorized", { status: 401 });
  }

  // (6) Constant-time compare against each candidate; accept iff one validates.
  let verified = false;
  for (const secret of secrets) {
    const ourHex = crypto
      .createHmac("sha256", secret)
      .update(raw, "utf8")
      .digest("hex");
    const b = Buffer.from(ourHex, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      verified = true;
      break;
    }
  }
  if (!verified) {
    console.warn("[Webhook] Signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

  // (7) Process exactly as today.
  try {
    const body = JSON.parse(raw);

    // Meta sends a top-level object with an "entry" array
    const entries = body?.entry ?? [];

    for (const entry of entries) {
      const changes = entry?.changes ?? [];

      for (const change of changes) {
        const value = change?.value;
        if (!value) continue;

        // --- Status updates (sent → delivered → read / failed) ---
        const statuses: Array<{
          id: string;
          status: string;
          timestamp: string;
          errors?: Array<{ message: string }>;
        }> = value.statuses ?? [];

        for (const s of statuses) {
          const wamid = s.id;
          const newStatus = s.status; // "sent" | "delivered" | "read" | "failed"
          const ts = new Date(parseInt(s.timestamp) * 1000);

          const updateData: Record<string, unknown> = { status: newStatus };

          if (newStatus === "delivered") {
            updateData.deliveredAt = ts;
          } else if (newStatus === "read") {
            updateData.readAt = ts;
          } else if (newStatus === "failed") {
            updateData.errorMessage =
              s.errors?.[0]?.message ?? "Delivery failed";
          }

          await prisma.message.updateMany({
            where: { metaMessageId: wamid },
            data: updateData,
          });

          console.log(
            `[Webhook] Status update — wamid: ${wamid}, status: ${newStatus}`,
          );
        }

        // --- Inbound messages — store in DB and upsert conversation ---
        const metaPhoneNumberId: string | undefined =
          value.metadata?.phone_number_id;

        const inboundMessages: Array<{
          from: string;
          type: string;
          id: string;
          timestamp: string;
          text?: { body: string };
          image?: { id: string; caption?: string };
          document?: { id: string; filename?: string };
          audio?: { id: string };
          video?: { id: string };
        }> = value.messages ?? [];

        for (const msg of inboundMessages) {
          console.log(
            `[Webhook] Inbound message from ${msg.from}, type: ${msg.type}, id: ${msg.id}`,
          );

          // Resolve text content from message
          let textContent: string;
          if (msg.type === "text" && msg.text?.body) {
            textContent = msg.text.body;
          } else if (msg.type === "image") {
            textContent = msg.image?.caption ?? "📷 Image";
          } else if (msg.type === "document") {
            textContent = `📄 ${msg.document?.filename ?? "Document"}`;
          } else if (msg.type === "audio") {
            textContent = "🎵 Audio";
          } else if (msg.type === "video") {
            textContent = msg.video ? "🎥 Video" : "🎥 Video";
          } else {
            textContent = `[${msg.type}]`;
          }

          // Resolve the owning number STRICTLY by the inbound phone_number_id.
          // No env fallback, no "any verified number" fallback — a payload for a
          // tenant's phone_number_id may only ever write under that tenant.
          const resolvedNumber = metaPhoneNumberId
            ? await prisma.whatsAppNumber.findFirst({
                where: { phoneNumberId: metaPhoneNumberId },
              })
            : null;

          if (!resolvedNumber) {
            console.log(
              `[Webhook] No WhatsApp number matches phone_number_id ${metaPhoneNumberId ?? "(none)"} — skipping inbound msg from ${msg.from}`,
            );
            continue;
          }

          console.log(
            `[Webhook] Resolved number: ${resolvedNumber.phoneNumber} (id: ${resolvedNumber.id})`,
          );

          const ts = new Date(parseInt(msg.timestamp) * 1000);

          // Upsert the conversation
          const conversation = await prisma.conversation.upsert({
            where: {
              whatsappNumberId_contactPhone: {
                whatsappNumberId: resolvedNumber.id,
                contactPhone: msg.from,
              },
            },
            create: {
              userId: resolvedNumber.userId,
              whatsappNumberId: resolvedNumber.id,
              contactPhone: msg.from,
              lastMessageAt: ts,
              lastMessagePreview: textContent.slice(0, 100),
              unreadCount: 1,
              updatedAt: new Date(),
            },
            update: {
              lastMessageAt: ts,
              lastMessagePreview: textContent.slice(0, 100),
              unreadCount: { increment: 1 },
              updatedAt: new Date(),
            },
          });

          // Create inbound message record
          await prisma.message.create({
            data: {
              userId: resolvedNumber.userId,
              whatsappNumberId: resolvedNumber.id,
              recipientPhone: msg.from,
              metaMessageId: msg.id,
              content: textContent,
              direction: "inbound",
              status: "received",
              conversationId: conversation.id,
              sentAt: ts,
            },
          });
        }
      }
    }

    // Always return 200 so Meta doesn't retry
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Webhook] Error processing payload:", error);
    // Still return 200 — returning 5xx causes Meta to retry indefinitely
    return NextResponse.json({ ok: true });
  }
}
