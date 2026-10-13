import { createClient } from "@libsql/client";
import crypto from "crypto";
// Shared send core, extracted byte-for-byte from the former POST /api/messages/send
// route body. Both the session route and the public /api/v1 route call this so the two
// paths can never drift. Returns a plain result object — never a NextResponse — and never
// reads a session. isSuperAdmin is computed ONCE by the caller and passed through check,
// deduct, and refund so the credit math stays symmetric.
import prisma from "@/lib/db";
import { resolveSendCredentials } from "@/lib/whatsapp";
import {
  parseTemplateBody,
  resolveBodyParams,
  buttonUrlIsDynamic,
} from "@/lib/template-params";
import type { WhatsAppNumber, Template } from "@prisma/client";

export interface SendTemplateInput {
  userId: string;
  number: WhatsAppNumber; // already verified + owned by userId by the caller
  template: Template; // already resolved + approved + owned by userId by the caller
  recipient: string;
  variables?: string[];
  namedParams?: Record<string, string>; // named-map form from the public API; undefined for session route
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
    namedParams,
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

  // Pre-charge validation gate — PURE string/presence checks only (no DB write,
  // no network, no media upload). A 400 here returns BEFORE any credit deduction
  // and BEFORE any message/MediaStore row is created, so a validation failure can
  // never orphan a row or mis-charge a credit (design §5.1).

  // (a) BODY param resolution — pure (string in, value out). Validates the
  // provided variables/named map against the template's declared parameters.
  const paramModel = parseTemplateBody(template.body);
  const bodyResolution = resolveBodyParams(paramModel, {
    variables,
    namedParams,
    name: template.name,
  });
  if (!bodyResolution.ok) {
    return { ok: false, code: 400, error: bodyResolution.error };
  }
  const resolvedBody = bodyResolution.resolved;

  // (b) HEADER presence check — pure (NO upload, NO DB write; mediaId is NOT
  // counted as a source since it is never read in component construction).
  const gateHeaderType = (template.headerType || "").toLowerCase();
  const isMediaHeader =
    gateHeaderType === "image" ||
    gateHeaderType === "video" ||
    gateHeaderType === "document";
  const hasHeaderMediaSource = !!(
    documentUrl ||
    mediaUrl ||
    documentBase64 ||
    pdfBase64 ||
    mediaBase64
  );
  if (isMediaHeader && !hasHeaderMediaSource) {
    return {
      ok: false,
      code: 400,
      error: `Template '${template.name}' has a ${gateHeaderType} header; provide 'mediaUrl' (or 'documentUrl'/base64) for the header media.`,
    };
  }

  // (c) BUTTON dynamic-but-missing-value check — pure. Authentication templates
  // carry a copy-code button fed from variables[0] (handled separately), so they
  // are exempt from this generic dynamic-URL-button check.
  const buttonIsDynamic = buttonUrlIsDynamic(template.buttons);
  const gateBtnParam = buttonParam || buttonUrlParam;
  const isAuthTemplate = template.category === "authentication";
  if (!isAuthTemplate && buttonIsDynamic && !gateBtnParam) {
    return {
      ok: false,
      code: 400,
      error: `Template '${template.name}' has a dynamic URL button; provide 'buttonParam' (the URL suffix/value).`,
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
    let docUrl = documentUrl || mediaUrl;
    const headerType = (template.headerType || "").toLowerCase();
    const resolvedFilename = fileName || filename || "receipt.pdf";
    const rawBase64 = documentBase64 || pdfBase64 || mediaBase64;

    if (!docUrl && rawBase64) {
      try {
        const mid = "med_" + crypto.randomUUID().replace(/-/g, "");
        const mimeType = headerType === "image" ? "image/jpeg" : headerType === "video" ? "video/mp4" : "application/pdf";
        const client = createClient({
          url: process.env.TURSO_DATABASE_URL!,
          authToken: process.env.TURSO_AUTH_TOKEN,
        });
        await client.execute({
          sql: "INSERT INTO MediaStore (id, mimeType, filename, dataBase64, createdAt) VALUES (?, ?, ?, ?, ?)",
          args: [mid, mimeType, resolvedFilename, rawBase64, new Date().toISOString()],
        });
        const appBase = process.env.NEXTAUTH_URL || "https://wa-neanv.vercel.app";
        docUrl = `${appBase.replace(/\/+$/, "")}/api/v1/media/${mid}`;
        console.log("[Send] Stored base64 in MediaStore, docUrl:", docUrl);
      } catch (storeErr) {
        console.error("[Send] MediaStore insert error:", storeErr);
      }
    }

    // HEADER: emit a header component ONLY for a real media header
    // (image/video/document) with a resolved media URL. The pre-charge gate
    // already guaranteed a media source is present; the base64 upload above is
    // the only MediaStore write and runs post-charge. No dummy fallback image /
    // dummy PDF is ever injected (design §5.3).
    const isMediaHeaderType =
      headerType === "image" ||
      headerType === "video" ||
      headerType === "document";
    if (isMediaHeaderType && docUrl) {
      if (headerType === "image") {
        const safeLink =
          docUrl.startsWith("http://localhost") || docUrl.startsWith("http://127.0.0.1")
            ? "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=1200"
            : docUrl;
        components.push({
          type: "header",
          parameters: [{ type: "image", image: { link: safeLink } }],
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
    } else if (isMediaHeaderType && !docUrl) {
      // Media header declared but the source failed to resolve (e.g. base64
      // upload threw above). This is NOT a validation 400 (we passed the
      // pre-charge presence gate); funnel into the existing failed+refund path.
      finalStatus = "failed";
      errorMessage = `Template '${template.name}' has a ${headerType} header but its media could not be resolved.`;
    }

    // BODY: emit named parameters (parameter_name + text) in declared order for
    // a named template, positional (text only, no parameter_name) for a numbered
    // template, or nothing for a no-param body (design §5.2).
    if (finalStatus !== "failed") {
      if (resolvedBody.kind === "named") {
        components.push({
          type: "body",
          parameters: resolvedBody.entries.map((e) => ({
            type: "text",
            parameter_name: e.name,
            text: e.value,
          })),
        });
      } else if (
        resolvedBody.kind === "numbered" &&
        resolvedBody.values.length > 0
      ) {
        components.push({
          type: "body",
          parameters: resolvedBody.values.map((v) => ({
            type: "text",
            text: v,
          })),
        });
      }
      // resolvedBody.kind === "none" → no body component (unchanged behavior).

      // Authentication templates carry a copy-code URL button that requires
      // the OTP code as its parameter; without it Meta returns (#131008). This
      // fires from variables[0] independent of resolvedBody.kind (design §5.4).
      if (template.category === "authentication" && variables?.[0]) {
        components.push({
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: variables[0] }],
        });
      } else if (
        template.category !== "authentication" &&
        (buttonUrlIsDynamic(template.buttons) || Boolean(buttonParam || buttonUrlParam))
      ) {
        // Dynamic URL button (general, structure-driven). The pre-charge gate
        // guaranteed buttonParam is present when the button is dynamic. No
        // niqen_invite name check and no literal "rsvp" fallback (design §5.4).
        const btnParam = buttonParam || buttonUrlParam;
        if (btnParam) {
          components.push({
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: btnParam }],
          });
        }
      }
    }

    // Skip the Meta round-trip if header media resolution already failed above
    // (post-charge failure routed to the refund path below).
    if (finalStatus !== "failed") {
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
        const baseMsg =
          metaData.error?.message ?? "Failed to send via Meta API";
        errorMessage = details ? `${baseMsg}: ${details}` : baseMsg;
      } else {
        metaMessageId = metaData.messages?.[0]?.id ?? null;
        console.log("[Meta] Message sent, id:", metaMessageId);
      }
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
