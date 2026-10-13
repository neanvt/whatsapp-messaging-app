import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { authenticateApiKey, unauthorized } from "@/lib/api-auth";

// GET - Public message status. API-key auth only; scoped to BOTH the owner and the
// key's bound number so a cross-tenant/cross-number id yields an identical 404 (no
// existence oracle). The path id is never logged on any branch.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await authenticateApiKey(request);
  if (!ctx) return unauthorized();

  const message = await prisma.message.findFirst({
    where: { id: params.id, userId: ctx.userId, whatsappNumberId: ctx.number.id },
    select: {
      id: true,
      status: true,
      recipientPhone: true,
      metaMessageId: true,
      errorMessage: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      createdAt: true,
    },
  });

  if (!message) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(message);
}
