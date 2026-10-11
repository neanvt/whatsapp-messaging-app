import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { serializeNumber } from "@/lib/whatsapp";

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

    return NextResponse.json(numbers.map((n) => serializeNumber(n)));
  } catch (error) {
    console.error("Error fetching numbers:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST - Deprecated. A bare phone number can no longer mint a usable/verified
// number; connect through Embedded Signup or the manual-credentials path.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      error:
        "Registering a bare phone number is no longer supported. Connect your number via Embedded Signup (POST /api/numbers/embedded-signup) or manual credentials (POST /api/numbers/manual).",
    },
    { status: 400 }
  );
}
