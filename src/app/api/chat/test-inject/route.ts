import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// POST - Manually inject an inbound message for testing
// Body: { from: "917088970099", text: "Hello there!" }
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Only allow in development
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "Not available in production" },
        { status: 403 },
      );
    }

    const { from, text } = await request.json();
    if (!from || !text) {
      return NextResponse.json(
        { error: "from and text are required" },
        { status: 400 },
      );
    }

    const waNumber = await prisma.whatsAppNumber.findFirst({
      where: { userId: session.user.id, verificationStatus: "verified" },
    });

    if (!waNumber) {
      return NextResponse.json(
        { error: "No verified WhatsApp number" },
        { status: 400 },
      );
    }

    const now = new Date();

    const conversation = await prisma.conversation.upsert({
      where: {
        whatsappNumberId_contactPhone: {
          whatsappNumberId: waNumber.id,
          contactPhone: from,
        },
      },
      create: {
        userId: session.user.id,
        whatsappNumberId: waNumber.id,
        contactPhone: from,
        lastMessageAt: now,
        lastMessagePreview: text.slice(0, 100),
        unreadCount: 1,
        updatedAt: now,
      },
      update: {
        lastMessageAt: now,
        lastMessagePreview: text.slice(0, 100),
        unreadCount: { increment: 1 },
        updatedAt: now,
      },
    });

    const message = await prisma.message.create({
      data: {
        userId: session.user.id,
        whatsappNumberId: waNumber.id,
        recipientPhone: from,
        content: text,
        direction: "inbound",
        status: "received",
        conversationId: conversation.id,
        sentAt: now,
      },
    });

    return NextResponse.json({ ok: true, message, conversation });
  } catch (error) {
    console.error("[Test Inject] Error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
