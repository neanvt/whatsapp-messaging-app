import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// GET - List user's templates
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const templates = await prisma.template.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(templates);
  } catch (error) {
    console.error("Error fetching templates:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// POST - Create a new template
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      status,
    } = body;

    if (!name || !category || !templateBody) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Validate template name format
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      return NextResponse.json(
        {
          error:
            "Template name must start with letter and contain only lowercase letters, numbers, and underscores",
        },
        { status: 400 },
      );
    }

    // Check for duplicate name
    const existing = await prisma.template.findFirst({
      where: { userId: session.user.id, name },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Template name already exists" },
        { status: 400 },
      );
    }

    const template = await prisma.template.create({
      data: {
        userId: session.user.id,
        name,
        category,
        language: language || "en",
        body: templateBody,
        headerType: headerType || null,
        headerContent: headerContent || null,
        footerContent: footerContent || null,
        buttons: buttons || null,
        mediaAttachments: mediaAttachments || null,
        status: status || "draft",
        submittedAt: status === "submitted" ? new Date() : null,
      },
    });

    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    console.error("Error creating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
