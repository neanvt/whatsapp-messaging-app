import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [
    totalUsers,
    activeUsers,
    totalMessages,
    totalRevenue,
    totalCreditsIssued,
    totalCreditsUsed,
    recentUsers,
    recentPayments,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isActive: true } }),
    prisma.message.count(),
    prisma.payment.aggregate({
      _sum: { amountInr: true },
      where: { status: "completed" },
    }),
    prisma.payment.aggregate({
      _sum: { creditsPurchased: true },
      where: { status: "completed" },
    }),
    prisma.userCredits.aggregate({ _sum: { usedCredits: true } }),
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        fullName: true,
        email: true,
        createdAt: true,
        isActive: true,
      },
    }),
    prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { user: { select: { fullName: true, email: true } } },
    }),
  ]);

  return NextResponse.json({
    totalUsers,
    activeUsers,
    totalMessages,
    totalRevenue: totalRevenue._sum.amountInr ?? 0,
    totalCreditsIssued: totalCreditsIssued._sum.creditsPurchased ?? 0,
    totalCreditsUsed: totalCreditsUsed._sum.usedCredits ?? 0,
    recentUsers,
    recentPayments,
  });
}
