import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// POST - Confirm verification code
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { code } = body;

    if (!code) {
      return NextResponse.json({ error: "Verification code is required" }, { status: 400 });
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

    if (number.verificationStatus === "verified") {
      return NextResponse.json({ message: "Number already verified" });
    }

    if (number.verificationCode !== code) {
      return NextResponse.json({ error: "Invalid verification code" }, { status: 400 });
    }

    // Update verification status
    await prisma.whatsAppNumber.update({
      where: { id: params.id },
      data: {
        verificationStatus: "verified",
        verifiedAt: new Date(),
        verificationCode: null,
      },
    });

    return NextResponse.json({ message: "Number verified successfully" });
  } catch (error) {
    console.error("Error confirming verification:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
