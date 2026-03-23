import { NextResponse } from "next/server";
import prisma from "@/lib/db";

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

// POST - Receive status updates and inbound messages from Meta
export async function POST(request: Request) {
  try {
    const body = await request.json();

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

          // Find the WhatsApp number record by Meta phone number ID
          const waNumber = metaPhoneNumberId
            ? await prisma.whatsAppNumber.findFirst({
                where: { phoneNumberId: metaPhoneNumberId },
              })
            : null;

          // Fall back to env-configured phone number ID, then any verified number
          const envPhoneNumberId = process.env.META_PHONE_NUMBER_ID;
          const resolvedNumber =
            waNumber ??
            (envPhoneNumberId
              ? await prisma.whatsAppNumber.findFirst({
                  where: { phoneNumberId: envPhoneNumberId },
                })
              : null) ??
            (await prisma.whatsAppNumber.findFirst({
              where: { verificationStatus: "verified" },
            }));

          if (!resolvedNumber) {
            console.warn(
              `[Webhook] No WhatsApp number record found at all — skipping inbound msg from ${msg.from}`,
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
