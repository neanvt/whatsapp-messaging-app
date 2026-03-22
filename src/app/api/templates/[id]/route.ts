import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - Get single template
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
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
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(template);
  } catch (error) {
    console.error("Error fetching template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// PUT - Update a template (draft only)
export async function PUT(
  request: Request,
  { params }: { params: { id: string } },
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
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 },
      );
    }

    if (template.status !== "draft" && template.status !== "rejected") {
      return NextResponse.json(
        { error: "Only draft or rejected templates can be edited" },
        { status: 400 },
      );
    }

    const body = await request.json();
    const {
      name,
      category,
      language,
      body: templateBody,
      headerType,
      headerContent,
      footerContent,
      buttons,
      mediaAttachments,
    } = body;

    const updated = await prisma.template.update({
      where: { id: params.id },
      data: {
        name: name || template.name,
        category: category || template.category,
        language: language !== undefined ? language : template.language,
        body: templateBody || template.body,
        headerType: headerType !== undefined ? headerType : template.headerType,
        headerContent:
          headerContent !== undefined ? headerContent : template.headerContent,
        footerContent:
          footerContent !== undefined ? footerContent : template.footerContent,
        buttons: buttons !== undefined ? buttons : template.buttons,
        mediaAttachments:
          mediaAttachments !== undefined
            ? mediaAttachments
            : template.mediaAttachments,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// DELETE - Delete a template
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
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
      return NextResponse.json(
        { error: "Template not found" },
        { status: 404 },
      );
    }

    // If it was submitted to Meta, delete it there too
    if (
      template.metaTemplateId &&
      process.env.META_WABA_ID &&
      process.env.META_ACCESS_TOKEN
    ) {
      await fetch(
        `https://graph.facebook.com/v19.0/${process.env.META_WABA_ID}/message_templates?hsm_id=${template.metaTemplateId}&name=${template.name}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` },
        },
      ).catch((e) => console.warn("Meta delete warning:", e));
    }

    await prisma.template.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ message: "Template deleted successfully" });
  } catch (error) {
    console.error("Error deleting template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
