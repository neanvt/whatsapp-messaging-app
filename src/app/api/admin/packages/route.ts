import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";

// Default packages to seed on first load
const DEFAULT_PACKAGES = [
  {
    planId: "starter",
    name: "Starter",
    credits: 100,
    priceInr: 300,
    priceInPaise: 30000,
    pricePerMsg: 3,
    isActive: true,
    isPopular: false,
    sortOrder: 1,
  },
  {
    planId: "professional",
    name: "Professional",
    credits: 500,
    priceInr: 1250,
    priceInPaise: 125000,
    pricePerMsg: 2.5,
    isActive: true,
    isPopular: false,
    sortOrder: 2,
  },
  {
    planId: "enterprise",
    name: "Enterprise",
    credits: 2000,
    priceInr: 4000,
    priceInPaise: 400000,
    pricePerMsg: 2,
    isActive: true,
    isPopular: false,
    sortOrder: 3,
  },
  {
    planId: "business",
    name: "Business",
    credits: 5000,
    priceInr: 8000,
    priceInPaise: 800000,
    pricePerMsg: 1.6,
    isActive: true,
    isPopular: true,
    sortOrder: 4,
  },
];

async function ensurePackagesSeeded() {
  const count = await prisma.package.count();
  if (count === 0) {
    await prisma.package.createMany({ data: DEFAULT_PACKAGES });
  }
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);

  // Public endpoint returns only active packages (for buy credits page)
  // Admin endpoint returns all packages
  const isAdmin = session?.user?.role === "superadmin";
  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all") === "true";

  await ensurePackagesSeeded();

  const packages = await prisma.package.findMany({
    where: isAdmin && all ? {} : { isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  return NextResponse.json(packages);
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { planId, name, credits, priceInr, pricePerMsg, isPopular, sortOrder } =
    body;

  if (!planId || !name || !credits || !priceInr) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }

  const pkg = await prisma.package.create({
    data: {
      planId,
      name,
      credits: parseInt(credits),
      priceInr: parseInt(priceInr),
      priceInPaise: parseInt(priceInr) * 100,
      pricePerMsg:
        parseFloat(pricePerMsg) || parseFloat((priceInr / credits).toFixed(2)),
      isActive: true,
      isPopular: isPopular ?? false,
      sortOrder: sortOrder ?? 0,
    },
  });

  return NextResponse.json(pkg, { status: 201 });
}
