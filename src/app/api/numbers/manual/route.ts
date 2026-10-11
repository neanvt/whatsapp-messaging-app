import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import {
  normalizePhone,
  serializeNumber,
  upsertNumberForUser,
  NumberOwnedByOtherTenantError,
} from "@/lib/whatsapp";

const GRAPH = "https://graph.facebook.com/v19.0";

const bodySchema = z.object({
  wabaId: z.string().min(1).max(100),
  phoneNumberId: z.string().min(1).max(100),
  accessToken: z.string().min(10).max(5000),
  label: z.string().min(0).max(100).optional(),
});

// POST - Manual credential connect (Path B): validate the provided token against
// Meta BEFORE persisting, then store the encrypted token per-tenant.
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { wabaId, phoneNumberId, accessToken: providedToken } = parsed.data;

    // --- Validate the number + token against Meta before any DB write ---
    const healthUrl =
      `${GRAPH}/${encodeURIComponent(phoneNumberId)}` +
      `?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status`;
    const healthRes = await fetch(healthUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${providedToken}` },
    });
    const healthData = await healthRes.json().catch(() => ({}));
    if (!healthRes.ok) {
      const message =
        healthData?.error?.message ??
        "Could not validate this phone number with the provided token";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // --- Three-way WABA tie-check ---
    const phonesRes = await fetch(
      `${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${providedToken}` },
      },
    );
    const phonesData = await phonesRes.json().catch(() => ({}));
    if (phonesRes.ok) {
      const list: Array<{ id?: string }> = phonesData?.data ?? [];
      const present = list.some((p) => p.id === phoneNumberId);
      if (!present) {
        // (b) list OK and the phone is absent -> fatal, nothing saved
        return NextResponse.json(
          {
            error:
              "This phone number is not under the provided WhatsApp Business Account",
          },
          { status: 400 },
        );
      }
      // (a) list OK and present -> proceed
    } else {
      // (c) list call failed -> non-fatal; step 1 health check is authoritative
      console.warn(
        `[ManualConnect] Could not list phone numbers for waba ${wabaId} (non-fatal): ${phonesRes.status}`,
      );
    }

    // --- Subscribe the app to the WABA (non-fatal) ---
    try {
      const subRes = await fetch(
        `${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${providedToken}` },
        },
      );
      console.log(
        `[ManualConnect] subscribed_apps result for waba ${wabaId}: ${subRes.status}`,
      );
    } catch {
      console.warn(
        `[ManualConnect] subscribed_apps call failed for waba ${wabaId} (non-fatal)`,
      );
    }

    // --- Resolve the display phone number ---
    const phoneNumber = normalizePhone(healthData?.display_phone_number ?? "");
    if (!phoneNumber) {
      return NextResponse.json(
        { error: "Could not read the number's display phone from Meta" },
        { status: 400 },
      );
    }

    // --- Persist encrypted per-tenant token ---
    const ciphertext = encrypt(providedToken);
    try {
      const record = await upsertNumberForUser({
        userId: session.user.id,
        phoneNumber,
        data: {
          connectionType: "manual",
          wabaId,
          phoneNumberId,
          accessToken: ciphertext,
          tokenExpiresAt: null,
          displayPhoneNumber: healthData?.display_phone_number ?? null,
          verifiedName: healthData?.verified_name ?? null,
          qualityRating: healthData?.quality_rating ?? null,
          codeVerificationStatus: healthData?.code_verification_status ?? null,
          platformType: healthData?.platform_type ?? null,
          verificationStatus: "verified",
          verifiedAt: new Date(),
        } as Prisma.WhatsAppNumberUncheckedUpdateInput &
          Prisma.WhatsAppNumberUncheckedCreateInput,
      });

      return NextResponse.json(serializeNumber(record), { status: 201 });
    } catch (error) {
      if (error instanceof NumberOwnedByOtherTenantError) {
        return NextResponse.json(
          { error: "This number is connected to another account" },
          { status: 409 },
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("[ManualConnect] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
