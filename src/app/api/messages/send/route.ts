import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// POST - Send a message
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { numberId, recipient, templateId, variables } = body;

    if (!numberId || !recipient || !templateId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Verify the number belongs to the user and is verified
    const number = await prisma.whatsAppNumber.findFirst({
      where: {
        id: numberId,
        userId: session.user.id,
        verificationStatus: "verified",
      },
    });

    if (!number) {
      return NextResponse.json({ error: "Invalid or unverified WhatsApp number" }, { status: 400 });
    }

    // Verify the template belongs to the user and is approved
    const template = await prisma.template.findFirst({
      where: {
        id: templateId,
        userId: session.user.id,
        status: "approved",
      },
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found or not approved" }, { status: 400 });
    }

    // Check user credits
    const userCredits = await prisma.userCredits.findUnique({
      where: { userId: session.user.id },
    });

    if (!userCredits || userCredits.totalCredits <= 0) {
      return NextResponse.json({ error: "Insufficient credits" }, { status: 400 });
    }

    // Create message record
    const message = await prisma.message.create({
      data: {
        userId: session.user.id,
        whatsappNumberId: numberId,
        templateId: templateId,
        recipientPhone: recipient,
        templateVariables: variables || [],
        status: "queued",
      },
    });

    // Deduct credit
    await prisma.userCredits.update({
      where: { userId: session.user.id },
      data: {
        totalCredits: { decrement: 1 },
        usedCredits: { increment: 1 },
      },
    });

    // In production, this would call Meta API to send the message
    // For now, we'll simulate a successful send
    console.log(`[MOCK] Sending message to ${recipient} using template ${template.name}`);
    console.log(`[MOCK] Variables: ${variables?.join(", ")}`);

    // Update message status to "sent"
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: "sent",
        sentAt: new Date(),
      },
    });

    return NextResponse.json({
      id: message.id,
      status: "sent",
      message: "Message sent successfully",
    });
  } catch (error) {
    console.error("Error sending message:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
