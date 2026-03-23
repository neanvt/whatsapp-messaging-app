import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// Build Meta API components array from template fields
function buildComponents(
  template: {
    body: string;
    headerType?: string | null;
    headerContent?: string | null;
    footerContent?: string | null;
    buttons?: string | null;
  },
  sampleValues?: string[],
) {
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

  const hasVariables = /\{\{\d+\}\}/.test(template.body);
  const bodyComponent: Record<string, unknown> = {
    type: "BODY",
    text: template.body,
  };
  if (hasVariables && sampleValues && sampleValues.length > 0) {
    bodyComponent.example = { body_text: [sampleValues] };
  }
  components.push(bodyComponent);

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

    if (template.status !== "draft" && template.status !== "rejected") {
      return NextResponse.json(
        { error: "Only draft templates can be submitted" },
        { status: 400 },
      );
    }

    // Parse optional sampleValues from request body
    let sampleValues: string[] = [];
    try {
      const reqBody = await request.json();
      if (Array.isArray(reqBody?.sampleValues)) {
        sampleValues = reqBody.sampleValues.map(String);
      }
    } catch {
      // No body or invalid JSON — proceed without sample values
    }

    if (template.body.length > 1024) {
      return NextResponse.json(
        {
          error: `Character Limit Exceeded — The Body field can't have more than 1,024 characters. Current: ${template.body.length}.`,
        },
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

    // Meta requires template names to be lowercase alphanumeric + underscores only
    const metaTemplateName = template.name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    const requestBody = {
      name: metaTemplateName,
      language: template.language ?? "en",
      category: template.category.toUpperCase(),
      components: buildComponents(template, sampleValues),
    };

    console.log("Meta API request:", JSON.stringify(requestBody, null, 2));

    // Call Meta Graph API to create the template
    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error("Meta API error:", metaData);
      const isTokenExpired =
        metaData.error?.code === 190 ||
        (typeof metaData.error?.message === "string" &&
          metaData.error.message.includes("Session has expired"));
      if (isTokenExpired) {
        return NextResponse.json(
          {
            error: metaData.error.message,
            code: "META_TOKEN_EXPIRED",
          },
          { status: 401 },
        );
      }
      return NextResponse.json(
        {
          error:
            metaData.error?.error_user_title ||
            metaData.error?.message ||
            "Failed to submit template to Meta",
          detail: metaData.error?.error_user_msg || metaData.error?.error_data,
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
