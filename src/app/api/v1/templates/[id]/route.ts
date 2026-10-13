import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { authenticateApiKey, unauthorized } from "@/lib/api-auth";
import { countVariables, parseJsonColumn } from "@/lib/template-format";

// GET - Public single-template detail. API-key auth only; scoped to the key
// owner. Returns full content (body, header, footer, buttons) + variableCount.
// A template that does not exist OR belongs to another tenant returns an
// IDENTICAL 404 (no existence oracle); the path id is never logged.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const ctx = await authenticateApiKey(request);
  if (!ctx) return unauthorized();

  const template = await prisma.template.findFirst({
    where: { id: params.id, userId: ctx.userId },
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
  });

  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...template,
    buttons: parseJsonColumn(template.buttons),
    variableCount: countVariables(template.body),
  });
}
