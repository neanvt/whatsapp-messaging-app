// Shared helpers for formatting Template rows in the public /api/v1 responses.
// Kept out of the route files because Next.js route modules may only export
// HTTP method handlers (GET/POST/...), not arbitrary functions.

// Count the distinct {{n}} placeholders in a template body so an integration
// knows how many `variables` values to pass to POST /api/v1/messages.
export function countVariables(body: string | null | undefined): number {
  if (!body) return 0;
  const matches = body.match(/\{\{\s*\d+\s*\}\}/g);
  if (!matches) return 0;
  const nums = new Set(
    matches.map((m) => m.replace(/[^\d]/g, "")).filter(Boolean),
  );
  return nums.size;
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
