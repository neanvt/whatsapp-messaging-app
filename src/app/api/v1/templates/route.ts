import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { authenticateApiKey, unauthorized } from "@/lib/api-auth";
import { countVariables, parseJsonColumn } from "@/lib/template-format";

const KNOWN = ["draft", "pending", "submitted", "approved", "rejected"] as const;

// GET - Public template list. API-key auth only; scoped to the key owner. Optional
// ?status narrows the list and is validated against the known set (400 on unknown).
// Returns full template content (body, header, footer, buttons) + variableCount so
// an integration can render a preview and know how many variables to collect.
// The select is a non-credential allow-list (own tenant's own templates only).
export async function GET(request: Request) {
  const ctx = await authenticateApiKey(request);
  if (!ctx) return unauthorized();

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  if (
    rawStatus !== null &&
    !KNOWN.includes(rawStatus as (typeof KNOWN)[number])
  ) {
    return NextResponse.json(
      { error: `Invalid status. Allowed: ${KNOWN.join(", ")}` },
      { status: 400 },
    );
  }

  const templates = await prisma.template.findMany({
    where: { userId: ctx.userId, ...(rawStatus ? { status: rawStatus } : {}) },
    select: {
      id: true,
      name: true,
      category: true,
      language: true,
      status: true,
      body: true,
      headerType: true,
      headerContent: true,
      footerContent: true,
      buttons: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    templates.map((t) => ({
      ...t,
      buttons: parseJsonColumn(t.buttons),
      variableCount: countVariables(t.body),
    })),
  );
}
