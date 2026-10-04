import { createHash } from "node:crypto";

/**
 * Stable canonical JSON for frozen effect proposals (spec section 13).
 *
 * Rules:
 * - object keys are sorted (by UTF-16 code unit order) at every depth
 * - object properties whose value is `undefined` are omitted
 * - `undefined` anywhere it cannot be omitted (top level, array element) is rejected
 * - NaN / Infinity, functions, symbols, bigints are rejected
 * - only plain objects and arrays are accepted as containers (Date, Map, class
 *   instances, etc. are rejected; callers must convert them to strings first)
 * - `-0` is normalized to `0`
 * - strings are emitted byte-for-byte via JSON escaping (no Unicode normalization)
 *
 * The same logical value always yields the same string, regardless of key order.
 */

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "CanonicalizationError";
  }
}

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalize(value: unknown, path: string, seen: Set<object>): CanonicalJson {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number (${value})`, path);
      }
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
      throw new CanonicalizationError("undefined value", path);
    case "function":
      throw new CanonicalizationError("function value", path);
    case "symbol":
      throw new CanonicalizationError("symbol value", path);
    case "bigint":
      throw new CanonicalizationError("bigint value (encode as string)", path);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError("circular reference", path);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item, i) => normalize(item, `${path}[${i}]`, seen));
    }
    if (!isPlainObject(obj)) {
      const name = obj.constructor?.name ?? "unknown";
      throw new CanonicalizationError(`non-plain object (${name})`, path);
    }
    // Null prototype so a "__proto__" key is stored as data, not a prototype swap.
    const out: { [key: string]: CanonicalJson } = Object.create(null);
    for (const key of Object.keys(obj).sort()) {
      const child = obj[key];
      if (child === undefined) continue;
      out[key] = normalize(child, `${path}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Returns a normalized deep copy with sorted keys (useful for persisting canonical_args). */
export function canonicalize(value: unknown): CanonicalJson {
  return normalize(value, "$", new Set());
}

function serialize(value: CanonicalJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  // Serialize explicitly: JS engines enumerate integer-like keys ("2", "10")
  // before other keys, so relying on JSON.stringify would not be truly sorted.
  const parts = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${serialize(value[k])}`);
  return `{${parts.join(",")}}`;
}

/** Returns the canonical JSON string for a value. */
export function canonicalJson(value: unknown): string {
  return serialize(canonicalize(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type ProposalHashInput = {
  provider: string;
  action: string;
  /** Exact arguments that will be sent to the provider. */
  exactArgs: Record<string, unknown>;
  /** Resolved facts shown to the reviewer/user (e.g. price, business name). */
  materialFacts?: Record<string, unknown>;
};

/** The canonical string that a proposal hash commits to. */
export function proposalCanonicalString(input: ProposalHashInput): string {
  return canonicalJson({
    v: 1,
    provider: input.provider,
    action: input.action,
    exactArgs: input.exactArgs,
    materialFacts: input.materialFacts ?? {},
  });
}

/** "sha256:<hex>" over the canonical proposal. Any material change yields a new hash. */
export function proposalHash(input: ProposalHashInput): string {
  return `sha256:${sha256Hex(proposalCanonicalString(input))}`;
}
