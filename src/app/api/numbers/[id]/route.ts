import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - Get single number details
export async function GET(
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

    return NextResponse.json(number);
  } catch (error) {
    console.error("Error fetching number:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE - Remove a WhatsApp number
export async function DELETE(
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

    await prisma.whatsAppNumber.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ message: "Number deleted successfully" });
  } catch (error) {
    console.error("Error deleting number:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
