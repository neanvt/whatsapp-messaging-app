import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - Get single template
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const template = await prisma.template.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("Error fetching template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PUT - Update a template (draft only)
export async function PUT(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const template = await prisma.template.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    if (template.status !== "draft") {
      return NextResponse.json(
        { error: "Only draft templates can be edited" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { name, category, body: templateBody, headerType, headerContent, footerContent, buttons } = body;

    const updated = await prisma.template.update({
      where: { id: params.id },
      data: {
        name: name || template.name,
        category: category || template.category,
        body: templateBody || template.body,
        headerType: headerType !== undefined ? headerType : template.headerType,
        headerContent: headerContent !== undefined ? headerContent : template.headerContent,
        footerContent: footerContent !== undefined ? footerContent : template.footerContent,
        buttons: buttons !== undefined ? buttons : template.buttons,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE - Delete a template (draft only)
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const template = await prisma.template.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    if (template.status !== "draft") {
      return NextResponse.json(
        { error: "Only draft templates can be deleted" },
        { status: 400 }
      );
    }

    await prisma.template.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ message: "Template deleted successfully" });
  } catch (error) {
    console.error("Error deleting template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
