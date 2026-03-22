import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// POST - Duplicate a template as draft
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const original = await prisma.template.findFirst({
      where: { id: params.id, userId: session.user.id },
    });

    if (!original) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    // Generate a unique name for the copy
    const baseName = original.name.replace(/_copy(_\d+)?$/, "");
    const existing = await prisma.template.findMany({
      where: { userId: session.user.id, name: { startsWith: baseName } },
      select: { name: true },
    });
    const existingNames = new Set(existing.map((t) => t.name));
    let copyName = `${baseName}_copy`;
    let counter = 2;
    while (existingNames.has(copyName)) {
      copyName = `${baseName}_copy_${counter++}`;
    }

    const duplicate = await prisma.template.create({
      data: {
        userId: session.user.id,
        name: copyName,
        category: original.category,
        body: original.body,
        headerType: original.headerType,
        headerContent: original.headerContent,
        footerContent: original.footerContent,
        buttons: original.buttons,
        status: "draft",
      } as Parameters<typeof prisma.template.create>[0]["data"],
    });

    return NextResponse.json(duplicate, { status: 201 });
  } catch (error) {
    console.error("Error duplicating template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
