// API-key authentication for the public /api/v1 surface. Never log the token or hash.
import { NextResponse } from "next/server";
import crypto from "crypto";
import prisma from "@/lib/db";
import { hashKey, looksLikeApiKey } from "@/lib/api-key";
import type { WhatsAppNumber, ApiKey } from "@prisma/client";

export interface ApiKeyContext {
  userId: string;
  apiKey: ApiKey;
  number: WhatsAppNumber;
}

export async function authenticateApiKey(
  request: Request,
): Promise<ApiKeyContext | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return null; // missing/malformed → 401
  const token = match[1].trim();
  if (!looksLikeApiKey(token)) return null; // wrong shape → 401, no DB hit

  const computedHash = hashKey(token);
  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash: computedHash },
  });
  if (!apiKey) return null; // unknown key → 401
  if (apiKey.revokedAt) return null; // revoked → 401

  // Defense-in-depth constant-time compare (NFR2). Equal-length hex buffers.
  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(apiKey.keyHash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const number = await prisma.whatsAppNumber.findUnique({
    where: { id: apiKey.whatsappNumberId },
  });
  if (!number) return null; // bound number vanished → 401

  // Best-effort lastUsedAt (FR2.5): never block or fail the request.
  prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      /* swallow — do not log the key */
    });

  return { userId: apiKey.userId, apiKey, number };
}

// Shared 401 responder used by all /api/v1 routes.
export function unauthorized() {
  return NextResponse.json(
    { error: "Invalid or missing API key" },
    { status: 401 },
  );
}
