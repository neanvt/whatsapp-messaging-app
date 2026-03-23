import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// POST - Send a free-text reply to a contact
// NOTE: WhatsApp only allows free-text messages within a 24-hour customer
// service window after the contact messages you first.
export async function POST(
  request: Request,
  { params }: { params: { contactPhone: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contactPhone = decodeURIComponent(params.contactPhone);
    const { message: messageText, whatsappNumberId } = await request.json();

    if (!messageText?.trim()) {
      return NextResponse.json(
        { error: "Message text is required" },
        { status: 400 },
      );
    }

    // Find the WhatsApp number to send from
    const waNumber = whatsappNumberId
      ? await prisma.whatsAppNumber.findFirst({
          where: { id: whatsappNumberId, userId: session.user.id },
        })
      : await prisma.whatsAppNumber.findFirst({
          where: {
            userId: session.user.id,
            verificationStatus: "verified",
          },
        });

    if (!waNumber) {
      return NextResponse.json(
        { error: "No verified WhatsApp number found" },
        { status: 400 },
      );
    }

    // Find or create the conversation
    const conversation = await prisma.conversation.upsert({
      where: {
        whatsappNumberId_contactPhone: {
          whatsappNumberId: waNumber.id,
          contactPhone,
        },
      },
      create: {
        userId: session.user.id,
        whatsappNumberId: waNumber.id,
        contactPhone,
        lastMessageAt: new Date(),
        lastMessagePreview: messageText.slice(0, 100),
        unreadCount: 0,
        updatedAt: new Date(),
      },
      update: {
        lastMessageAt: new Date(),
        lastMessagePreview: messageText.slice(0, 100),
        updatedAt: new Date(),
      },
    });

    // Send via Meta API
    const phoneNumberId =
      waNumber.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!phoneNumberId || !accessToken) {
      return NextResponse.json(
        { error: "Meta API credentials not configured" },
        { status: 500 },
      );
    }

    const recipientDigits = contactPhone.replace(/\D/g, "");

    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipientDigits,
          type: "text",
          text: { body: messageText.trim() },
        }),
      },
    );

    const metaData = await metaRes.json();

    let metaMessageId: string | null = null;
    let status = "sent";
    let errorMessage: string | null = null;

    if (!metaRes.ok || metaData.error) {
      status = "failed";
      errorMessage =
        metaData.error?.message ?? `Meta API error ${metaRes.status}`;
      console.error("[Chat Send] Meta API error:", metaData.error);
    } else {
      metaMessageId = metaData.messages?.[0]?.id ?? null;
    }

    // Store the message in DB
    const msg = await prisma.message.create({
      data: {
        userId: session.user.id,
        whatsappNumberId: waNumber.id,
        recipientPhone: contactPhone,
        content: messageText.trim(),
        direction: "outbound",
        metaMessageId,
        status,
        errorMessage,
        conversationId: conversation.id,
        sentAt: status === "sent" ? new Date() : null,
      },
    });

    if (status === "failed") {
      return NextResponse.json(
        { error: errorMessage, message: msg },
        { status: 422 },
      );
    }

    return NextResponse.json({ message: msg, conversation });
  } catch (error) {
    console.error("[Chat Send] Error:", error);
    return NextResponse.json(
      { error: "Failed to send message" },
      { status: 500 },
    );
  }
}
