import { DacsError } from "../errors.js";

/** CORE B.1 CF-3 identity. Parameters deliberately do not participate. */
export interface CanonicalClaimIdentity {
  scheme: string;
  identifier: string;
}

export interface CanonicalClaimReferenceParts {
  reference: string;
  identity: CanonicalClaimIdentity;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index]! - rightPoints[index]!;
    }
  }
  return leftPoints.length - rightPoints.length;
}

const RESERVED_PARAMETER_CHARACTERS = new Set([":", "?", "&", "=", "%"]);

function decodeCanonicalParameterSegment(value: string): string | null {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "%") {
      const encoded = value.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(encoded)) return null;
      const replacement = String.fromCharCode(Number.parseInt(encoded, 16));
      // CF-2 names the exact reserved set. Encoding an unreserved character
      // would create a second byte spelling for the same parameter.
      if (!RESERVED_PARAMETER_CHARACTERS.has(replacement)) return null;
      decoded += replacement;
      index += 2;
      continue;
    }
    if (RESERVED_PARAMETER_CHARACTERS.has(character)) return null;
    decoded += character;
  }
  return decoded;
}

/**
 * Parse only the exact CORE B.1 CF-2 byte form used in hashes/signatures.
 * This never rewrites a reference: non-canonical input is rejected.
 */
export function parseCanonicalClaimReference(
  value: unknown,
): CanonicalClaimReferenceParts | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.normalize("NFC") !== value ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  const colon = value.indexOf(":");
  if (colon <= 0 || !/^[a-z][a-z0-9-]*$/.test(value.slice(0, colon))) return null;
  const scheme = value.slice(0, colon);
  const remainder = value.slice(colon + 1);
  const question = remainder.indexOf("?");
  const identifier = question < 0 ? remainder : remainder.slice(0, question);
  if (!identifier || identifier.normalize("NFC") !== identifier) return null;
  if (question >= 0) {
    const query = remainder.slice(question + 1);
    if (!query) return null;
    const keys: string[] = [];
    for (const parameter of query.split("&")) {
      const equals = parameter.indexOf("=");
      if (equals <= 0 || equals !== parameter.lastIndexOf("=")) return null;
      const key = parameter.slice(0, equals);
      const entry = parameter.slice(equals + 1);
      const decodedKey = decodeCanonicalParameterSegment(key);
      if (decodedKey === null || decodeCanonicalParameterSegment(entry) === null ||
          keys.includes(decodedKey)) return null;
      keys.push(decodedKey);
    }
    if (keys.some((key, index) =>
      index > 0 && compareCodePoints(keys[index - 1]!, key) >= 0)) {
      return null;
    }
  }
  return Object.freeze({
    reference: value,
    identity: Object.freeze({ scheme, identifier }),
  });
}

export function isCanonicalClaimReference(value: unknown): value is string {
  return parseCanonicalClaimReference(value) !== null;
}

export function requireCanonicalClaimReference(
  value: unknown,
  label = "ClaimReference",
): CanonicalClaimReferenceParts {
  const parsed = parseCanonicalClaimReference(value);
  if (!parsed) throw new DacsError(`${label} must use canonical CORE B.1 CF-2 bytes`);
  return parsed;
}

/** CORE B.1 CF-3 comparison: scheme + identifier only; parameters are advisory. */
export function sameCanonicalClaimIdentity(left: unknown, right: unknown): boolean {
  const a = parseCanonicalClaimReference(left);
  const b = parseCanonicalClaimReference(right);
  return a !== null && b !== null &&
    a.identity.scheme === b.identity.scheme &&
    a.identity.identifier === b.identity.identifier;
}
