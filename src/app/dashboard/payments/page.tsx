"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CreditCard,
  Check,
  RefreshCw,
  Loader2,
  ExternalLink,
  Info,
} from "lucide-react";

interface CreditBalance {
  totalCredits: number;
  usedCredits: number;
  availableCredits: number;
}

interface Package {
  id: string;
  planId: string;
  name: string;
  credits: number;
  priceInr: number;
  pricePerMsg: number;
  isPopular: boolean;
}

declare global {
  interface Window {
    Razorpay: any;
  }
}

export default function PaymentsPage() {
  const router = useRouter();
  const [credits, setCredits] = useState<CreditBalance | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchCredits();
    fetchPackages();

    // Load Razorpay script
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  const fetchCredits = async () => {
    try {
      const res = await fetch("/api/credits/balance");
      if (res.ok) {
        const data = await res.json();
        setCredits(data);
      }
    } catch (err) {
      console.error("Failed to fetch credits:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchPackages = async () => {
    try {
      const res = await fetch("/api/admin/packages");
      if (res.ok) setPackages(await res.json());
    } catch (err) {
      console.error("Failed to fetch packages:", err);
    }
  };

  const handlePurchase = async (planId: string) => {
    setError("");
    setPurchasing(planId);

    try {
      // Create order
      const orderRes = await fetch("/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });

      const orderData = await orderRes.json();

      if (!orderRes.ok) {
        setError(orderData.error || "Failed to create order");
        setPurchasing(null);
        return;
      }

      // Initialize Razorpay
      const razorpay = new window.Razorpay({
        key: orderData.keyId,
        amount: orderData.amount,
        currency: "INR",
        name: "WhatsApp Business",
        description: `${orderData.credits} Message Credits`,
        order_id: orderData.orderId,
        handler: async function (response: any) {
          // Verify payment
          const verifyRes = await fetch("/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            }),
          });

          const verifyData = await verifyRes.json();

          if (verifyRes.ok) {
            router.push("/dashboard/payments?success=true");
            fetchCredits();
          } else {
            setError(verifyData.error || "Payment verification failed");
          }
        },
        prefill: {
          name: "User",
          email: "",
        },
        theme: {
          color: "#25D366",
        },
      });

      razorpay.on("payment.failed", function (response: any) {
        setError(`Payment failed: ${response.error.description}`);
        setPurchasing(null);
      });

      razorpay.open();
    } catch (err) {
      console.error("Purchase error:", err);
      setError("Something went wrong");
    } finally {
      setPurchasing(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Buy Credits</h1>
        <p className="text-muted-foreground">
          Purchase message credits to start sending WhatsApp messages
        </p>
      </div>

      <div className="mb-6 p-4 bg-gray-100 rounded-lg flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Current Balance</p>
          <p className="text-2xl font-bold">
            {credits?.availableCredits ?? 0} Credits
          </p>
        </div>
        <Button variant="outline" onClick={fetchCredits}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-6 p-4 text-sm text-red-500 bg-red-50 rounded-lg">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {packages.map((plan) => (
          <Card
            key={plan.id}
            className={plan.isPopular ? "border-[#25D366] shadow-lg" : ""}
          >
            {plan.isPopular && (
              <div className="bg-[#25D366] text-white text-center text-sm font-medium py-1">
                Most Popular
              </div>
            )}
            <CardHeader className="text-center">
              <CardTitle>{plan.name}</CardTitle>
              <CardDescription>
                {plan.credits.toLocaleString()} messages
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center">
              <div className="mb-4">
                <span className="text-4xl font-bold">
                  ₹{plan.priceInr.toLocaleString()}
                </span>
                <p className="text-sm text-muted-foreground">
                  ₹{plan.pricePerMsg}/message
                </p>
              </div>
              <ul className="text-sm text-left space-y-2 mb-6">
                <li className="flex items-center">
                  <Check className="w-4 h-4 text-green-600 mr-2" />
                  {plan.credits.toLocaleString()} message credits
                </li>
                <li className="flex items-center">
                  <Check className="w-4 h-4 text-green-600 mr-2" />
                  Instant delivery
                </li>
                <li className="flex items-center">
                  <Check className="w-4 h-4 text-green-600 mr-2" />
                  No expiry
                </li>
                <li className="flex items-center">
                  <Check className="w-4 h-4 text-green-600 mr-2" />
                  24/7 support
                </li>
              </ul>
              <Button
                className="w-full"
                variant={plan.isPopular ? "default" : "outline"}
                onClick={() => handlePurchase(plan.planId)}
                disabled={purchasing !== null}
              >
                {purchasing === plan.planId ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CreditCard className="w-4 h-4 mr-2" />
                    Buy Now
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground text-center mt-6">
        Need a custom plan?{" "}
        <a href="#" className="text-primary hover:underline">
          Contact us
        </a>{" "}
        for enterprise pricing.
      </p>

      {/* Meta Billing Info */}
      <div className="mt-8 p-5 rounded-xl border border-blue-200 bg-blue-50">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="font-semibold text-blue-900 mb-1">
              About Meta / Facebook Billing
            </h3>
            <p className="text-sm text-blue-800 mb-3">
              The credits above are for using <strong>this platform</strong>.
              Separately, Meta charges per conversation directly on your
              WhatsApp Business account. This is billed by Facebook and is{" "}
              <strong>not</strong> managed here.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-blue-700 mb-4">
              <div className="bg-white rounded-lg p-3 border border-blue-100">
                <p className="font-semibold mb-1">Marketing</p>
                <p>~₹0.88 / conversation</p>
              </div>
              <div className="bg-white rounded-lg p-3 border border-blue-100">
                <p className="font-semibold mb-1">Utility</p>
                <p>~₹0.125 / conversation</p>
              </div>
              <div className="bg-white rounded-lg p-3 border border-blue-100">
                <p className="font-semibold mb-1">Service (inbound)</p>
                <p>Free (first 1000/month)</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <a
                href="https://business.facebook.com/billing"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-900 underline"
              >
                <CreditCard className="w-4 h-4" />
                Pay Meta bill
                <ExternalLink className="w-3 h-3" />
              </a>
              <a
                href="https://developers.facebook.com/docs/whatsapp/pricing"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-900 underline"
              >
                <Info className="w-4 h-4" />
                Meta pricing details
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
