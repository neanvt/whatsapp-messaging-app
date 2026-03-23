import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - List all conversations for the current user
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const conversations = await prisma.conversation.findMany({
      where: { userId: session.user.id },
      orderBy: { lastMessageAt: "desc" },
      include: {
        whatsappNumber: {
          select: { phoneNumber: true, phoneNumberId: true },
        },
      },
    });

    return NextResponse.json({ conversations });
  } catch (error) {
    console.error("[Chat API] Error fetching conversations:", error);
    return NextResponse.json(
      { error: "Failed to fetch conversations" },
      { status: 500 },
    );
  }
}
