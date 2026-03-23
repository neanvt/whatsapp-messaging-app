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
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
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
      return NextResponse.json(
        { error: "Invalid or unverified WhatsApp number" },
        { status: 400 },
      );
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
      return NextResponse.json(
        { error: "Template not found or not approved" },
        { status: 400 },
      );
    }

    // Check user credits
    const userCredits = await prisma.userCredits.findUnique({
      where: { userId: session.user.id },
    });

    if (!userCredits || userCredits.totalCredits <= 0) {
      return NextResponse.json(
        { error: "Insufficient credits" },
        { status: 400 },
      );
    }

    // Create message record
    const message = await prisma.message.create({
      data: {
        userId: session.user.id,
        whatsappNumberId: numberId,
        templateId: templateId,
        recipientPhone: recipient,
        templateVariables: variables?.length ? JSON.stringify(variables) : null,
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

    // Resolve phone number ID — stored on number record, or fallback to env
    const phoneNumberId =
      number.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    let metaMessageId: string | null = null;
    let finalStatus = "sent";
    let errorMessage: string | null = null;

    if (!phoneNumberId || !accessToken) {
      console.warn(
        "[Meta] META_PHONE_NUMBER_ID or META_ACCESS_TOKEN not set — message saved but not sent to Meta",
      );
      finalStatus = "failed";
      errorMessage = "META_PHONE_NUMBER_ID not configured";
    } else {
      // Build template components for variables (if any)
      const components: object[] = [];
      const vars: string[] = variables?.length ? variables : [];
      if (vars.length > 0) {
        components.push({
          type: "body",
          parameters: vars.map((v: string) => ({ type: "text", text: v })),
        });
      }

      const metaPayload = {
        messaging_product: "whatsapp",
        to: recipient.replace(/\D/g, ""), // strip non-digits
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language ?? "en" },
          ...(components.length > 0 ? { components } : {}),
        },
      };

      console.log(
        "[Meta] Sending message:",
        JSON.stringify(metaPayload, null, 2),
      );

      const metaRes = await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(metaPayload),
        },
      );

      const metaData = await metaRes.json();

      if (!metaRes.ok) {
        console.error("[Meta] Send error:", metaData);
        finalStatus = "failed";
        errorMessage = metaData.error?.message ?? "Failed to send via Meta API";
      } else {
        metaMessageId = metaData.messages?.[0]?.id ?? null;
        console.log("[Meta] Message sent, id:", metaMessageId);
      }
    }

    // Update message record with result
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: finalStatus,
        sentAt: finalStatus === "sent" ? new Date() : undefined,
        metaMessageId,
        errorMessage,
      },
    });

    if (finalStatus === "failed") {
      // Refund the credit since send failed
      await prisma.userCredits.update({
        where: { userId: session.user.id },
        data: {
          totalCredits: { increment: 1 },
          usedCredits: { decrement: 1 },
        },
      });
      return NextResponse.json(
        { error: errorMessage ?? "Failed to send message" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      id: message.id,
      status: "sent",
      message: "Message sent successfully",
    });
  } catch (error) {
    console.error("Error sending message:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
