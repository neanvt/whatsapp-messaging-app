// Standalone unit-test harness for the pure resolveBodyPreview logic.
//
// Following the repo convention (see scripts/test-template-params.mjs), this
// script MIRRORS the pure functions from src/lib/template-params.ts inline
// using only Node built-ins (node:assert/strict) — no `@/` path-alias import,
// no TS loader, no new dependency. The mirrored logic MUST stay in sync with
// the shipped module. The AUTHORITATIVE gate for the shipped code is
// `npm run build` (prisma generate + next build typechecks the real module and
// all consumers) plus `npm run lint`; this script is extra coverage of the
// algorithm. Run with: node scripts/test-resolve-body-preview.mjs
import assert from "node:assert/strict";

// --- mirrored logic (keep in sync with src/lib/template-params.ts) ---------

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function parseTemplateBody(body) {
  if (!body) return { kind: "none" };
  const tokens = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) tokens.push(m[1]);
  if (tokens.length === 0) return { kind: "none" };
  const isNumeric = (t) => /^\d+$/.test(t);
  const named = tokens.some((t) => !isNumeric(t));
  if (named) {
    const seen = new Set();
    const names = [];
    for (const t of tokens) {
      if (!seen.has(t)) {
        seen.add(t);
        names.push(t);
      }
    }
    return { kind: "named", names };
  }
  const nums = new Set();
  for (const t of tokens) nums.add(t);
  return { kind: "numbered", count: nums.size };
}

function resolveBodyPreview(body, templateVariables) {
  if (!body) return "";

  let parsed = templateVariables;
  if (typeof templateVariables === "string") {
    try {
      parsed = JSON.parse(templateVariables);
    } catch {
      parsed = null;
    }
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? parsed
      : null;

  const model = parseTemplateBody(body);
  if (model.kind === "none") return body;

  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, token) => {
    let value;
    if (model.kind === "numbered") {
      if (Array.isArray(values)) {
        const idx = Number(token) - 1;
        if (idx >= 0 && idx < values.length) value = values[idx];
      }
    } else {
      if (Array.isArray(values)) {
        const i = model.names.indexOf(token);
        if (i >= 0 && i < values.length) value = values[i];
      } else if (values) {
        value = values[token];
      }
    }
    return value === undefined || value === null ? match : String(value);
  });
}

// --- tests ------------------------------------------------------------------

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

// null / empty body → ""
test("null/empty body → empty string", () => {
  assert.equal(resolveBodyPreview(null, ["x"]), "");
  assert.equal(resolveBodyPreview(undefined, ["x"]), "");
  assert.equal(resolveBodyPreview("", ["x"]), "");
});

// body with no placeholders → unchanged
test("no placeholders → body unchanged", () => {
  assert.equal(resolveBodyPreview("plain text", ["x"]), "plain text");
  assert.equal(resolveBodyPreview("plain text", null), "plain text");
});

// named body + record values → each {{name}} replaced (AC2)
test("named body + record → each name resolved", () => {
  assert.equal(
    resolveBodyPreview("Hi {{name}} at {{venue}}", {
      name: "Alice",
      venue: "Hall",
    }),
    "Hi Alice at Hall",
  );
});

// named body + null values → all {{name}} intact, no throw (AC3)
test("named body + null → placeholders intact", () => {
  assert.equal(
    resolveBodyPreview("Hi {{name}} at {{venue}}", null),
    "Hi {{name}} at {{venue}}",
  );
});

// numbered body + array values → {{k}} → values[k-1] in range (AC4)
test("numbered body + array → positional resolve", () => {
  assert.equal(
    resolveBodyPreview("Order {{1}} ships {{2}}", ["1234", "Monday"]),
    "Order 1234 ships Monday",
  );
});

// numbered body + record → nothing resolves
test("numbered body + record → nothing resolves", () => {
  assert.equal(
    resolveBodyPreview("Order {{1}}", { a: "x" }),
    "Order {{1}}",
  );
});

// missing key / index → placeholder intact
test("missing key/index → placeholder intact", () => {
  assert.equal(
    resolveBodyPreview("Hi {{name}} and {{other}}", { name: "A" }),
    "Hi A and {{other}}",
  );
  assert.equal(resolveBodyPreview("A {{1}} B {{2}}", ["only"]), "A only B {{2}}");
});

// malformed JSON string → treated as null (no throw)
test("malformed JSON string → treated as null", () => {
  assert.equal(
    resolveBodyPreview("Hi {{name}}", "{not json"),
    "Hi {{name}}",
  );
});

// JSON string forms are parsed and resolved
test("JSON string (array) parsed & resolved", () => {
  assert.equal(resolveBodyPreview("V {{1}}", '["42"]'), "V 42");
});
test("JSON string (object) parsed & resolved", () => {
  assert.equal(resolveBodyPreview("Hi {{n}}", '{"n":"Bob"}'), "Hi Bob");
});

// extra values ignored (AC5)
test("extra values ignored", () => {
  assert.equal(
    resolveBodyPreview("Order {{1}}", ["a", "b", "c"]),
    "Order a",
  );
  assert.equal(
    resolveBodyPreview("Hi {{name}}", { name: "A", extra: "B" }),
    "Hi A",
  );
});

// non-string value coerced via String
test("non-string value coerced via String", () => {
  assert.equal(resolveBodyPreview("N {{1}}", [42]), "N 42");
  assert.equal(resolveBodyPreview("B {{flag}}", { flag: true }), "B true");
});

// scalar JSON string collapses to null → placeholders intact
test("scalar JSON string → null → intact", () => {
  assert.equal(resolveBodyPreview("Hi {{name}}", "123"), "Hi {{name}}");
});

// named body + positional array → mapped by declared order
test("named body + positional array → declared order", () => {
  assert.equal(
    resolveBodyPreview("Hi {{name}} at {{venue}}", ["Alice", "Hall"]),
    "Hi Alice at Hall",
  );
});

// determinism: same input → same output
test("deterministic", () => {
  const a = resolveBodyPreview("Hi {{name}}", { name: "A" });
  const b = resolveBodyPreview("Hi {{name}}", { name: "A" });
  assert.equal(a, b);
});

// repeated calls with a global regex do not leak lastIndex state
test("repeated calls stable (no stateful regex leak)", () => {
  const body = "Hi {{1}} and {{2}}";
  assert.equal(resolveBodyPreview(body, ["x", "y"]), "Hi x and y");
  assert.equal(resolveBodyPreview(body, ["x", "y"]), "Hi x and y");
});

console.log(`\nAll ${passed} resolveBodyPreview tests passed.`);
