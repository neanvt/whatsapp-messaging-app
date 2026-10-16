import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// Valid Message.status values (schema: queued, sent, delivered, read, failed, received)
const VALID_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "received",
] as const;

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

// GET - List user's messages (paginated, with status filter, search, and counts)
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;
    const { searchParams } = new URL(request.url);

    const parsedPage = parseInt(searchParams.get("page") ?? "", 10);
    const page = Number.isNaN(parsedPage) ? 1 : Math.max(1, parsedPage);

    const parsedPageSize = parseInt(searchParams.get("pageSize") ?? "", 10);
    const pageSize = Number.isNaN(parsedPageSize)
      ? DEFAULT_PAGE_SIZE
      : Math.min(MAX_PAGE_SIZE, Math.max(1, parsedPageSize));

    const statusParam = searchParams.get("status");
    const status =
      statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
        ? statusParam
        : undefined;

    const searchParam = searchParams.get("search")?.trim();
    const search = searchParam ? searchParam : undefined;

    // SQLite `contains` is already case-insensitive for ASCII; no `mode` (connector rejects it).
    const searchFilter = search
      ? {
          OR: [
            { recipientPhone: { contains: search } },
            { template: { name: { contains: search } } },
          ],
        }
      : {};

    const statusFilter = status ? { status } : {};

    const [messages, total, grouped] = await Promise.all([
      prisma.message.findMany({
        where: { userId, ...searchFilter, ...statusFilter },
        select: {
          id: true,
          recipientPhone: true,
          status: true,
          direction: true,
          templateVariables: true,
          errorMessage: true,
          content: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          createdAt: true,
          template: { select: { name: true, body: true } },
          whatsappNumber: { select: { phoneNumber: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.message.count({
        where: { userId, ...searchFilter, ...statusFilter },
      }),
      prisma.message.groupBy({
        by: ["status"],
        where: { userId, ...searchFilter },
        _count: true,
      }),
    ]);

    const byStatus = grouped.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count;
      return acc;
    }, {});

    const countsTotal = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return NextResponse.json({
      messages,
      total,
      page,
      pageSize,
      totalPages,
      counts: { total: countsTotal, byStatus },
    });
  } catch (error) {
    console.error("Error fetching messages:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
