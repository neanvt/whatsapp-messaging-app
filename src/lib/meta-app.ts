import prisma from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export interface ResolvedMetaApp {
  appId: string;
  appSecret: string;
  // configId is INFORMATIONAL: consumed only by GET /api/meta-app and the
  // connect page (to drive the FB SDK). On the platform branch it comes from
  // NEXT_PUBLIC_META_CONFIG_ID, which — despite the NEXT_PUBLIC_ prefix — is a
  // plain env var readable server-side; reading it here is deliberate.
  configId: string | null;
  source: "tenant" | "platform";
}

export class MetaAppConfigError extends Error {
  constructor(message = "Meta app is not configured") {
    super(message);
    this.name = "MetaAppConfigError";
  }
}

/**
 * Resolve the Meta app credentials for a tenant. Per-tenant overrides the
 * platform env default. The ciphertext row never leaves this function; only the
 * decrypted secret is returned. The resolver never logs.
 */
export async function resolveMetaAppCredentials(
  userId: string,
): Promise<ResolvedMetaApp> {
  const row = await prisma.tenantMetaApp.findUnique({ where: { userId } });

  if (row) {
    let appSecret: string;
    try {
      appSecret = decrypt(row.metaAppSecret);
    } catch {
      throw new MetaAppConfigError("Tenant Meta app credentials are invalid");
    }
    return {
      appId: row.metaAppId,
      appSecret,
      configId: row.configId ?? null,
      source: "tenant",
    };
  }

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new MetaAppConfigError("Server is not configured for Embedded Signup");
  }
  return {
    appId,
    appSecret,
    configId: process.env.NEXT_PUBLIC_META_CONFIG_ID ?? null,
    source: "platform",
  };
}
