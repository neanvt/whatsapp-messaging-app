// Pure, DB/network-free derivation and resolution of WhatsApp template body
// parameters. These functions take plain strings/objects in and return plain
// values — no Prisma, no fetch, no side effects — so they are unit-testable in
// isolation (NFR6) and shared by the send path, the templates route, and docs.
//
// Meta's Cloud API treats named-parameter and numbered templates as two distinct
// wire shapes:
//   - named: { type: "text", parameter_name: "<name>", text: "<value>" } and the
//     SET of parameter_names must EXACTLY equal the template's declared names.
//   - numbered: positional { type: "text", text: "<value>" } with no parameter_name.
// A template is "named" iff at least one placeholder token is non-numeric.

// The parameter model derived from a template body.
export type ParamModel =
  | { kind: "named"; names: string[] } // ordered, de-duplicated declared names
  | { kind: "numbered"; count: number } // distinct {{1}}..{{n}} count
  | { kind: "none" }; // no placeholders in body

// The canonical, resolved body shape passed to the component builder.
export type ResolvedBody =
  | { kind: "named"; entries: Array<{ name: string; value: string }> }
  | { kind: "numbered"; values: string[] }
  | { kind: "none" };

// Whitespace-tolerant placeholder scanner. Matches {{name}} and {{ name }}.
// This is the SINGLE scan used to classify named vs numbered vs none and to
// derive both the de-duplicated named order and the numbered count, so the two
// can never drift (design §4.1, Finding 4).
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function parseTemplateBody(
  body: string | null | undefined,
): ParamModel {
  if (!body) return { kind: "none" };

  const tokens: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    tokens.push(m[1]);
  }
  if (tokens.length === 0) return { kind: "none" };

  const isNumeric = (t: string) => /^\d+$/.test(t);
  const named = tokens.some((t) => !isNumeric(t));

  if (named) {
    // Keep first occurrence of each distinct name — the declared order (A1).
    const seen = new Set<string>();
    const names: string[] = [];
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        names.push(t);
      }
    }
    return { kind: "named", names };
  }

  // Numbered: count = size of the Set of numeric tokens from this SAME scan.
  const nums = new Set<string>();
  for (const t of tokens) nums.add(t);
  return { kind: "numbered", count: nums.size };
}

// Ordered, de-duplicated declared named parameters ([] for numbered/none).
// Shared by the templates route and docs so the derivation is single-sourced.
export function namedParams(body: string | null | undefined): string[] {
  const m = parseTemplateBody(body);
  return m.kind === "named" ? m.names : [];
}

// Resolve the two public-API input forms (positional `variables` or a named
// `namedParams` map) to ONE canonical ResolvedBody, validating against the
// template's declared parameter model. Pure: `name` (the template name) is
// passed in so error strings can reference it without any DB/network reach
// (design §4.2, Finding 9). Returns the Meta-style, secret-free error strings.
export function resolveBodyParams(
  model: ParamModel,
  input: {
    variables?: string[];
    namedParams?: Record<string, string>;
    name: string;
  },
): { ok: true; resolved: ResolvedBody } | { ok: false; error: string } {
  const { name } = input;
  const variables = input.variables;
  const namedMap = input.namedParams;
  const hasNamedMap = !!namedMap && Object.keys(namedMap).length > 0;
  const hasPositional = Array.isArray(variables) && variables.length > 0;

  // Defensive: a request must never be interpretable as both forms (FR1.5).
  if (hasNamedMap && hasPositional) {
    return {
      ok: false,
      error:
        "Provide either 'variables' (positional) or the named parameter map, not both.",
    };
  }

  if (model.kind === "none") {
    // No declared params — emit nothing regardless of supplied values.
    return { ok: true, resolved: { kind: "none" } };
  }

  if (model.kind === "numbered") {
    if (hasNamedMap) {
      return {
        ok: false,
        error: `Template '${name}' uses numbered placeholders; send a positional 'variables' array of ${model.count} value(s), not a named map.`,
      };
    }
    const vals = variables ?? [];
    if (vals.length !== model.count) {
      return {
        ok: false,
        error: `Template '${name}' expects ${model.count} variable(s); received ${vals.length}.`,
      };
    }
    return { ok: true, resolved: { kind: "numbered", values: vals } };
  }

  // model.kind === "named"
  const names = model.names;

  if (hasNamedMap) {
    const providedKeys = Object.keys(namedMap!);
    const missing = names.filter((n) => !(n in namedMap!));
    const unknown = providedKeys.filter((k) => !names.includes(k));
    if (missing.length > 0 || unknown.length > 0) {
      return {
        ok: false,
        error: `Template '${name}' requires named parameter(s) [${names.join(
          ", ",
        )}]; received [${providedKeys.join(", ")}]${
          missing.length ? `; missing [${missing.join(", ")}]` : ""
        }${unknown.length ? `; unexpected [${unknown.join(", ")}]` : ""}.`,
      };
    }
    const entries = names.map((n) => ({ name: n, value: namedMap![n] }));
    return { ok: true, resolved: { kind: "named", entries } };
  }

  if (hasPositional) {
    // Positional count is validated against the DISTINCT declared name count
    // (names is already de-duplicated), never raw occurrences (Finding 5).
    if (variables!.length !== names.length) {
      return {
        ok: false,
        error: `Template '${name}' expects ${names.length} named parameter(s) in order [${names.join(
          ", ",
        )}]; received ${variables!.length} positional value(s).`,
      };
    }
    const entries = names.map((n, i) => ({ name: n, value: variables![i] }));
    return { ok: true, resolved: { kind: "named", entries } };
  }

  // Neither form supplied for a named template.
  return {
    ok: false,
    error: `Template '${name}' requires ${names.length} named parameter(s): [${names.join(
      ", ",
    )}].`,
  };
}

// True iff the template's buttons JSON declares a URL button whose `url`
// contains a {{...}} variable (i.e. a dynamic URL button). Parses defensively —
// never throws; treats null/garbage as "no dynamic button". index resolution is
// out of scope: a dynamic URL button is assumed to be the single button at
// index 0 (design §5.4, Finding 8).
export function buttonUrlIsDynamic(buttonsJson: string | null): boolean {
  if (!buttonsJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(buttonsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  for (const btn of parsed) {
    if (btn && typeof btn === "object") {
      const b = btn as { type?: unknown; url?: unknown };
      const isUrl =
        typeof b.type === "string" && b.type.toUpperCase() === "URL";
      const url = typeof b.url === "string" ? b.url : "";
      if (isUrl && url.includes("{{")) return true;
    }
  }
  return false;
}
