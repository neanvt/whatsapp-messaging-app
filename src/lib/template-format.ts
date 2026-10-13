// Shared helpers for formatting Template rows in the public /api/v1 responses.
// Kept out of the route files because Next.js route modules may only export
// HTTP method handlers (GET/POST/...), not arbitrary functions.

import { parseTemplateBody, namedParams } from "@/lib/template-params";

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
