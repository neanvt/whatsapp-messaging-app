import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { resolveWabaCredentials } from "@/lib/whatsapp";

// GET - Get single template
export async function GET(
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

    return NextResponse.json(template);
  } catch (error) {
    console.error("Error fetching template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// PUT - Update a template (draft only)
export async function PUT(
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
        { error: "Only draft or rejected templates can be edited" },
        { status: 400 },
      );
    }

    const body = await request.json();
    const {
      name,
      category,
      language,
      body: templateBody,
      headerType,
      headerContent,
      footerContent,
      buttons,
      mediaAttachments,
    } = body;

    const updated = await prisma.template.update({
      where: { id: params.id },
      data: {
        name: name || template.name,
        category: category || template.category,
        language: language !== undefined ? language : template.language,
        body: templateBody || template.body,
        headerType: headerType !== undefined ? headerType : template.headerType,
        headerContent:
          headerContent !== undefined ? headerContent : template.headerContent,
        footerContent:
          footerContent !== undefined ? footerContent : template.footerContent,
        buttons: buttons !== undefined ? buttons : template.buttons,
        mediaAttachments:
          mediaAttachments !== undefined
            ? mediaAttachments
            : template.mediaAttachments,
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// DELETE - Delete a template
export async function DELETE(
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

    // If it was submitted to Meta, best-effort delete it there too using the
    // tenant's own per-tenant WABA credentials. This is non-fatal: any missing
    // number / credential problem simply skips the Meta call — the local delete
    // below always runs.
    if (template.metaTemplateId) {
      const usableWhere = {
        userId: session.user.id,
        verificationStatus: "verified",
        wabaId: { not: null },
        accessToken: { not: null },
      };

      let number: { wabaId: string | null; accessToken: string | null } | null =
        null;
      if (template.whatsappNumberId) {
        number = await prisma.whatsAppNumber.findFirst({
          where: { id: template.whatsappNumberId, ...usableWhere },
        });
      }
      if (!number) {
        const usable = await prisma.whatsAppNumber.findMany({
          where: usableWhere,
        });
        if (usable.length === 1) {
          number = usable[0];
        }
      }

      if (!number) {
        console.log(
          "[Template delete] no connected number — skipping Meta delete",
        );
      } else {
        let wabaId: string | null = null;
        let accessToken: string | null = null;
        try {
          ({ wabaId, accessToken } = resolveWabaCredentials(number));
        } catch {
          // decrypt() threw — best-effort, so skip Meta delete and never log the
          // token or ciphertext.
          console.warn(
            "[Template delete] credential error — skipping Meta delete",
          );
        }
        if (wabaId && accessToken) {
          await fetch(
            `https://graph.facebook.com/v19.0/${wabaId}/message_templates?hsm_id=${template.metaTemplateId}&name=${template.name}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${accessToken}` },
            },
          ).catch((e) => console.warn("Meta delete warning:", e));
        }
      }
    }

    await prisma.template.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ message: "Template deleted successfully" });
  } catch (error) {
    console.error("Error deleting template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
