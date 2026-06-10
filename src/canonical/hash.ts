import { createHash } from "node:crypto";

import { canonicalize } from "./jcs.js";

const SIGNATURE_FIELDS = ["signature", "signatures"];

/** sha256 hex of a UTF-8 string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return createHash("sha256").update(data).digest("hex");
}

/** Return the document with its signature field(s) omitted — the signed scope (§7.2). */
export function stripSignature<T extends Record<string, unknown>>(doc: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!SIGNATURE_FIELDS.includes(k)) out[k] = v;
  }
  return out as Partial<T>;
}

/** RFC 8785 canonical form of the signed scope (signature field omitted). */
export function canonicalSignedScope(doc: Record<string, unknown>): string {
  return canonicalize(stripSignature(doc));
}

/** Content hash: sha256 hex of the canonical form of the signed scope (§7.2). */
export function contentHash(doc: Record<string, unknown>): string {
  return sha256Hex(canonicalSignedScope(doc));
}
