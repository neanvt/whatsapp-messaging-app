import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import crypto from "crypto";

// POST - Verify Razorpay payment
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return NextResponse.json({ error: "Missing payment details" }, { status: 400 });
    }

    // Find the payment record
    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId },
    });

    if (!payment) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (payment.userId !== session.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (payment.status === "completed") {
      return NextResponse.json({ error: "Payment already processed" }, { status: 400 });
    }

    // Verify signature
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest("hex");

      if (razorpaySignature !== expectedSignature) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
      }
    }

    // Update payment status
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "completed",
        razorpayPaymentId,
        razorpaySignature,
        paidAt: new Date(),
      },
    });

    // Add credits to user
    await prisma.userCredits.upsert({
      where: { userId: session.user.id },
      update: {
        totalCredits: { increment: payment.creditsPurchased },
        lastRechargedAt: new Date(),
      },
      create: {
        userId: session.user.id,
        totalCredits: payment.creditsPurchased,
        usedCredits: 0,
        lastRechargedAt: new Date(),
      },
    });

    return NextResponse.json({
      message: "Payment verified successfully",
      creditsAdded: payment.creditsPurchased,
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
