import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import { generateApiKey } from "@/lib/api-key";

// GET - List the caller's API keys. Session-guarded, scoped to session.user.id.
// The select is an allow-list that NEVER includes keyHash (FR4.1, AC4, AC16).
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const keys = await prisma.apiKey.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
        whatsappNumber: {
          select: { id: true, phoneNumber: true, displayPhoneNumber: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(keys);
  } catch (error) {
    console.error("Error listing API keys:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

const CreateBody = z.object({
  name: z.string().min(1),
  numberId: z.string().min(1),
});

// POST - Create an API key bound to a verified owned number. The plaintext key
// is returned exactly ONCE here (A7, FR4.2, AC3); only keyHash + keyPrefix are
// stored. Never log or re-return the plaintext.
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const parsed = CreateBody.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }
    const { name, numberId } = parsed.data;

    const number = await prisma.whatsAppNumber.findFirst({
      where: {
        id: numberId,
        userId: session.user.id,
        verificationStatus: "verified",
      },
    });
    if (!number) {
      return NextResponse.json(
        { error: "Invalid or unverified WhatsApp number" },
        { status: 400 },
      );
    }

    const { plaintext, hash, prefix } = generateApiKey();

    const created = await prisma.apiKey.create({
      data: {
        userId: session.user.id,
        whatsappNumberId: numberId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        whatsappNumberId: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    // The one-time reveal: plaintext is included only in this response.
    return NextResponse.json({ ...created, key: plaintext }, { status: 201 });
  } catch (error) {
    console.error("Error creating API key:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
