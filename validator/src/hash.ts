/**
 * Canonical serialisation and a stable content hash.
 *
 * The hash is NOT cryptographic. It exists so that two certificates covering
 * the same puzzle, state and proofs produce the same short string -- that is
 * what makes "same input -> byte-identical output" checkable. It must not be
 * used for tamper-proofing or anything security-shaped.
 *
 * FNV-1a/64 is run twice with different offset bases and the two digests are
 * concatenated, giving 32 hex characters. Pure JS (BigInt only), so it works
 * in a browser and in a React Native JS engine -- no `node:crypto`.
 */

const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;
const BASIS_A = 0xcbf29ce484222325n;
const BASIS_B = 0x9e3779b97f4a7c15n;

function fnv1a64(input: string, basis: bigint): bigint {
  let hash = basis;
  // Encode as UTF-8 by hand: TextEncoder is a browser/Node global but not a
  // guaranteed one, and `unescape`/`escape` are deprecated.
  for (const byte of utf8Bytes(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

function hex64(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

/** 32 hex characters. Deterministic for a given string. */
export function stableHash(input: string): string {
  // Fold the length in so that different-length inputs cannot collide by
  // trailing-zero coincidence.
  const salted = `${input.length}:${input}`;
  return hex64(fnv1a64(salted, BASIS_A)) + hex64(fnv1a64(salted, BASIS_B));
}

/**
 * Deterministic JSON: object keys are sorted, `undefined` values are dropped,
 * arrays keep their order (array order is meaningful -- a witness plan is a
 * sequence). No whitespace.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) return "null";
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify((value as bigint).toString());
  if (t === "undefined" || t === "function" || t === "symbol") return "null";

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`);
  return `{${parts.join(",")}}`;
}
