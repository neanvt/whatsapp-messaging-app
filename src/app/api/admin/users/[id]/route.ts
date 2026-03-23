import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { isActive, role, addCredits } = body;

  // Prevent superadmin from demoting themselves
  if (params.id === session.user.id && role !== undefined) {
    return NextResponse.json(
      { error: "Cannot change your own role" },
      { status: 400 },
    );
  }

  const updateData: Record<string, unknown> = {};
  if (typeof isActive === "boolean") updateData.isActive = isActive;
  // Only allow setting role to "admin" (cannot grant superadmin via dashboard)
  if (role === "admin") updateData.role = role;

  const user = await prisma.user.update({
    where: { id: params.id },
    data: updateData,
    include: { credits: true },
  });

  // Add/deduct credits if requested
  if (typeof addCredits === "number" && addCredits !== 0) {
    await prisma.userCredits.upsert({
      where: { userId: params.id },
      update: {
        totalCredits: { increment: addCredits },
        lastRechargedAt: addCredits > 0 ? new Date() : undefined,
      },
      create: {
        userId: params.id,
        totalCredits: Math.max(0, addCredits),
        usedCredits: 0,
      },
    });
  }

  return NextResponse.json({ user });
}
