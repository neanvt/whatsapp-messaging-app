import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// POST - Submit template for Meta approval
export async function POST(
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
        { error: "Only draft templates can be submitted" },
        { status: 400 }
      );
    }

    // Update template status to submitted
    const updated = await prisma.template.update({
      where: { id: params.id },
      data: {
        status: "submitted",
        submittedAt: new Date(),
      },
    });

    // In production, this would also:
    // 1. Call Meta API to submit the template
    // 2. Store the metaTemplateId when approved

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error submitting template:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
