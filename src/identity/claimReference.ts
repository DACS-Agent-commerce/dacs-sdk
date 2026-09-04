import { DacsError } from "../errors.js";
import { isCanonicalDomainHostname } from "./domainHost.js";

/** CORE B.1 CF-3 identity. Parameters deliberately do not participate. */
export interface CanonicalClaimIdentity {
  scheme: string;
  identifier: string;
}

export type ClaimReferenceSchemeStatus = "registered" | "unknown";

export interface CanonicalClaimReferenceParts {
  reference: string;
  identity: CanonicalClaimIdentity;
  /** DACS-1 §6.3.1 registry classification; unknown references remain verbatim. */
  schemeStatus: ClaimReferenceSchemeStatus;
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
const UINT256_MAX = (1n << 256n) - 1n;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const CCI_WEB2_PLATFORMS = new Set([
  "twitter",
  "github",
  "discord",
  "telegram",
]);
const CCI_PQC_ALGORITHMS = new Set(["falcon", "ml-dsa"]);
// DACS-1 §6.3.1 closes this registry for v0.1. The cci-lei/finra/sam/
// fedramp/naics/cmmc contexts are deliberately absent: their native CCI
// variants are deferred, while the corresponding unprefixed schemes are live.
const REGISTERED_CLAIM_REFERENCE_SCHEMES = new Set([
  "cci-xm",
  "cci-web2",
  "cci-pqc",
  "cci-ud",
  "cci-nomis",
  "cci-humanpassport",
  "cci-ethos",
  "cci-tlsn",
  "lei",
  "finra-crd",
  "sam-uei",
  "fedramp",
  "naics",
  "cmmc",
  "stor-cred",
  "did",
  "erc8004",
  "domain",
  "key",
  "substrate-validator-set",
]);

function hasNonEmptyComponents(identifier: string, count: number): boolean {
  let start = 0;
  for (let component = 1; component < count; component += 1) {
    const separator = identifier.indexOf(":", start);
    if (separator <= start) return false;
    start = separator + 1;
  }
  return start < identifier.length;
}

function canonicalRegisteredIdentifier(
  scheme: string,
  identifier: string,
  hasParameters: boolean,
): boolean {
  switch (scheme) {
    case "did": {
      const methodSeparator = identifier.indexOf(":");
      if (methodSeparator <= 0 ||
          !/^[a-z0-9]+$/.test(identifier.slice(0, methodSeparator))) {
        return false;
      }
      // DACS-1 §6.3.1 registers the self-certifying *agent* profile without
      // claiming that every other DID under the Demos method has that shape.
      // Historical Standard vectors use ordinary resolver-backed Demos DIDs
      // such as `did:demos:buyer`; those remain canonical generic DIDs. Once a
      // value opts into `demos:agent:`, however, the profile's exact lower-case
      // 32-byte key rule applies and malformed lookalikes must fail closed.
      if (identifier.startsWith("demos:agent:")) {
        return /^demos:agent:[0-9a-f]{64}$/.test(identifier);
      }
      return identifier.slice(methodSeparator + 1).length > 0;
    }
    case "domain":
      // DACS-1 DCR-2 deliberately excludes URL query syntax from the
      // hostname-only profile, even though other ClaimReference schemes may
      // carry advisory parameters.
      return !hasParameters && isCanonicalDomainHostname(identifier);
    case "key":
      return /^[0-9a-f]+$/.test(identifier);
    case "erc8004": {
      const match = /^([1-9][0-9]*):(0x[0-9a-f]{40}):(0|[1-9][0-9]*)$/.exec(
        identifier,
      );
      if (!match) return false;
      try {
        return BigInt(match[3]!) <= UINT256_MAX;
      } catch {
        return false;
      }
    }
    case "cci-xm": {
      if (!hasNonEmptyComponents(identifier, 3)) return false;
      const separator = identifier.indexOf(":");
      const family = identifier.slice(0, separator);
      // The strict lowercase `evm:<positive-chain-id>:<address>` form is the
      // DACS-4 PB-2 eligibility predicate, not the generic ClaimReference
      // grammar. Historical/name-style EVM coordinates remain readable as
      // cci-xm claims but do not establish an EIP-155 match.
      if (family === "solana") {
        const match = /^solana:([^:]+):([^:]+)$/.exec(identifier);
        return match !== null && BASE58.test(match[2]!);
      }
      return true;
    }
    case "cci-web2": {
      const separator = identifier.indexOf(":");
      return separator > 0 &&
        CCI_WEB2_PLATFORMS.has(identifier.slice(0, separator)) &&
        separator + 1 < identifier.length;
    }
    case "cci-pqc": {
      const separator = identifier.indexOf(":");
      return separator > 0 &&
        CCI_PQC_ALGORITHMS.has(identifier.slice(0, separator)) &&
        separator + 1 < identifier.length;
    }
    case "stor-cred":
      return hasNonEmptyComponents(identifier, 2);
    case "substrate-validator-set":
      // DACS-2 §7.5 closes the v0.1 substrate registry to these Demos
      // networks, whose set identifiers are canonical decimal epochs.
      return /^(?:demos-mainnet|demos-testnet):(0|[1-9][0-9]*)$/
        .test(identifier);
    case "lei":
      return /^[0-9A-Z]{20}$/.test(identifier);
    case "finra-crd":
      return /^(?:0|[1-9][0-9]*)$/.test(identifier);
    case "sam-uei":
      return /^[0-9A-Z]{12}$/.test(identifier);
    case "naics":
      return /^[0-9]{6}$/.test(identifier);
    case "cci-ud":
    case "cci-nomis":
    case "cci-humanpassport":
    case "cci-ethos":
    case "cci-tlsn":
    case "fedramp":
    case "cmmc":
      // These registered profiles are explicitly opaque or as-issued beyond
      // the generic non-empty, NFC ClaimReference identifier rule.
      return true;
    default:
      // CF-2 permits experimental/unknown schemes to be forwarded verbatim.
      // They remain unverified for requirement evaluation under DACS-1
      // unknown-scheme handling; only their generic NFC byte form is known.
      return true;
  }
}

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
  if (
    !identifier ||
    identifier.normalize("NFC") !== identifier ||
    !canonicalRegisteredIdentifier(scheme, identifier, question >= 0)
  ) {
    return null;
  }
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
    schemeStatus: REGISTERED_CLAIM_REFERENCE_SCHEMES.has(scheme)
      ? "registered"
      : "unknown",
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
