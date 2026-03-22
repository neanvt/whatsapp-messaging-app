import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - List user's WhatsApp numbers
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const numbers = await prisma.whatsAppNumber.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(numbers);
  } catch (error) {
    console.error("Error fetching numbers:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST - Register a new WhatsApp number
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { phoneNumber } = body;

    if (!phoneNumber) {
      return NextResponse.json({ error: "Phone number is required" }, { status: 400 });
    }

    // Check if number already exists
    const existing = await prisma.whatsAppNumber.findUnique({
      where: { phoneNumber },
    });

    if (existing) {
      return NextResponse.json({ error: "Number already registered" }, { status: 400 });
    }

    // Create the number record
    const number = await prisma.whatsAppNumber.create({
      data: {
        userId: session.user.id,
        phoneNumber,
        verificationStatus: "pending",
      },
    });

    return NextResponse.json(number, { status: 201 });
  } catch (error) {
    console.error("Error registering number:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
