import { Prisma } from "@prisma/client";
import prisma from "@/lib/db";
import { decrypt } from "@/lib/crypto";

// Strip every non-digit character (matches the normalization used everywhere else).
export function normalizePhone(s: string): string {
  return s.replace(/\D/g, "");
}

// Shallow copy of a WhatsAppNumber row with the encrypted accessToken removed, so
// the ciphertext never leaves the server in an API response.
export function serializeNumber<T extends { accessToken?: string | null }>(
  number: T
): Omit<T, "accessToken"> {
  const { accessToken: _accessToken, ...rest } = number;
  return rest;
}

// Resolve the per-tenant credentials used to call the Meta Graph API for a
// given number. There is NO env fallback: a number must carry its own stored
// phoneNumberId + encrypted accessToken (captured via Embedded Signup or the
// manual connect path). A row without stored credentials resolves to nulls, so
// callers fail with a clear "number not connected" error instead of silently
// sending from a shared/hardcoded number. decrypt() may throw on a bad key or
// tampered ciphertext; callers wrap this call and treat a throw as "no creds".
export function resolveSendCredentials(number: {
  phoneNumberId: string | null;
  accessToken: string | null;
}): { phoneNumberId: string | null; accessToken: string | null } {
  if (number.accessToken !== null && number.phoneNumberId !== null) {
    return {
      phoneNumberId: number.phoneNumberId,
      accessToken: decrypt(number.accessToken),
    };
  }
  return { phoneNumberId: null, accessToken: null };
}

// Resolve the per-tenant WABA credentials used to call Meta's
// /{wabaId}/message_templates endpoints (submit / sync / delete). Mirrors
// resolveSendCredentials: there is NO env fallback — a row without a stored
// wabaId + encrypted accessToken resolves to nulls so callers raise a clear
// "number not connected" error instead of hitting a shared/hardcoded WABA.
// decrypt() may throw on a bad key / tampered ciphertext; callers wrap this
// call and treat a throw as a credential error (never log the token or
// ciphertext).
export function resolveWabaCredentials(number: {
  wabaId: string | null;
  accessToken: string | null;
}): { wabaId: string | null; accessToken: string | null } {
  if (number.wabaId !== null && number.accessToken !== null) {
    return {
      wabaId: number.wabaId,
      accessToken: decrypt(number.accessToken),
    };
  }
  return { wabaId: null, accessToken: null };
}

// Thrown when a phone number is already connected to a different tenant/user.
export class NumberOwnedByOtherTenantError extends Error {
  constructor(message = "This WhatsApp number is already connected to another account") {
    super(message);
    this.name = "NumberOwnedByOtherTenantError";
  }
}

// Find-then-branch "upsert" keyed on the globally-unique phoneNumber. We do NOT
// use prisma.whatsAppNumber.upsert because the number is unique across all
// tenants and we must reject cross-tenant collisions rather than overwrite them.
export async function upsertNumberForUser({
  userId,
  phoneNumber,
  data,
}: {
  userId: string;
  phoneNumber: string;
  data: Prisma.WhatsAppNumberUncheckedUpdateInput &
    Prisma.WhatsAppNumberUncheckedCreateInput;
}) {
  const existing = await prisma.whatsAppNumber.findUnique({
    where: { phoneNumber },
  });

  if (existing) {
    if (existing.userId !== userId) {
      throw new NumberOwnedByOtherTenantError();
    }
    return prisma.whatsAppNumber.update({
      where: { id: existing.id },
      data,
    });
  }

  try {
    return await prisma.whatsAppNumber.create({
      data: {
        ...data,
        userId,
        phoneNumber,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Lost a race: another tenant created the number between find and create.
      throw new NumberOwnedByOtherTenantError();
    }
    throw error;
  }
}
