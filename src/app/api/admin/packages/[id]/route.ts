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
  const {
    name,
    credits,
    priceInr,
    pricePerMsg,
    isActive,
    isPopular,
    sortOrder,
  } = body;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (credits !== undefined) updateData.credits = parseInt(credits);
  if (priceInr !== undefined) {
    updateData.priceInr = parseInt(priceInr);
    updateData.priceInPaise = parseInt(priceInr) * 100;
  }
  if (pricePerMsg !== undefined)
    updateData.pricePerMsg = parseFloat(pricePerMsg);
  if (typeof isActive === "boolean") updateData.isActive = isActive;
  if (typeof isPopular === "boolean") updateData.isPopular = isPopular;
  if (sortOrder !== undefined) updateData.sortOrder = parseInt(sortOrder);

  const pkg = await prisma.package.update({
    where: { id: params.id },
    data: updateData,
  });

  return NextResponse.json(pkg);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.package.delete({ where: { id: params.id } });
  return NextResponse.json({ success: true });
}
