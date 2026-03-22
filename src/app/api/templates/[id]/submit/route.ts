import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// Build Meta API components array from template fields
function buildComponents(template: {
  body: string;
  headerType?: string | null;
  headerContent?: string | null;
  footerContent?: string | null;
  buttons?: string | null;
}) {
  const components: object[] = [];

  if (
    template.headerType &&
    template.headerType !== "none" &&
    template.headerContent
  ) {
    components.push({
      type: "HEADER",
      format: template.headerType.toUpperCase(),
      text: template.headerContent,
    });
  }

  components.push({ type: "BODY", text: template.body });

  if (template.footerContent) {
    components.push({ type: "FOOTER", text: template.footerContent });
  }

  if (template.buttons) {
    try {
      const buttons = JSON.parse(template.buttons);
      if (Array.isArray(buttons) && buttons.length > 0) {
        components.push({ type: "BUTTONS", buttons });
      }
    } catch {
      // ignore invalid buttons JSON
    }
  }

  return components;
}

// POST - Submit template for Meta approval
export async function POST(
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

    if (template.status !== "draft") {
      return NextResponse.json(
        { error: "Only draft templates can be submitted" },
        { status: 400 },
      );
    }

    const wabaId = process.env.META_WABA_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!wabaId || !accessToken) {
      return NextResponse.json(
        { error: "Meta API credentials not configured" },
        { status: 500 },
      );
    }

    // Call Meta Graph API to create the template
    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: template.name,
          language: template.language ?? "en",
          category: template.category.toUpperCase(),
          components: buildComponents(template),
        }),
      },
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error("Meta API error:", metaData);
      return NextResponse.json(
        {
          error: metaData.error?.message || "Failed to submit template to Meta",
        },
        { status: 400 },
      );
    }

    // Update template status and store Meta's template ID
    const updated = await prisma.template.update({
      where: { id: params.id },
      data: {
        status: "submitted",
        metaTemplateId: metaData.id ?? null,
        submittedAt: new Date(),
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error submitting template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
