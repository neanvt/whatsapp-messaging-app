import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { authenticateApiKey, unauthorized } from "@/lib/api-auth";
import { isSuperAdminUser } from "@/lib/api-key";
import { sendTemplateMessage } from "@/lib/send-template";

const Body = z
  .object({
    recipient: z.string().min(1),
    templateName: z.string().min(1).optional(),
    templateId: z.string().min(1).optional(),
    variables: z.array(z.string()).optional(),
    templateParams: z.record(z.string(), z.string()).optional(),
    mediaUrl: z.string().optional(),
    documentUrl: z.string().optional(),
    documentBase64: z.string().optional(),
    pdfBase64: z.string().optional(),
    mediaBase64: z.string().optional(),
    mediaId: z.string().optional(),
    fileName: z.string().optional(),
    filename: z.string().optional(),
    buttonParam: z.string().optional(),
    buttonUrlParam: z.string().optional(),
  })
  .refine((b) => !!b.templateName !== !!b.templateId, {
    message: "Provide exactly one of templateName or templateId",
  })
  .refine(
    (b) =>
      !(
        b.variables?.length &&
        b.templateParams &&
        Object.keys(b.templateParams).length > 0
      ),
    {
      message: "Provide either 'variables' or 'templateParams', not both.",
    },
  );

// POST - Public template send. API-key auth only; the send always uses the key's
// bound number (ctx.number) — a client number/credential is never accepted.
export async function POST(request: Request) {
  try {
    const ctx = await authenticateApiKey(request);
    if (!ctx) return unauthorized();

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }
    const {
      recipient,
      templateName,
      templateId,
      variables,
      templateParams,
      mediaUrl,
      documentUrl,
      fileName,
      filename,
      buttonParam,
      buttonUrlParam,
      documentBase64,
      pdfBase64,
      mediaBase64,
      mediaId,
    } = parsed.data;

    // Resolve the template by owner + name/id. Split not-found (404) from
    // exists-but-not-approved (400): find owner-scoped first, then check status.
    const owned = await prisma.template.findFirst({
      where: {
        userId: ctx.userId,
        ...(templateId ? { id: templateId } : { name: templateName }),
      },
    });
    if (!owned) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (owned.status !== "approved") {
      return NextResponse.json(
        { error: "Template not found or not approved" },
        { status: 400 },
      );
    }

    // Superadmin is email-driven, not the raw DB role — compute ONCE via the
    // shared predicate and pass the single boolean through the send.
    const owner = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { email: true, role: true },
    });
    if (!owner) return unauthorized();
    const isSuperAdmin = isSuperAdminUser(owner);

    const result = await sendTemplateMessage({
      userId: ctx.userId,
      number: ctx.number,
      template: owned,
      recipient,
      variables,
      namedParams: templateParams,
      mediaUrl,
      documentUrl,
      fileName,
      filename,
      buttonParam,
      buttonUrlParam,
      documentBase64,
      pdfBase64,
      mediaBase64,
      mediaId,
      isSuperAdmin,
    });

    if (!result.ok) {
      // Public API surfaces the helper's code verbatim (402 for credits, 500 for
      // not-connected / Meta failure, 400 for missing OTP).
      return NextResponse.json({ error: result.error }, { status: result.code });
    }

    return NextResponse.json({
      id: result.message.id,
      status: result.message.status,
      metaMessageId: result.message.metaMessageId,
    });
  } catch (error) {
    console.error("Error sending public message:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
