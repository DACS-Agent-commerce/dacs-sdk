import { createHash } from "node:crypto";

import { canonicalize } from "./jcs.js";
import { snapshotCanonicalJsonRead } from "./snapshot.js";

const SIGNATURE_FIELDS = ["signature", "signatures"];

/** sha256 hex of a UTF-8 string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return createHash("sha256").update(data).digest("hex");
}

/** Return the document with its signature field(s) omitted — the signed scope (§7.2). */
export function stripSignature<T extends Record<string, unknown>>(doc: T): Partial<T> {
  const snapshot = snapshotCanonicalJsonRead(doc, "signed artifact");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("signed artifact must be a canonical JSON object");
  }

  // Object.fromEntries uses CreateDataProperty rather than [[Set]]. An own
  // `__proto__` member therefore remains ordinary signed data instead of
  // dispatching through Object.prototype.__proto__ and disappearing. The
  // canonical snapshot also normalises CF-1 aliases, catches key collisions,
  // and ensures the returned normal-prototype object owns its complete graph.
  return Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !SIGNATURE_FIELDS.includes(key)),
  ) as Partial<T>;
}

/** RFC 8785 canonical form of the signed scope (signature field omitted). */
export function canonicalSignedScope(doc: Record<string, unknown>): string {
  return canonicalize(stripSignature(doc));
}

/** Content hash: sha256 hex of the canonical form of the signed scope (§7.2). */
export function contentHash(doc: Record<string, unknown>): string {
  return sha256Hex(canonicalSignedScope(doc));
}
