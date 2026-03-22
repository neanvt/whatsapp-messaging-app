import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/db";
import Razorpay from "razorpay";

// Initialize Razorpay only if credentials are available
const getRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return null;
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

const PLAN_CREDITS: Record<string, { credits: number; amount: number }> = {
  starter: { credits: 100, amount: 30000 }, // ₹300 in paise
  professional: { credits: 500, amount: 125000 }, // ₹1250 in paise
  enterprise: { credits: 2000, amount: 400000 }, // ₹4000 in paise
};

// POST - Create a Razorpay order
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { planId } = body;

    if (!planId || !PLAN_CREDITS[planId]) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    const { credits, amount } = PLAN_CREDITS[planId];
    const razorpay = getRazorpayClient();

    // If Razorpay is not configured, return mock data for testing
    if (!razorpay) {
      console.log("[MOCK] Creating order for plan:", planId, "credits:", credits);

      // Create a mock order record in database
      const order = await prisma.payment.create({
        data: {
          userId: session.user.id,
          razorpayOrderId: `mock_order_${Date.now()}`,
          amount,
          amountInr: amount / 100,
          creditsPurchased: credits,
          creditsRemaining: credits,
          status: "pending",
        },
      });

      return NextResponse.json({
        orderId: order.razorpayOrderId,
        keyId: "rzp_test_XXXXXXXX",
        amount,
        credits,
      });
    }

    // Create real Razorpay order
    const razorpayOrder = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `order_${session.user.id}_${Date.now()}`,
      notes: {
        userId: session.user.id,
        planId,
        credits: credits.toString(),
      },
    });

    // Store order in database
    await prisma.payment.create({
      data: {
        userId: session.user.id,
        razorpayOrderId: razorpayOrder.id,
        amount,
        amountInr: amount / 100,
        creditsPurchased: credits,
        creditsRemaining: credits,
        status: "pending",
      },
    });

    return NextResponse.json({
      orderId: razorpayOrder.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount,
      credits,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
