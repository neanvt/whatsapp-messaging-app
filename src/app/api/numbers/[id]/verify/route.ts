import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { resolveSendCredentials, serializeNumber } from "@/lib/whatsapp";

// POST - Refresh the live Meta health/status for a connected WhatsApp number.
// No local verification code is generated anymore; this pulls the current
// status fields straight from the Graph API using the number's stored token.
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const number = await prisma.whatsAppNumber.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!number) {
      return NextResponse.json({ error: "Number not found" }, { status: 404 });
    }

    // Legacy numbers with no stored token can't be refreshed — ask the user to
    // reconnect through the real Connect flow.
    if (number.accessToken === null) {
      return NextResponse.json(
        { error: "Reconnect this number via Connect WhatsApp" },
        { status: 400 }
      );
    }

    let phoneNumberId: string | null = null;
    let accessToken: string | null = null;
    try {
      ({ phoneNumberId, accessToken } = resolveSendCredentials(number));
    } catch {
      console.error("[Verify] credential resolution failed (encryption/config)");
      return NextResponse.json(
        { error: "Reconnect this number via Connect WhatsApp" },
        { status: 400 }
      );
    }

    if (!phoneNumberId || !accessToken) {
      return NextResponse.json(
        { error: "Reconnect this number via Connect WhatsApp" },
        { status: 400 }
      );
    }

    const healthRes = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const healthData = await healthRes.json();

    if (!healthRes.ok) {
      return NextResponse.json(
        {
          error:
            healthData.error?.message ?? "Failed to refresh status from Meta",
        },
        { status: 400 }
      );
    }

    const updated = await prisma.whatsAppNumber.update({
      where: { id: number.id },
      data: {
        displayPhoneNumber: healthData.display_phone_number ?? null,
        verifiedName: healthData.verified_name ?? null,
        qualityRating: healthData.quality_rating ?? null,
        codeVerificationStatus: healthData.code_verification_status ?? null,
        platformType: healthData.platform_type ?? null,
      },
    });

    return NextResponse.json(serializeNumber(updated));
  } catch (error) {
    console.error("Error refreshing number status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
