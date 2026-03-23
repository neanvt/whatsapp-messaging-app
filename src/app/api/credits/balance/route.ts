import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - Get user's credit balance
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Superadmin always has unlimited credits
    if (session.user.role === "superadmin") {
      return NextResponse.json({
        totalCredits: 999999999,
        usedCredits: 0,
        availableCredits: 999999999,
        unlimited: true,
      });
    }

    let credits = await prisma.userCredits.findUnique({
      where: { userId: session.user.id },
    });

    // Create credits record if it doesn't exist
    if (!credits) {
      credits = await prisma.userCredits.create({
        data: {
          userId: session.user.id,
          totalCredits: 0,
          usedCredits: 0,
        },
      });
    }

    return NextResponse.json({
      totalCredits: credits.totalCredits,
      usedCredits: credits.usedCredits,
      availableCredits: credits.totalCredits - credits.usedCredits,
    });
  } catch (error) {
    console.error("Error fetching credits:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
