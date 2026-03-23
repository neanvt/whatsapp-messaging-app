import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - Fetch all messages in a conversation with a specific contact
export async function GET(
  request: Request,
  { params }: { params: { contactPhone: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contactPhone = decodeURIComponent(params.contactPhone);

    // Find the conversation
    const conversation = await prisma.conversation.findFirst({
      where: {
        userId: session.user.id,
        contactPhone,
      },
      include: {
        whatsappNumber: {
          select: { phoneNumber: true, phoneNumberId: true },
        },
      },
    });

    if (!conversation) {
      return NextResponse.json({ messages: [], conversation: null });
    }

    // Reset unread count when fetching messages
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { unreadCount: 0 },
    });

    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
      include: {
        template: { select: { name: true, category: true } },
      },
    });

    return NextResponse.json({ messages, conversation });
  } catch (error) {
    console.error("[Chat API] Error fetching messages:", error);
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 },
    );
  }
}
