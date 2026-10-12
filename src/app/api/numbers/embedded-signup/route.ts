import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { resolveMetaAppCredentials, MetaAppConfigError } from "@/lib/meta-app";
import {
  normalizePhone,
  serializeNumber,
  upsertNumberForUser,
  NumberOwnedByOtherTenantError,
} from "@/lib/whatsapp";

const GRAPH = "https://graph.facebook.com/v19.0";

const bodySchema = z.object({
  code: z.string().min(1).max(4000),
  phoneNumberId: z.string().min(1).max(100).optional(),
  wabaId: z.string().min(1).max(100).optional(),
});

// POST - Meta Embedded Signup (Path A): exchange the OAuth code for a
// per-tenant token, validate the number against Meta, then persist encrypted.
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
    const { code } = parsed.data;
    let { phoneNumberId, wabaId } = parsed.data;

    let appId: string, appSecret: string;
    try {
      ({ appId, appSecret } = await resolveMetaAppCredentials(session.user.id));
    } catch (e) {
      if (e instanceof MetaAppConfigError) {
        return NextResponse.json(
          { error: "Server is not configured for Embedded Signup" },
          { status: 500 },
        );
      }
      throw e;
    }

    // --- Exchange the OAuth code for a business access token (no redirect_uri) ---
    const tokenUrl =
      `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenRes = await fetch(tokenUrl, { method: "GET" });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData?.access_token) {
      const message =
        tokenData?.error?.message ?? "Failed to exchange authorization code";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const businessToken: string = tokenData.access_token;
    const expiresIn =
      typeof tokenData.expires_in === "number" ? tokenData.expires_in : null;
    const tokenExpiresAt =
      expiresIn !== null ? new Date(Date.now() + expiresIn * 1000) : null;

    // --- Resolve the WABA id: body value first, else debug_token ---
    if (!wabaId) {
      const debugUrl =
        `${GRAPH}/debug_token?input_token=${encodeURIComponent(businessToken)}` +
        `&access_token=${encodeURIComponent(businessToken)}`;
      const debugRes = await fetch(debugUrl, { method: "GET" });
      const debugData = await debugRes.json().catch(() => ({}));
      const granularScopes: Array<{ scope?: string; target_ids?: string[] }> =
        debugData?.data?.granular_scopes ?? [];
      for (const entry of granularScopes) {
        if (entry.scope === "whatsapp_business_management") {
          const target = entry?.target_ids?.[0];
          if (target) {
            wabaId = target;
            break;
          }
        }
      }
    }

    if (!wabaId) {
      return NextResponse.json(
        {
          error:
            "Could not determine the WhatsApp Business Account from the authorization. Please try connecting again.",
        },
        { status: 400 },
      );
    }

    // --- Discover the phone_number_id if not provided ---
    if (!phoneNumberId) {
      const phonesUrl =
        `${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers` +
        `?access_token=${encodeURIComponent(businessToken)}`;
      const phonesRes = await fetch(phonesUrl, { method: "GET" });
      const phonesData = await phonesRes.json().catch(() => ({}));
      if (!phonesRes.ok) {
        const message =
          phonesData?.error?.message ??
          "Could not list phone numbers for this WhatsApp Business Account";
        return NextResponse.json({ error: message }, { status: 400 });
      }
      const first = phonesData?.data?.[0];
      if (first?.id) {
        phoneNumberId = first.id;
      }
    }

    if (!phoneNumberId) {
      return NextResponse.json(
        {
          error:
            "No phone number is available on this WhatsApp Business Account yet.",
        },
        { status: 400 },
      );
    }

    // --- Fetch number health; non-OK aborts before any save ---
    const healthUrl =
      `${GRAPH}/${encodeURIComponent(phoneNumberId)}` +
      `?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status` +
      `&access_token=${encodeURIComponent(businessToken)}`;
    const healthRes = await fetch(healthUrl, { method: "GET" });
    const healthData = await healthRes.json().catch(() => ({}));
    if (!healthRes.ok) {
      const message =
        healthData?.error?.message ??
        "Could not read this phone number's details from Meta";
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // --- Subscribe the app to the WABA (non-fatal) ---
    try {
      const subRes = await fetch(
        `${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${businessToken}` },
        },
      );
      console.log(
        `[EmbeddedSignup] subscribed_apps result for waba ${wabaId}: ${subRes.status}`,
      );
    } catch {
      console.warn(
        `[EmbeddedSignup] subscribed_apps call failed for waba ${wabaId} (non-fatal)`,
      );
    }

    // --- Register the number with a random pin (advisory; never fails onboarding) ---
    try {
      const pin = String(Math.floor(100000 + Math.random() * 900000));
      const regRes = await fetch(
        `${GRAPH}/${encodeURIComponent(phoneNumberId)}/register`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${businessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messaging_product: "whatsapp", pin }),
        },
      );
      const regData = await regRes.json().catch(() => ({}));
      if (regRes.ok) {
        console.log(
          `[EmbeddedSignup] register OK for phone ${phoneNumberId}`,
        );
      } else if (regData?.error?.code === 133016) {
        console.log(
          `[EmbeddedSignup] phone ${phoneNumberId} already registered (133016)`,
        );
      } else {
        console.log(
          `[EmbeddedSignup] register non-OK for phone ${phoneNumberId}: ${regRes.status} (non-fatal)`,
        );
      }
    } catch {
      console.warn(
        `[EmbeddedSignup] register call failed for phone ${phoneNumberId} (non-fatal)`,
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
    const ciphertext = encrypt(businessToken);
    try {
      const record = await upsertNumberForUser({
        userId: session.user.id,
        phoneNumber,
        data: {
          connectionType: "embedded_signup",
          wabaId,
          phoneNumberId,
          accessToken: ciphertext,
          tokenExpiresAt,
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
    console.error("[EmbeddedSignup] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
