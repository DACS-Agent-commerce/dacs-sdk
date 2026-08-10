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
  // Define descriptors directly so an own `__proto__` remains signed data and
  // accessors/non-enumerable/symbol properties remain visible to canonicalize's
  // JSON-domain rejection. Assigning keys to `{}` would invoke the legacy
  // prototype setter; Object.entries would silently erase those invalid forms.
  const out = Object.create(Object.getPrototypeOf(doc)) as Record<
    PropertyKey,
    unknown
  >;
  for (const key of Reflect.ownKeys(doc)) {
    if (typeof key === "string" && SIGNATURE_FIELDS.includes(key)) continue;
    Object.defineProperty(out, key, Object.getOwnPropertyDescriptor(doc, key)!);
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
