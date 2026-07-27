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

/**
 * Encode a colon-bearing logical address into the colon-free Demos StorageProgram
 * NAME (DACS-1 §6.3.4 Demos binding): `storageProgramName := colon-free encoding
 * of logical_address`. Demos requires colon-free program names, so the remaining
 * STRUCTURAL `:` separators are percent-encoded to `%3A` — the same `%3A` scheme
 * CF-4 already uses for the variable segments — making the whole string colon-free
 * and deterministic. The logical address itself is carried separately as record
 * metadata + the published logical→native binding (§6.3.5/§6.3.6); this is only
 * the name fed into `deriveStorageAddress(deployer, programName, nonce, salt)`.
 *
 * NOT reversible on its own (the logical address is the metadata of record) — its
 * one job is to be a colon-free, collision-free function of the logical address.
 */
export function logicalToStorageProgramName(logicalAddress: string): string {
  return logicalAddress.replace(/:/g, "%3A");
}
