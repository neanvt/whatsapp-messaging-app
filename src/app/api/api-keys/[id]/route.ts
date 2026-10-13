import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// DELETE - Revoke an API key by setting revokedAt. Session-guarded and scoped to
// session.user.id so another user's key is never revocable (returns 404, AC14).
// Idempotent: re-revoking a revoked key is a 200 no-op (AC13).
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const existing = await prisma.apiKey.findFirst({
      where: { id: params.id, userId: session.user.id },
    });
    if (!existing) {
      // Another user's key, or absent -> 404 (no cross-user revoke, no oracle).
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (existing.revokedAt) {
      // Idempotent: already revoked.
      return NextResponse.json({ id: existing.id, revoked: true });
    }

    await prisma.apiKey.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });

    return NextResponse.json({ id: existing.id, revoked: true });
  } catch (error) {
    console.error("Error revoking API key:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
