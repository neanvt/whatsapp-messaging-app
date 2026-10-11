import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// POST - Deprecated. Manual local-code confirmation can never mark a number as
// verified; numbers are only verified by connecting real Meta credentials via
// Embedded Signup or the manual-credentials path.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      error:
        "Manual code confirmation is no longer supported. Connect via Embedded Signup or manual credentials.",
    },
    { status: 410 }
  );
}
