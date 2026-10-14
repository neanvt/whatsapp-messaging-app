// Shared helpers for formatting Template rows in the public /api/v1 responses.
// Kept out of the route files because Next.js route modules may only export
// HTTP method handlers (GET/POST/...), not arbitrary functions.

import {
  parseTemplateBody,
  namedParams,
  resolveBodyPreview,
} from "@/lib/template-params";

// Re-export the ordered, de-duplicated declared named parameters so the
// templates route and docs share one derivation (design §4.1).
export { namedParams };

// Count the distinct numbered {{n}} placeholders in a template body so an
// integration knows how many positional `variables` to pass to
// POST /api/v1/messages. Delegates to parseTemplateBody so the numbered count
// has a single source of truth (design §4.1, Finding 4). Returns 0 for named
// or no-placeholder bodies, preserving the prior numeric-only behavior.
export function countVariables(body: string | null | undefined): number {
  const m = parseTemplateBody(body);
  return m.kind === "numbered" ? m.count : 0;
}

// Parse a stored JSON string column (e.g. buttons) defensively — never throw.
export function parseJsonColumn(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// The exact Prisma `select` shape both public message routes feed into the
// shared shaper below (list + single [id]). Keeping it as an interface pins the
// select on both ends so the two routes can never drift (design §3.6/§3.7).
export interface PublicMessageRow {
  id: string;
  recipientPhone: string;
  templateId: string | null;
  status: string;
  metaMessageId: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  direction: string;
  templateVariables: string | null;
  template: { name: string; body: string | null } | null;
}

// Shape a Message row for the public /api/v1 responses so the LIST and the
// single [id] route return byte-identical field names and parsing (design
// §3.7). parseJsonColumn (defined above, same module) never throws and returns
// `unknown`; a legacy/malformed write could be a JSON scalar, so NORMALIZE to
// the documented array | record | null type before BOTH returning it and
// feeding resolveBodyPreview — never leak a raw scalar.
export function shapePublicMessage(m: PublicMessageRow) {
  const raw = parseJsonColumn(m.templateVariables);
  const vars: string[] | Record<string, string> | null = Array.isArray(raw)
    ? (raw as string[])
    : raw && typeof raw === "object"
      ? (raw as Record<string, string>)
      : null;
  return {
    id: m.id,
    recipientPhone: m.recipientPhone,
    templateId: m.templateId,
    templateName: m.template?.name ?? null,
    status: m.status,
    metaMessageId: m.metaMessageId,
    errorMessage: m.errorMessage,
    sentAt: m.sentAt,
    deliveredAt: m.deliveredAt,
    readAt: m.readAt,
    createdAt: m.createdAt,
    direction: m.direction,
    templateVariables: vars,
    bodyPreview: resolveBodyPreview(m.template?.body, vars),
  };
}
