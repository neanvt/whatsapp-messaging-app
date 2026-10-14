import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { authenticateApiKey, unauthorized } from "@/lib/api-auth";
import { isSuperAdminUser } from "@/lib/api-key";
import { sendTemplateMessage } from "@/lib/send-template";
import { shapePublicMessage } from "@/lib/template-format";
import type { Prisma } from "@prisma/client";

// --- GET /api/v1/messages (LIST) local validators (non-exported) -----------
// `received` is deliberately NOT a valid public FILTER value (public sends are
// outbound), though an inbound row's status "received" can still be RETURNED in
// an unfiltered page (design §3.3).
const KNOWN_STATUS = [
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
] as const;

// ISO 8601 instant: date + time, optional fractional seconds, mandatory zone
// designator (Z or ±HH:mm). Accepts offsets and seconds precision; rejects bare
// years / locale strings. Deliberately NOT a strict toISOString round-trip
// (that wrongly rejects `+05:30` and no-millisecond forms) — design §3.3.
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function parseSince(s: string): Date | null {
  if (!ISO_RE.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

// GET - Public message LIST + status. API-key auth only; every query is scoped
// to BOTH the key owner (ctx.userId) AND the key's bound number (ctx.number.id)
// so a key can never see another number/tenant's rows. Keyset pagination over
// the compound (createdAt desc, id desc) order; an unknown/deleted `after`
// cursor returns an empty page (no 404, no existence oracle). The key and query
// params are never logged (design §3).
export async function GET(request: Request) {
  try {
    const ctx = await authenticateApiKey(request);
    if (!ctx) return unauthorized();

    const url = new URL(request.url);

    // limit: positive integer, default 50, max 100; else fall back to 50.
    const rawLimit = url.searchParams.get("limit");
    const n = Number(rawLimit);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 50;

    // status: optional; must be in the send-lifecycle allow-list.
    const status = url.searchParams.get("status");
    if (status && !(KNOWN_STATUS as readonly string[]).includes(status)) {
      return NextResponse.json(
        {
          error: `Invalid status. Allowed: ${KNOWN_STATUS.join(", ")}.`,
        },
        { status: 400 },
      );
    }

    // since: optional ISO 8601 instant; filters createdAt strictly after it.
    const rawSince = url.searchParams.get("since");
    let since: Date | null = null;
    if (rawSince !== null) {
      since = parseSince(rawSince);
      if (!since) {
        return NextResponse.json(
          {
            error:
              "Invalid 'since' timestamp; expected an ISO 8601 instant (e.g. 2026-10-13T12:00:00.000Z or 2026-10-13T12:00:00+05:30).",
          },
          { status: 400 },
        );
      }
    }

    // Base scope — ALWAYS owner + bound number; additive filters never widen it.
    const where: Prisma.MessageWhereInput = {
      userId: ctx.userId,
      whatsappNumberId: ctx.number.id,
    };
    if (status) where.status = status;
    if (since) where.createdAt = { gt: since };

    // after: keyset cursor. Resolve the anchor row within scope; an unknown /
    // deleted / cross-tenant id returns an empty page (no oracle).
    const after = url.searchParams.get("after");
    if (after) {
      const anchor = await prisma.message.findFirst({
        where: {
          id: after,
          userId: ctx.userId,
          whatsappNumberId: ctx.number.id,
        },
        select: { createdAt: true, id: true },
      });
      if (!anchor) {
        return NextResponse.json({ data: [], nextCursor: null, hasMore: false });
      }
      where.OR = [
        { createdAt: { lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, id: { lt: anchor.id } },
      ];
    }

    const rows = await prisma.message.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        recipientPhone: true,
        templateId: true,
        status: true,
        metaMessageId: true,
        errorMessage: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        createdAt: true,
        direction: true,
        templateVariables: true,
        template: { select: { name: true, body: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    return NextResponse.json({
      data: page.map(shapePublicMessage),
      nextCursor,
      hasMore,
    });
  } catch (error) {
    console.error("Error listing public messages:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
