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

// Resolve the credentials used to call the Meta Graph API for a given number.
// Prefers the row's own (decrypted) per-tenant token; falls back to the shared
// env credentials only when the row has no stored token. decrypt() may throw.
export function resolveSendCredentials(number: {
  phoneNumberId: string | null;
  accessToken: string | null;
}): { phoneNumberId: string | null; accessToken: string | null } {
  if (number.accessToken !== null) {
    return {
      phoneNumberId: number.phoneNumberId,
      accessToken: decrypt(number.accessToken),
    };
  }
  return {
    phoneNumberId: number.phoneNumberId ?? process.env.META_PHONE_NUMBER_ID ?? null,
    accessToken: process.env.META_ACCESS_TOKEN ?? null,
  };
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
