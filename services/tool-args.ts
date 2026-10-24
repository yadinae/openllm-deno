// Schema-aware repair of double-encoded tool-call arguments.
//
// Ported faithfully from FreeLLMAPI `lib/tool-args.ts` (202 lines) because the
// Responses API route (and /chat/completions via proxy-helpers) both need it:
// several free-tier models (GLM family) emit NESTED JSON inside tool arguments
// as a string: `{"plan": "[{\"step\":...}]"}` instead of `{"plan": [{...}]}`.
// Strict clients (Codex) reject the call. The gateway has the request's tool
// schemas, so it can repair this principled-ly: only when the schema says a
// parameter is an array/object AND the string value parses to exactly that JSON
// type. Never a guess, never a coercion, never anything invented.
//
// Also re-exports `stripSchemaKeys` + `toolSchemaMap`. The latter is imported by
// routes/responses.ts; stripSchemaKeys is shared infra that other routes can
// import once available.
//
// PORTING NOTE: this is self-contained pure logic with no FreeLLMAPI-specific
// deps — a straight port.

interface JsonSchemaish {
  type?: string;
  properties?: Record<string, JsonSchemaish>;
  items?: JsonSchemaish;
}

/**
 * Repair a tool call's `arguments` JSON string against the tool's parameter
 * schema. Returns the original string untouched whenever anything doesn't parse
 * or doesn't match — this must never corrupt a valid call.
 */
export function repairToolArguments(args: string, paramSchema?: JsonSchemaish): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }

  let changed = false;

  // Whole-arguments double encoding: `"{\"a\":1}"` parses to a string that is
  // itself JSON of an object. Unwrap one level.
  if (typeof parsed === "string") {
    try {
      const inner = JSON.parse(parsed);
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
        parsed = inner;
        changed = true;
      } else {
        return args;
      }
    } catch {
      return args;
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return changed ? JSON.stringify(parsed) : args;
  }

  if (repairInPlace(parsed, paramSchema)) changed = true;

  return changed ? JSON.stringify(parsed) : args;
}

/**
 * Decode `value` against the schema node that describes it, or return
 * `undefined` to mean "leave it alone". The gate is the whole design: the
 * schema must say `array` or `object`, and the string must parse to exactly
 * that. A parameter whose schema says `string` is never touched even when it
 * looks like JSON, an absent or type-less schema node is never guessed at.
 */
function decodeIfSchemaSays(value: string, schema: JsonSchemaish | undefined): unknown | undefined {
  const want = schema?.type;
  if (want !== "array" && want !== "object") return undefined;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return undefined;
  try {
    const inner = JSON.parse(trimmed);
    const isMatch = want === "array"
      ? Array.isArray(inner)
      : inner !== null && typeof inner === "object" && !Array.isArray(inner);
    return isMatch ? inner : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Walk a decoded value alongside its schema, decoding double-encoded strings
 * wherever the schema is unambiguous. Mutates `node` in place (it is always a
 * fresh JSON.parse result, never a caller's object). Recursion is the point:
 * a doubly-wrapped payload has doubly-wrapped nested members.
 */
function repairInPlace(node: unknown, schema: JsonSchemaish | undefined): boolean {
  if (node === null || typeof node !== "object") return false;

  let changed = false;

  if (Array.isArray(node)) {
    const itemSchema = schema?.items;
    if (!itemSchema) return false;
    for (let i = 0; i < node.length; i++) {
      const value = node[i];
      if (typeof value === "string") {
        const decoded = decodeIfSchemaSays(value, itemSchema);
        if (decoded !== undefined) {
          node[i] = decoded;
          changed = true;
          repairInPlace(decoded, itemSchema);
        }
      } else if (repairInPlace(value, itemSchema)) {
        changed = true;
      }
    }
    return changed;
  }

  const props = schema?.properties;
  if (!props) return false;

  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const child = props[key];
    if (!child) continue; // Unknown key — no schema to justify a change.
    if (typeof value === "string") {
      const decoded = decodeIfSchemaSays(value, child);
      if (decoded !== undefined) {
        obj[key] = decoded;
        changed = true;
        repairInPlace(decoded, child);
      }
    } else if (repairInPlace(value, child)) {
      changed = true;
    }
  }

  return changed;
}

/**
 * Recursively remove the given keys from a JSON-Schema-ish value. Used to drop
 * fields a provider's tool-schema validator rejects with a 400 (e.g.
 * `additionalProperties` / `$schema`). Returns a NEW value; never mutates.
 * (Sister of google.ts's `sanitizeForGemini`; here for provider-agnostic use.)
 */
export function stripSchemaKeys<T>(schema: T, keys: Set<string>): T {
  if (Array.isArray(schema)) {
    return schema.map((s) => stripSchemaKeys(s, keys)) as unknown as T;
  }
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (keys.has(k)) continue;
      out[k] = stripSchemaKeys(v, keys);
    }
    return out as unknown as T;
  }
  return schema;
}

/**
 * Build a tool-name → parameter-schema map from an OpenAI-style tools array
 * (chat-completions shape: {type:'function', function:{name, parameters}}).
 */
export function toolSchemaMap(
  tools?: Array<{ type?: string; function?: { name?: string; parameters?: unknown } }>,
): Map<string, JsonSchemaish> {
  const map = new Map<string, JsonSchemaish>();
  for (const t of tools ?? []) {
    const name = t.function?.name;
    if (t.type === "function" && name && t.function?.parameters && typeof t.function.parameters === "object") {
      map.set(name, t.function.parameters as JsonSchemaish);
    }
  }
  return map;
}

export type { JsonSchemaish };
