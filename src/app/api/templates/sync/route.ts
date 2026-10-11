import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { resolveWabaCredentials } from "@/lib/whatsapp";
import type { Prisma } from "@prisma/client";

// Map Meta status strings → our local status strings
function mapMetaStatus(metaStatus: string): string {
  switch (metaStatus.toUpperCase()) {
    case "APPROVED":
    case "ACTIVE": // Meta UI shows "Active" — API may return either
      return "approved";
    case "REJECTED":
    case "PAUSED":
    case "DISABLED":
    case "FLAGGED":
      return "rejected";
    case "PENDING":
    case "IN_APPEAL":
    case "IN_REVIEW": // Meta review in progress
    case "PENDING_DELETION":
      return "submitted";
    default:
      return "submitted";
  }
}

// POST /api/templates/sync  — fetches latest status+category from Meta and updates DB
export async function POST() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Resolve the tenant's usable (verified + stored wabaId/token) numbers.
    const numbers = await prisma.whatsAppNumber.findMany({
      where: {
        userId: session.user.id,
        verificationStatus: "verified",
        wabaId: { not: null },
        accessToken: { not: null },
      },
    });
    if (numbers.length === 0) {
      return NextResponse.json(
        { error: "Connect a WhatsApp number before managing templates" },
        { status: 409 },
      );
    }

    // Dedupe by wabaId so a WABA shared by several numbers is fetched once.
    // First number encountered per WABA owns imports from it.
    const wabaMap = new Map<
      string,
      { numberId: string; accessToken: string }
    >();
    for (const number of numbers) {
      let creds: { wabaId: string | null; accessToken: string | null };
      try {
        creds = resolveWabaCredentials(number);
      } catch {
        // A single bad ciphertext aborts the whole sync with a clean 500 — no
        // partial state, and never log the token or ciphertext.
        console.error(
          "[Template sync] credential resolution failed (encryption/config)",
        );
        return NextResponse.json(
          { error: "credential error" },
          { status: 500 },
        );
      }
      // Defensive: the findMany already filtered non-null wabaId/accessToken, so
      // a null here means a filtered row slipped through, not a crypto failure.
      if (!creds.wabaId || !creds.accessToken) continue;
      if (!wabaMap.has(creds.wabaId)) {
        wabaMap.set(creds.wabaId, {
          numberId: number.id,
          accessToken: creds.accessToken,
        });
      }
    }
    if (wabaMap.size === 0) {
      return NextResponse.json(
        { error: "Connect a WhatsApp number before managing templates" },
        { status: 409 },
      );
    }

    type MetaTemplate = {
      id: string;
      name: string;
      status: string;
      category: string;
      language: string;
      components?: Array<{ type: string; text?: string; format?: string }>;
      __sourceNumberId: string; // transient: source WhatsAppNumber id for this WABA
    };

    // Fetch templates from every distinct WABA and tag each with its source
    // number so Meta-only imports can be bound to a concrete number.
    const metaTemplates: MetaTemplate[] = [];
    for (const [wabaId, { numberId, accessToken }] of wabaMap) {
      const metaRes = await fetch(
        `https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=id,name,status,category,language,components&limit=250&access_token=${accessToken}`,
      );

      if (!metaRes.ok) {
        const metaError = await metaRes.json();
        console.error("Meta sync error:", metaError);
        const isTokenExpired =
          metaError.error?.code === 190 ||
          (typeof metaError.error?.message === "string" &&
            metaError.error.message.includes("Session has expired"));
        if (isTokenExpired) {
          return NextResponse.json(
            {
              error: metaError.error.message,
              code: "META_TOKEN_EXPIRED",
            },
            { status: 401 },
          );
        }
        return NextResponse.json(
          {
            error:
              metaError.error?.message || "Failed to fetch templates from Meta",
          },
          { status: 400 },
        );
      }

      const metaData = await metaRes.json();
      for (const t of (metaData.data ?? []) as Omit<
        MetaTemplate,
        "__sourceNumberId"
      >[]) {
        metaTemplates.push({ ...t, __sourceNumberId: numberId });
      }
    }

    console.log(
      "Meta templates fetched:",
      metaTemplates.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        category: t.category,
      })),
    );

    // Build a lookup map: metaTemplateId → meta template
    const byId = new Map(metaTemplates.map((t) => [t.id, t]));
    // Also build by sanitized name as fallback (same sanitization used during submission)
    const sanitize = (n: string) =>
      n
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");
    const byName = new Map(metaTemplates.map((t) => [sanitize(t.name), t]));

    // Get ALL templates for this user (needed for both update and dedup)
    const allLocalTemplates = await prisma.template.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        metaTemplateId: true,
        name: true,
        status: true,
        category: true,
      },
      orderBy: { createdAt: "asc" }, // keep oldest, remove duplicates
    });

    // De-duplicate: if same name appears multiple times, keep oldest, delete rest
    const seenNames = new Map<string, string>(); // name → first id
    const duplicateIds: string[] = [];
    for (const t of allLocalTemplates) {
      const key = sanitize(t.name);
      if (seenNames.has(key)) {
        duplicateIds.push(t.id);
      } else {
        seenNames.set(key, t.id);
      }
    }
    if (duplicateIds.length > 0) {
      await prisma.template.deleteMany({ where: { id: { in: duplicateIds } } });
      console.log(`Deleted ${duplicateIds.length} duplicate template(s)`);
    }

    // Use only non-duplicate templates for update loop
    const localTemplates = allLocalTemplates.filter(
      (t) =>
        !duplicateIds.includes(t.id) &&
        ["submitted", "pending", "approved"].includes(t.status),
    );

    // Build fresh dedup sets for import (excluding deleted duplicates)
    const existingMetaIds = new Set(
      allLocalTemplates
        .filter((t) => !duplicateIds.includes(t.id))
        .map((t) => t.metaTemplateId)
        .filter(Boolean),
    );
    const existingNames = new Set(
      allLocalTemplates
        .filter((t) => !duplicateIds.includes(t.id))
        .map((t) => sanitize(t.name)),
    );

    let updated = 0;

    for (const local of localTemplates) {
      const meta =
        (local.metaTemplateId ? byId.get(local.metaTemplateId) : null) ??
        byName.get(sanitize(local.name));

      if (!meta) {
        console.log(
          `No Meta match for local template "${local.name}" (metaId: ${local.metaTemplateId ?? "none"})`,
        );
        continue;
      }

      const newStatus = mapMetaStatus(meta.status);
      const newCategory = meta.category.toLowerCase(); // MARKETING → marketing

      console.log(
        `Template "${local.name}": ${local.status} → ${newStatus}, ${local.category} → ${newCategory} (Meta status: ${meta.status})`,
      );

      if (newStatus !== local.status || newCategory !== local.category) {
        await prisma.template.update({
          where: { id: local.id },
          data: {
            status: newStatus,
            category: newCategory,
            reviewedAt:
              newStatus === "approved" || newStatus === "rejected"
                ? new Date()
                : undefined,
            metaTemplateId: local.metaTemplateId ?? meta.id,
          },
        });
        updated++;
      }
    }

    // --- Import templates that exist on Meta but not locally ---
    let imported = 0;

    for (const meta of metaTemplates) {
      // Skip if already tracked locally (by id or name)
      if (
        existingMetaIds.has(meta.id) ||
        existingNames.has(sanitize(meta.name))
      )
        continue;

      // Extract body text from components
      const bodyComp = meta.components?.find((c) => c.type === "BODY");
      const headerComp = meta.components?.find((c) => c.type === "HEADER");
      const footerComp = meta.components?.find((c) => c.type === "FOOTER");
      const bodyText = bodyComp?.text ?? "(No body)";
      const headerType = headerComp
        ? (headerComp.format?.toLowerCase() ?? "text")
        : null;
      const headerContent = headerComp?.text ?? null;
      const footerContent = footerComp?.text ?? null;

      // Normalise language: "en_US" → "en_US", "en" → "en"
      const language = meta.language ?? "en";

      console.log(
        `Importing Meta template "${meta.name}" (${meta.id}) into local DB`,
      );

      await prisma.template.create({
        data: {
          userId: session.user.id,
          name: meta.name,
          category: meta.category.toLowerCase(),
          language: language,
          body: bodyText,
          headerType,
          headerContent,
          footerContent,
          status: mapMetaStatus(meta.status),
          metaTemplateId: meta.id,
          whatsappNumberId: meta.__sourceNumberId,
          submittedAt: new Date(),
          reviewedAt: new Date(),
        } satisfies Prisma.TemplateUncheckedCreateInput,
      });
      // Track to prevent duplicate imports within the same sync run
      existingNames.add(sanitize(meta.name));
      existingMetaIds.add(meta.id);
      imported++;
    }

    return NextResponse.json({
      synced: localTemplates.length,
      updated,
      imported,
      duplicatesRemoved: duplicateIds.length,
    });
  } catch (error) {
    console.error("Error syncing templates:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
