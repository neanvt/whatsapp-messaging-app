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
  documentBase64?: string;
  pdfBase64?: string;
  mediaBase64?: string;
  mediaId?: string;
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
    documentBase64,
    pdfBase64,
    mediaBase64,
    mediaId,
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
    const resolvedFilename = fileName || filename || "receipt.pdf";
    const rawBase64 = documentBase64 || pdfBase64 || mediaBase64;

    let headerMediaId = mediaId || null;

    if (!headerMediaId && rawBase64 && phoneNumberId && accessToken) {
      try {
        const cleanB64 = rawBase64.replace(/^data:[^;]+;base64,/, "");
        const buf = Buffer.from(cleanB64, "base64");
        const mimeType = headerType === "image" ? "image/jpeg" : headerType === "video" ? "video/mp4" : "application/pdf";
        const formData = new FormData();
        formData.append("messaging_product", "whatsapp");
        formData.append("type", mimeType);
        formData.append("file", new Blob([buf], { type: mimeType }), resolvedFilename);

        const upRes = await fetch(
          `https://graph.facebook.com/v19.0/${phoneNumberId}/media`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
            body: formData,
          },
        );
        const upData = await upRes.json();
        if (upData.id) {
          headerMediaId = upData.id;
          console.log("[Meta] Uploaded media to Meta, id:", headerMediaId);
        } else {
          console.warn("[Meta] Media upload returned without id:", upData);
        }
      } catch (upErr) {
        console.error("[Meta] Media upload exception:", upErr);
      }
    }

    if (headerMediaId) {
      const paramType = headerType === "image" ? "image" : headerType === "video" ? "video" : "document";
      const mediaObj = { id: headerMediaId };
      if (paramType === "document") {
        mediaObj.filename = resolvedFilename;
      }
      components.push({
        type: "header",
        parameters: [{ type: paramType, [paramType]: mediaObj }],
      });
    } else if (docUrl) {
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
                filename: resolvedFilename,
              },
            },
          ],
        });
      }
    } else if (headerType === "document") {
      try {
        const dummyPdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\nxref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n00000000101 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n");
        const formData = new FormData();
        formData.append("messaging_product", "whatsapp");
        formData.append("type", "application/pdf");
        formData.append("file", new Blob([dummyPdf], { type: "application/pdf" }), resolvedFilename);

        const upRes = await fetch(
          `https://graph.facebook.com/v19.0/${phoneNumberId}/media`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
            body: formData,
          },
        );
        const upData = await upRes.json();
        if (upData.id) {
          components.push({
            type: "header",
            parameters: [
              {
                type: "document",
                document: { id: upData.id, filename: resolvedFilename },
              },
            ],
          });
        }
      } catch (fallbackErr) {
        console.warn("[Meta] Fallback document upload failed:", fallbackErr);
      }
    } else if (headerType === "image") {
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
