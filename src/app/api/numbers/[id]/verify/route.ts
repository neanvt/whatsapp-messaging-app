import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// POST - Initiate verification for a WhatsApp number
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const number = await prisma.whatsAppNumber.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!number) {
      return NextResponse.json({ error: "Number not found" }, { status: 404 });
    }

    // Generate a random 6-digit code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Update the number with verification code and status
    await prisma.whatsAppNumber.update({
      where: { id: params.id },
      data: {
        verificationCode,
        verificationStatus: "in_progress",
      },
    });

    // In production, this would send an SMS or WhatsApp message with the code
    // For now, we'll log it (in development)
    console.log(`Verification code for ${number.phoneNumber}: ${verificationCode}`);

    return NextResponse.json({
      message: "Verification code sent",
      // Remove this in production - only for testing
      code: verificationCode,
    });
  } catch (error) {
    console.error("Error initiating verification:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
