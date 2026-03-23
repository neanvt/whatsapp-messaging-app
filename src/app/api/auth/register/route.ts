import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/db";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { fullName, email, password, companyName } = body;

    if (!fullName || !email || !password) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "Email already registered" },
        { status: 400 },
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user — every new subscriber is an admin of their own account
    const user = await prisma.user.create({
      data: {
        fullName,
        email,
        passwordHash,
        companyName: companyName || null,
        role: "admin",
      },
    });

    // Create user credits entry
    await prisma.userCredits.create({
      data: {
        userId: user.id,
        totalCredits: 0,
        usedCredits: 0,
      },
    });

    return NextResponse.json(
      { message: "User created successfully", userId: user.id },
      { status: 201 },
    );
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
