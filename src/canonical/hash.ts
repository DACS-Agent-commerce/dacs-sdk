import { createHash } from "node:crypto";

import { canonicalize } from "./jcs.js";
import { snapshotCanonicalJsonRead } from "./snapshot.js";

/** The artifact contract selects its signature field; unknown fields stay signed. */
export type SignatureField = "signature" | "signatures";

/** sha256 hex of a UTF-8 string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const data = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return createHash("sha256").update(data).digest("hex");
}

/** Return the document with its artifact-defined signature field omitted — the signed scope (§7.2). */
export function stripSignature<T extends Record<string, unknown>>(
  doc: T,
  signatureField: SignatureField = "signature",
): Partial<T> {
  const snapshot = snapshotCanonicalJsonRead(doc, "signed artifact");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("signed artifact must be a canonical JSON object");
  }

  // Object.fromEntries uses CreateDataProperty rather than [[Set]]. An own
  // `__proto__` member therefore remains ordinary signed data instead of
  // dispatching through Object.prototype.__proto__ and disappearing. The
  // canonical snapshot normalises CF-1 string values while preserving
  // member names exactly, and ensures the returned normal-prototype object owns
  // its complete graph.
  return Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== signatureField),
  ) as Partial<T>;
}

/** RFC 8785 canonical form of the signed scope (signature field omitted). */
export function canonicalSignedScope(
  doc: Record<string, unknown>,
  signatureField: SignatureField = "signature",
): string {
  return canonicalize(stripSignature(doc, signatureField));
}

/** Content hash: sha256 hex of the canonical form of the signed scope (§7.2). */
export function contentHash(
  doc: Record<string, unknown>,
  signatureField: SignatureField = "signature",
): string {
  return sha256Hex(canonicalSignedScope(doc, signatureField));
}
