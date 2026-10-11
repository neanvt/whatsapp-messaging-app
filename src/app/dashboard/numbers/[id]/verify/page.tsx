"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

interface VerifyPageProps {
  params: { id: string };
}

// The old manual OTP/dev-code flow is gone. Numbers are connected via Embedded
// Signup or manual credentials, so this route just redirects to the detail page
// (which carries the single "Refresh status" action).
export default function VerifyNumberPage({ params }: VerifyPageProps) {
  const router = useRouter();

  useEffect(() => {
    router.replace(`/dashboard/numbers/${params.id}`);
  }, [params.id, router]);

  return (
    <div className="flex items-center justify-center py-12">
      <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );
}
