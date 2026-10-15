import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { sendTemplateMessage } from "@/lib/send-template";

// POST - Send a message (session/dashboard path). Thin wrapper over the shared
// sendTemplateMessage core; observable behavior is identical to the pre-refactor
// route except the internal 402 (insufficient credits) is remapped back to 400 so
// the dashboard keeps its legacy status code.
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const {
      numberId,
      recipient,
      templateId,
      variables,
      namedParams,
      mediaUrl,
      documentUrl,
      documentBase64,
      pdfBase64,
      mediaBase64,
      mediaId,
      fileName,
      filename,
      buttonParam,
      buttonUrlParam,
    } = body;

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

    const result = await sendTemplateMessage({
      userId: session.user.id,
      number,
      template,
      recipient,
      variables,
      namedParams,
      mediaUrl,
      documentUrl,
      documentBase64,
      pdfBase64,
      mediaBase64,
      mediaId,
      fileName,
      filename,
      buttonParam,
      buttonUrlParam,
      isSuperAdmin: session.user.role === "superadmin",
    });

    if (!result.ok) {
      // Preserve legacy observable codes for the dashboard: insufficient-credits was 400 here.
      const code = result.code === 402 ? 400 : result.code;
      return NextResponse.json({ error: result.error }, { status: code });
    }

    return NextResponse.json({
      id: result.message.id,
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
