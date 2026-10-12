import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import type { TenantMetaApp } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { encrypt } from "@/lib/crypto";

// Build the GET response from a TenantMetaApp row (or null) + platform env.
// The secret value cannot escape here: the ciphertext is never selected into
// or placed on the response object, and this never decrypts. hasSecret reports
// whether a TENANT secret is STORED (not whether it is valid).
function serializeMetaApp(row: TenantMetaApp | null): {
  appId: string | null;
  configId: string | null;
  source: "tenant" | "platform";
  hasSecret: boolean;
} {
  if (row) {
    return {
      appId: row.metaAppId,
      configId: row.configId ?? null,
      source: "tenant",
      hasSecret: true,
    };
  }
  return {
    appId: process.env.META_APP_ID ?? null,
    configId: process.env.NEXT_PUBLIC_META_CONFIG_ID ?? null,
    source: "platform",
    hasSecret: false,
  };
}

const putSchema = z.object({
  metaAppId: z.string().trim().min(1).max(100),
  metaAppSecret: z.string().min(10).max(500).optional(),
  configId: z.string().trim().min(1).max(100).nullish(), // string | null | undefined
});

// GET - Return the tenant's effective Meta app config (never the secret value).
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const row = await prisma.tenantMetaApp.findUnique({
      where: { userId: session.user.id },
    });
    return NextResponse.json(serializeMetaApp(row));
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// PUT - Create or update the tenant's own Meta app (atomic upsert). The secret
// is write-only: required on create, left unchanged when omitted on update.
export async function PUT(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const json = await request.json();
    const parsed = putSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { metaAppId, metaAppSecret, configId } = parsed.data;

    // Cheap existence check (never selects the ciphertext) to enforce the
    // required-on-create rule before the atomic upsert.
    const existing = await prisma.tenantMetaApp.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!existing && !metaAppSecret) {
      return NextResponse.json(
        { error: "App secret is required to connect your Meta app" },
        { status: 400 },
      );
    }

    // Build the update payload: only set fields the caller is changing.
    const updateData: Record<string, unknown> = { metaAppId };
    if (metaAppSecret) updateData.metaAppSecret = encrypt(metaAppSecret);
    if (configId !== undefined) updateData.configId = configId; // null clears, string sets, undefined untouched

    const row = await prisma.tenantMetaApp.upsert({
      where: { userId },
      create: {
        userId,
        metaAppId,
        metaAppSecret: encrypt(metaAppSecret!), // guaranteed present by the guard above
        configId: configId ?? null, // on create, undefined → null (no prior value)
      },
      update: updateData,
    });

    return NextResponse.json(serializeMetaApp(row));
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// DELETE - Revert the tenant to the platform fallback (idempotent).
export async function DELETE() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await prisma.tenantMetaApp.deleteMany({
      where: { userId: session.user.id },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
