// Shared send core, extracted byte-for-byte from the former POST /api/messages/send
// route body. Both the session route and the public /api/v1 route call this so the two
// paths can never drift. Returns a plain result object — never a NextResponse — and never
// reads a session. isSuperAdmin is computed ONCE by the caller and passed through check,
// deduct, and refund so the credit math stays symmetric.
import prisma from "@/lib/db";
import { resolveSendCredentials } from "@/lib/whatsapp";
import type { WhatsAppNumber, Template } from "@prisma/client";

export interface SendTemplateInput {
  userId: string;
  number: WhatsAppNumber; // already verified + owned by userId by the caller
  template: Template; // already resolved + approved + owned by userId by the caller
  recipient: string;
  variables?: string[];
  mediaUrl?: string;
  documentUrl?: string;
  fileName?: string;
  filename?: string;
  buttonParam?: string;
  buttonUrlParam?: string;
  isSuperAdmin: boolean; // caller supplies; computed ONCE by the caller
}

export type SendTemplateResult =
  | {
      ok: true;
      message: { id: string; status: "sent"; metaMessageId: string | null };
    }
  | { ok: false; code: number; error: string };

export async function sendTemplateMessage(
  input: SendTemplateInput,
): Promise<SendTemplateResult> {
  const {
    userId,
    number,
    template,
    recipient,
    variables,
    mediaUrl,
    documentUrl,
    fileName,
    filename,
    buttonParam,
    buttonUrlParam,
    isSuperAdmin,
  } = input;

  // Authentication templates require the OTP code as the first variable.
  // Guard here — before any message record or credit deduction — so a
  // missing OTP never leaves a dangling message row or a mis-deducted credit.
  if (template.category === "authentication" && !variables?.[0]) {
    return {
      ok: false,
      code: 400,
      error: "OTP code variable required for authentication template",
    };
  }

  // Superadmin has unlimited credits — skip balance check
  if (!isSuperAdmin) {
    const userCredits = await prisma.userCredits.findUnique({
      where: { userId },
    });
    if (!userCredits || userCredits.totalCredits <= 0) {
      return { ok: false, code: 402, error: "Insufficient credits" };
    }
  }

  // Create message record
  const message = await prisma.message.create({
    data: {
      userId,
      whatsappNumberId: number.id,
      templateId: template.id,
      recipientPhone: recipient,
      templateVariables: variables?.length ? JSON.stringify(variables) : null,
      status: "queued",
    },
  });

  // Deduct credit (superadmin is exempt)
  if (!isSuperAdmin) {
    await prisma.userCredits.update({
      where: { userId },
      data: {
        totalCredits: { decrement: 1 },
        usedCredits: { increment: 1 },
      },
    });
  }

  // Resolve this number own per-tenant Meta credentials (decrypted from the
  // number record — no env fallback). A missing token or a decrypt/config
  // throw leaves both null so we funnel into the failed + refund branch below.
  let phoneNumberId: string | null = null;
  let accessToken: string | null = null;
  try {
    ({ phoneNumberId, accessToken } = resolveSendCredentials(number));
  } catch {
    console.error("[Send] credential resolution failed (encryption/config)");
    phoneNumberId = null;
    accessToken = null;
  }

  let metaMessageId: string | null = null;
  let finalStatus = "sent";
  let errorMessage: string | null = null;

  if (!phoneNumberId || !accessToken) {
    console.warn(
      "[Meta] WhatsApp number has no stored credentials — reconnect it via Embedded Signup or manual connect",
    );
    finalStatus = "failed";
    errorMessage =
      "WhatsApp number is not connected. Reconnect it to send messages.";
  } else {
    // Build template components for header media, body variables, and buttons
    const components: object[] = [];
    const docUrl = documentUrl || mediaUrl;
    const headerType = (template.headerType || "").toLowerCase();

    if (docUrl) {
      if (headerType === "image") {
        components.push({
          type: "header",
          parameters: [{ type: "image", image: { link: docUrl } }],
        });
      } else if (headerType === "video") {
        components.push({
          type: "header",
          parameters: [{ type: "video", video: { link: docUrl } }],
        });
      } else {
        components.push({
          type: "header",
          parameters: [
            {
              type: "document",
              document: {
                link: docUrl,
                filename: fileName || filename || "receipt.pdf",
              },
            },
          ],
        });
      }
    } else if (headerType === "image") {
      // Default placeholder if template strictly requires an image header
      components.push({
        type: "header",
        parameters: [
          {
            type: "image",
            image: {
              link: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=1200",
            },
          },
        ],
      });
    }

    const vars: string[] = variables?.length ? variables : [];
    if (vars.length > 0) {
      // Inspect template.body to detect if template was created with NAMED parameters
      // e.g. {{guest_name}} or numeric {{1}}
      const namedMatches = Array.from(
        (template.body || "").matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g),
      ).map((m) => m[1]);
      const isNamed = namedMatches.some((name) => isNaN(Number(name)));

      if (isNamed) {
        components.push({
          type: "body",
          parameters: vars.map((v: string, idx: number) => ({
            type: "text",
            parameter_name: namedMatches[idx] || `param_${idx + 1}`,
            text: v,
          })),
        });
      } else {
        components.push({
          type: "body",
          parameters: vars.map((v: string) => ({ type: "text", text: v })),
        });
      }
    }

    // Authentication templates carry a copy-code URL button that requires
    // the OTP code as its parameter; without it Meta returns (#131008).
    if (template.category === "authentication" && variables?.[0]) {
      components.push({
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: variables[0] }],
      });
    } else {
      // URL buttons with dynamic variables (e.g. niqen_invite or custom dynamic buttons)
      const btnParam = buttonParam || buttonUrlParam;
      if (btnParam) {
        components.push({
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: btnParam }],
        });
      } else if (
        template.name === "niqen_invite" ||
        (template.buttons && template.buttons.includes("{{"))
      ) {
        components.push({
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: "rsvp" }],
        });
      }
    }

    const metaPayload = {
      messaging_product: "whatsapp",
      to: recipient.replace(/\D/g, ""), // strip non-digits
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language ?? "en" },
        ...(components.length > 0 ? { components } : {}),
      },
    };

    console.log(
      "[Meta] Sending message:",
      JSON.stringify(metaPayload, null, 2),
    );

    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metaPayload),
      },
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error("[Meta] Send error:", metaData);
      finalStatus = "failed";
      const details = metaData.error?.error_data?.details;
      const baseMsg = metaData.error?.message ?? "Failed to send via Meta API";
      errorMessage = details ? `${baseMsg}: ${details}` : baseMsg;
    } else {
      metaMessageId = metaData.messages?.[0]?.id ?? null;
      console.log("[Meta] Message sent, id:", metaMessageId);
    }
  }

  // Update message record with result
  await prisma.message.update({
    where: { id: message.id },
    data: {
      status: finalStatus,
      sentAt: finalStatus === "sent" ? new Date() : undefined,
      metaMessageId,
      errorMessage,
    },
  });

  if (finalStatus === "failed") {
    // Refund the credit since send failed (superadmin not charged in the first place)
    if (!isSuperAdmin) {
      await prisma.userCredits.update({
        where: { userId },
        data: {
          totalCredits: { increment: 1 },
          usedCredits: { decrement: 1 },
        },
      });
    }
    return {
      ok: false,
      code: 500,
      error: errorMessage ?? "Failed to send message",
    };
  }

  return {
    ok: true,
    message: { id: message.id, status: "sent", metaMessageId },
  };
}
