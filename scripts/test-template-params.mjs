// Standalone unit-test harness for the pure template-parameter logic.
//
// Following the repo convention (see scripts/test-crypto.mjs), this script
// MIRRORS the pure functions from src/lib/template-params.ts inline using only
// Node built-ins (node:assert/strict) — no `@/` path-alias import, no TS
// loader, no new dependency (NFR2). The mirrored logic MUST stay byte-identical
// in behavior to the shipped module. The AUTHORITATIVE gate for the shipped
// code is `npm run build` (prisma generate + next build typechecks the real
// module and all consumers) plus `npm run lint`; this script is extra coverage
// of the algorithm. Run with: node scripts/test-template-params.mjs
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

function namedParams(body) {
  const m = parseTemplateBody(body);
  return m.kind === "named" ? m.names : [];
}

function countVariables(body) {
  const m = parseTemplateBody(body);
  return m.kind === "numbered" ? m.count : 0;
}

function resolveBodyParams(model, input) {
  const { name } = input;
  const variables = input.variables;
  const namedMap = input.namedParams;
  const hasNamedMap = !!namedMap && Object.keys(namedMap).length > 0;
  const hasPositional = Array.isArray(variables) && variables.length > 0;

  if (hasNamedMap && hasPositional) {
    return {
      ok: false,
      error:
        "Provide either 'variables' (positional) or the named parameter map, not both.",
    };
  }
  if (model.kind === "none") return { ok: true, resolved: { kind: "none" } };

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

  const names = model.names;
  if (hasNamedMap) {
    const providedKeys = Object.keys(namedMap);
    const missing = names.filter((n) => !(n in namedMap));
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
    const entries = names.map((n) => ({ name: n, value: namedMap[n] }));
    return { ok: true, resolved: { kind: "named", entries } };
  }
  if (hasPositional) {
    if (variables.length !== names.length) {
      return {
        ok: false,
        error: `Template '${name}' expects ${names.length} named parameter(s) in order [${names.join(
          ", ",
        )}]; received ${variables.length} positional value(s).`,
      };
    }
    const entries = names.map((n, i) => ({ name: n, value: variables[i] }));
    return { ok: true, resolved: { kind: "named", entries } };
  }
  return {
    ok: false,
    error: `Template '${name}' requires ${names.length} named parameter(s): [${names.join(
      ", ",
    )}].`,
  };
}

function buttonUrlIsDynamic(buttonsJson) {
  if (!buttonsJson) return false;
  let parsed;
  try {
    parsed = JSON.parse(buttonsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  for (const btn of parsed) {
    if (btn && typeof btn === "object") {
      const isUrl = typeof btn.type === "string" && btn.type.toUpperCase() === "URL";
      const url = typeof btn.url === "string" ? btn.url : "";
      if (isUrl && url.includes("{{")) return true;
    }
  }
  return false;
}

// --- tests ------------------------------------------------------------------

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

// parseTemplateBody
test("parseTemplateBody: named", () => {
  assert.deepEqual(parseTemplateBody("Hi {{guest_name}} at {{venue}}"), {
    kind: "named",
    names: ["guest_name", "venue"],
  });
});
test("parseTemplateBody: numbered", () => {
  assert.deepEqual(parseTemplateBody("Hi {{1}}, order {{2}}"), {
    kind: "numbered",
    count: 2,
  });
});
test("parseTemplateBody: none", () => {
  assert.deepEqual(parseTemplateBody("No placeholders here"), { kind: "none" });
  assert.deepEqual(parseTemplateBody(""), { kind: "none" });
  assert.deepEqual(parseTemplateBody(null), { kind: "none" });
});
test("parseTemplateBody: repeated name de-dups to first-occurrence order", () => {
  assert.deepEqual(parseTemplateBody("{{a}} {{b}} {{a}} {{c}}"), {
    kind: "named",
    names: ["a", "b", "c"],
  });
});
test("parseTemplateBody: mixed named+numeric classified as named", () => {
  assert.deepEqual(parseTemplateBody("{{1}} and {{name}}"), {
    kind: "named",
    names: ["1", "name"],
  });
});
test("parseTemplateBody: whitespace-tolerant tokens", () => {
  assert.deepEqual(parseTemplateBody("Hi {{ guest_name }}"), {
    kind: "named",
    names: ["guest_name"],
  });
});

// countVariables ≡ parseTemplateBody agreement (Finding 4)
test("countVariables agrees with parseTemplateBody on numbered bodies", () => {
  assert.equal(countVariables("Hi {{1}}, order {{2}}"), 2);
  assert.equal(countVariables("Only {{1}} and {{1}} again"), 1);
  assert.equal(countVariables("Hi {{guest_name}}"), 0);
  assert.equal(countVariables("plain"), 0);
});

// namedParams
test("namedParams: [] for numbered/none, names for named", () => {
  assert.deepEqual(namedParams("Hi {{1}}"), []);
  assert.deepEqual(namedParams("plain"), []);
  assert.deepEqual(namedParams("{{a}} {{b}}"), ["a", "b"]);
});

// resolveBodyParams — numbered
test("resolveBodyParams: numbered happy path", () => {
  const r = resolveBodyParams(
    { kind: "numbered", count: 2 },
    { variables: ["x", "y"], name: "t" },
  );
  assert.deepEqual(r, { ok: true, resolved: { kind: "numbered", values: ["x", "y"] } });
});
test("resolveBodyParams: numbered wrong count -> error", () => {
  const r = resolveBodyParams(
    { kind: "numbered", count: 2 },
    { variables: ["x"], name: "t" },
  );
  assert.equal(r.ok, false);
});
test("resolveBodyParams: numbered rejects named map", () => {
  const r = resolveBodyParams(
    { kind: "numbered", count: 1 },
    { namedParams: { a: "1" }, name: "t" },
  );
  assert.equal(r.ok, false);
});

// resolveBodyParams — named
const niqenNames = [
  "event",
  "guest_name",
  "event_name",
  "event_date",
  "venue_name",
  "allowed_guests",
];
const niqenModel = { kind: "named", names: niqenNames };

test("resolveBodyParams: named-map happy path emits declared order", () => {
  const r = resolveBodyParams(niqenModel, {
    namedParams: {
      allowed_guests: "6",
      event: "E",
      guest_name: "G",
      event_name: "N",
      event_date: "D",
      venue_name: "V",
    },
    name: "niqen_invite",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.resolved, {
    kind: "named",
    entries: [
      { name: "event", value: "E" },
      { name: "guest_name", value: "G" },
      { name: "event_name", value: "N" },
      { name: "event_date", value: "D" },
      { name: "venue_name", value: "V" },
      { name: "allowed_guests", value: "6" },
    ],
  });
});
test("resolveBodyParams: named-map missing key -> error", () => {
  const r = resolveBodyParams(niqenModel, {
    namedParams: { event: "E" },
    name: "niqen_invite",
  });
  assert.equal(r.ok, false);
});
test("resolveBodyParams: named-map extra key -> error", () => {
  const r = resolveBodyParams(
    { kind: "named", names: ["a"] },
    { namedParams: { a: "1", b: "2" }, name: "t" },
  );
  assert.equal(r.ok, false);
});
test("resolveBodyParams: positional for named maps by order", () => {
  const r = resolveBodyParams(niqenModel, {
    variables: ["E", "G", "N", "D", "V", "6"],
    name: "niqen_invite",
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.resolved.entries.map((e) => e.name), niqenNames);
  assert.deepEqual(r.resolved.entries.map((e) => e.value), ["E", "G", "N", "D", "V", "6"]);
});
test("resolveBodyParams: positional wrong count -> error", () => {
  const r = resolveBodyParams(niqenModel, { variables: ["E"], name: "niqen_invite" });
  assert.equal(r.ok, false);
});
test("resolveBodyParams: both forms -> error", () => {
  const r = resolveBodyParams(niqenModel, {
    variables: ["E"],
    namedParams: { event: "E" },
    name: "niqen_invite",
  });
  assert.equal(r.ok, false);
});
test("resolveBodyParams: none emits nothing", () => {
  const r = resolveBodyParams({ kind: "none" }, { variables: ["x"], name: "t" });
  assert.deepEqual(r, { ok: true, resolved: { kind: "none" } });
});

// buttonUrlIsDynamic
test("buttonUrlIsDynamic: dynamic URL -> true", () => {
  assert.equal(
    buttonUrlIsDynamic('[{"type":"URL","text":"RSVP","url":"https://x.com/{{1}}"}]'),
    true,
  );
});
test("buttonUrlIsDynamic: static URL -> false", () => {
  assert.equal(
    buttonUrlIsDynamic('[{"type":"URL","text":"Open","url":"https://x.com/home"}]'),
    false,
  );
});
test("buttonUrlIsDynamic: null/garbage -> false", () => {
  assert.equal(buttonUrlIsDynamic(null), false);
  assert.equal(buttonUrlIsDynamic("not json"), false);
  assert.equal(buttonUrlIsDynamic("{}"), false);
});

console.log(`\nAll ${passed} template-params tests passed.`);
