import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { resolveWabaCredentials } from "@/lib/whatsapp";

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

    // Parse optional sampleValues + numberId from request body. The body stream
    // can be read only once, so read both from the SAME reqBody object — adding
    // a second `await request.json()` would throw "body already read".
    let sampleValues: string[] = [];
    let numberId: string | undefined;
    try {
      const reqBody = await request.json();
      if (Array.isArray(reqBody?.sampleValues)) {
        sampleValues = reqBody.sampleValues.map(String);
      }
      numberId =
        typeof reqBody?.numberId === "string" && reqBody.numberId.length > 0
          ? reqBody.numberId
          : undefined;
    } catch {
      // No body or invalid JSON — proceed without sample values / numberId
    }

    if (template.body.length > 1024) {
      return NextResponse.json(
        {
          error: `Character Limit Exceeded — The Body field can't have more than 1,024 characters. Current: ${template.body.length}.`,
        },
        { status: 400 },
      );
    }

    // Resolve the per-tenant WhatsApp number this template is submitted from.
    // A "usable" number is verified with a stored wabaId + encrypted token.
    // Precedence: explicit numberId → template binding → the sole number.
    const usableWhere = {
      userId: session.user.id,
      verificationStatus: "verified",
      wabaId: { not: null },
      accessToken: { not: null },
    };

    let number: { id: string; wabaId: string | null; accessToken: string | null } | null =
      null;

    if (numberId) {
      number = await prisma.whatsAppNumber.findFirst({
        where: { id: numberId, ...usableWhere },
      });
      if (!number) {
        return NextResponse.json(
          {
            error: "Selected WhatsApp number is not connected",
            code: "NUMBER_NOT_CONNECTED",
          },
          { status: 400 },
        );
      }
    }

    if (!number && template.whatsappNumberId) {
      // Explicit template→number binding, if still usable. A stale binding falls
      // through to the user's-numbers branch below.
      number = await prisma.whatsAppNumber.findFirst({
        where: { id: template.whatsappNumberId, ...usableWhere },
      });
    }

    if (!number) {
      const usable = await prisma.whatsAppNumber.findMany({
        where: usableWhere,
      });
      if (usable.length === 0) {
        return NextResponse.json(
          { error: "Connect a WhatsApp number before managing templates" },
          { status: 409 },
        );
      }
      if (usable.length > 1) {
        return NextResponse.json(
          {
            error:
              "Multiple WhatsApp numbers connected — specify which number to submit this template from",
            code: "AMBIGUOUS_NUMBER",
          },
          { status: 400 },
        );
      }
      number = usable[0];
    }

    const resolvedNumberId = number.id;

    let wabaId: string | null;
    let accessToken: string | null;
    try {
      ({ wabaId, accessToken } = resolveWabaCredentials(number));
    } catch {
      // decrypt() threw (bad key / tampered ciphertext). Never log the token or
      // ciphertext.
      console.error(
        "[Template submit] credential resolution failed (encryption/config)",
      );
      return NextResponse.json(
        { error: "credential error" },
        { status: 500 },
      );
    }

    // Defensive: the query already filtered on non-null wabaId/accessToken, so
    // this branch is unreachable, but keep it consistent with the contract.
    if (!wabaId || !accessToken) {
      return NextResponse.json(
        { error: "Connect a WhatsApp number before managing templates" },
        { status: 409 },
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
        // Bind the template to the number it was submitted from, if not already
        // bound, so later sync/delete reuse the exact WABA without ambiguity.
        ...(template.whatsappNumberId
          ? {}
          : { whatsappNumberId: resolvedNumberId }),
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
