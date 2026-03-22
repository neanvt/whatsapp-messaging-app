import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

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

    const wabaId = process.env.META_WABA_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!wabaId || !accessToken) {
      return NextResponse.json(
        { error: "Meta API credentials not configured" },
        { status: 500 },
      );
    }

    // Fetch all templates for this WABA from Meta
    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=id,name,status,category&limit=250&access_token=${accessToken}`,
    );

    if (!metaRes.ok) {
      const metaError = await metaRes.json();
      console.error("Meta sync error:", metaError);
      return NextResponse.json(
        {
          error:
            metaError.error?.message || "Failed to fetch templates from Meta",
        },
        { status: 400 },
      );
    }

    const metaData = await metaRes.json();
    const metaTemplates: Array<{
      id: string;
      name: string;
      status: string;
      category: string;
    }> = metaData.data ?? [];

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

    // Get all submitted/pending/approved templates for this user that have a metaTemplateId
    const localTemplates = await prisma.template.findMany({
      where: {
        userId: session.user.id,
        status: { in: ["submitted", "pending", "approved"] },
      },
      select: {
        id: true,
        metaTemplateId: true,
        name: true,
        status: true,
        category: true,
      },
    });

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

    return NextResponse.json({ synced: localTemplates.length, updated });
  } catch (error) {
    console.error("Error syncing templates:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
