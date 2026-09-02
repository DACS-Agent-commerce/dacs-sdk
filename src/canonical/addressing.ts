import { DacsError } from "../errors.js";
import { sha256Hex } from "./hash.js";

/**
 * Hash-based storage address (§10.4.3 / CORE.md): `stor-` followed by the
 * sha256 hex of the seed. The substrate-agnostic address form for content that
 * has no colon-bearing logical name — notably the role-specific bundle copies.
 */
export function storAddress(seed: string): string {
  return `stor-${sha256Hex(seed)}`;
}

/** DACS-5 §10.4.3 role-specific bundle address: `stor-{sha256(jobId + "-bundle-" + role)}`. */
export function bundleAddress(
  jobId: string,
  role: "buyer" | "seller" | "orchestrator",
): string {
  return storAddress(`${jobId}-bundle-${role}`);
}

/**
 * CF-4 logical addressing (§6.3.4). A logical address is assembled from fixed
 * structural segments joined by `:`, where each *variable* segment (a claim, a
 * listing id, …) has its reserved delimiters percent-encoded so they can't be
 * confused with the structural `:` separators. Only the five reserved bytes are
 * encoded — with UPPERCASE hex — and nothing else is guessed, so the encoding
 * is byte-stable and reversible.
 */

// The closed CF-4 reserved set and their uppercase percent-encodings.
const ENCODE: Record<string, string> = {
  ":": "%3A",
  "?": "%3F",
  "&": "%26",
  "=": "%3D",
  "%": "%25",
};
const DECODE: Record<string, string> = {
  "3A": ":",
  "3F": "?",
  "26": "&",
  "3D": "=",
  "25": "%",
};

/**
 * Percent-encode the CF-4 reserved delimiters (`: ? & = %`) in a variable
 * address segment with uppercase hex; leave every other byte untouched. A
 * single pass means the `%` introduced by encoding a delimiter is never
 * re-encoded.
 */
export function encodeAddressSegment(segment: string): string {
  return segment.replace(/[:?&=%]/g, (c) => ENCODE[c]!);
}

/** Reverse {@link encodeAddressSegment} — decode only the CF-4 escapes. */
export function decodeAddressSegment(segment: string): string {
  return segment.replace(/%(3A|3F|26|3D|25)/gi, (_, hex: string) => DECODE[hex.toUpperCase()]!);
}

function requireStructuralSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.normalize("NFC") !== value ||
    /[:?&=%\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DacsError(`${label} must be a non-empty canonical structural segment`);
  }
}

function requireVariableSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.normalize("NFC") !== value ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new DacsError(`${label} must be non-empty canonical text`);
  }
}

function requireSafeInteger(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new DacsError(`${label} must be a safe integer >= ${minimum}: ${value}`);
  }
}

/**
 * Assemble a DACS-1 listing logical address (§6.3.4 CF-4):
 * `dacs1:<sellerPrimaryClaim>:<listingId>:v<version>` with the claim and
 * listing-id variable segments CF-4 encoded.
 */
export function listingAddress(
  sellerPrimaryClaim: string,
  listingId: string,
  version: number | string,
): string {
  const v =
    typeof version === "number"
      ? `v${version}`
      : version.startsWith("v")
        ? version
        : `v${version}`;
  if (typeof version === "number" && (!Number.isInteger(version) || version < 0)) {
    throw new DacsError(`listing address version must be a non-negative integer: ${version}`);
  }
  return `dacs1:${encodeAddressSegment(sellerPrimaryClaim)}:${encodeAddressSegment(listingId)}:${v}`;
}

/** DACS-2 CM-2 VerifyResult address with the identifier encoded per CF-4. */
export function attestationAddress(
  jobId: string,
  scheme: string,
  identifier: string,
  recipeVersion: number,
): string {
  requireStructuralSegment(jobId, "attestation address jobId");
  if (!/^[a-z][a-z0-9-]*$/.test(scheme)) {
    throw new DacsError("attestation address scheme must be a canonical lowercase token");
  }
  requireVariableSegment(identifier, "attestation address identifier");
  requireSafeInteger(recipeVersion, "attestation address recipeVersion", 1);
  return `dacs2:${jobId}:${scheme}:${encodeAddressSegment(identifier)}:v${recipeVersion}`;
}

/** DACS-4 PC-2 SettlementEvidence address with the rail id encoded per CF-4. */
export function paymentEvidenceAddress(
  jobId: string,
  railId: string,
  phaseIndex: number,
  resolved = false,
): string {
  requireStructuralSegment(jobId, "payment evidence address jobId");
  requireVariableSegment(railId, "payment evidence address railId");
  requireSafeInteger(phaseIndex, "payment evidence address phaseIndex", 0);
  if (typeof resolved !== "boolean") {
    throw new DacsError("payment evidence address resolved flag must be boolean");
  }
  return (
    `dacs4:payment:${jobId}:${encodeAddressSegment(railId)}:${phaseIndex}` +
    (resolved ? ":resolved" : "")
  );
}

/** DACS-5 §10.6.1 RatingRecord address with the rater encoded per CF-4. */
export function ratingAddress(jobId: string, rater: string): string {
  requireStructuralSegment(jobId, "rating address jobId");
  requireVariableSegment(rater, "rating address rater");
  return `dacs5:rating:${jobId}:${encodeAddressSegment(rater)}`;
}

/**
 * Encode a colon-bearing logical address into a colon-free Demos StorageProgram
 * NAME (DACS-1 §6.3.4 Demos binding). Demos rejects `:` in program names; the
 * spec's contract is `storageProgramName := implementation-defined colon-free
 * StorageProgram name // opaque write input`. This `%3A` percent-encoding is
 * THIS SDK's implementation-defined choice (deterministic and collision-free),
 * NOT a spec-mandated or reversible mapping: §6.3.4 explicitly defines no
 * `logical_address → storageProgramName` encoding, and the name MUST be treated
 * as an opaque write input — never as a canonical identifier or a CONSUMER
 * resolution key. Consumers resolve through the published logical→native
 * binding (§6.3.5/§6.3.6); the logical address is the metadata-of-record. This
 * string's only job is to be fed into
 * `deriveStorageAddress(deployer, programName, nonce, salt)` at write time.
 *
 * Idempotent — encoding an already-colon-free name is a no-op — so it's safe to
 * apply at the call site AND again in the substrate adapter.
 */
export function logicalToStorageProgramName(logicalAddress: string): string {
  return logicalAddress.replace(/:/g, "%3A");
}
