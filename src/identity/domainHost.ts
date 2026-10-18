import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";

import { canonicalize } from "../canonical/index.js";
import { DacsError } from "../errors.js";

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * DACS-1 DCR-1/DCR-2 hostname conversion used at the native-ingestion edge.
 *
 * This is a producer operation, not a signed-artifact repair operation. A
 * Demos adapter may call it after authenticating a native `web2.domain`
 * record and before constructing a new `domain:` ClaimReference. Readers of
 * signed DACS artifacts must use {@link isCanonicalDomainHostname} instead.
 */
export function canonicalizeNativeDomainHostname(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }

  const normalized = value.normalize("NFC");
  // A ClaimReference identifier is a bare hostname. Reject URL structure
  // before ToASCII so the URL implementation cannot discard or reinterpret it.
  if (/[:/@?#*\[\]\\%\s]/.test(normalized) || normalized.endsWith(".")) {
    return null;
  }

  let ascii: string;
  if (/^[\x00-\x7f]+$/.test(normalized)) {
    // WHATWG's URL-host parser treats some all-numeric multi-label names as
    // attempted IPv4 literals and returns an empty string. DCR-2 permits an
    // all-numeric hostname when it is not itself an IP literal, so preserve
    // ordinary ASCII labels and invoke IDNA only to validate A-label syntax.
    ascii = normalized.toLowerCase();
    const urlHost = domainToASCII(normalized);
    if (urlHost !== "" && isIP(urlHost) !== 0) return null;
    if (
      ascii.split(".").some(
        (label) =>
          label.startsWith("xn--") && domainToASCII(label) !== label,
      )
    ) {
      return null;
    }
  } else {
    try {
      ascii = domainToASCII(normalized).toLowerCase();
      // WHATWG applies UTS #46 compatibility mappings that are wider than
      // IDNA2008. A round-trip must preserve the NFC input apart from case and
      // the four IDNA-recognised label separators; this rejects, for example,
      // fullwidth Latin letters that URL parsing would silently repair.
      const expectedUnicode = normalized
        .replace(/[\u3002\uff0e\uff61]/g, ".")
        .toLowerCase();
      if (domainToUnicode(ascii) !== expectedUnicode) return null;
    } catch {
      return null;
    }
  }
  if (
    ascii.length === 0 ||
    Buffer.byteLength(ascii, "ascii") > 253 ||
    ascii.endsWith(".") ||
    isIP(ascii) !== 0
  ) {
    return null;
  }
  const labels = ascii.split(".");
  if (
    labels.length === 0 ||
    labels.some(
      (label) =>
        Buffer.byteLength(label, "ascii") > 63 || !DOMAIN_LABEL.test(label),
    )
  ) {
    return null;
  }
  return ascii;
}

/** True only for the exact lower-case ASCII A-label DCR-1 wire spelling. */
export function isCanonicalDomainHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    canonicalizeNativeDomainHostname(value) === value
  );
}

/** Produce the sole current DACS domain ClaimReference from a native hostname. */
export function domainClaimReferenceFromNativeHostname(
  value: unknown,
): `domain:${string}` | null {
  const hostname = canonicalizeNativeDomainHostname(value);
  return hostname === null ? null : `domain:${hostname}`;
}

/** Native inputs for a new DACS-1 domain-only presentation, before signing. */
export interface DomainClaimProducerInput {
  producerVersion: "dacs1-domain-v1";
  bundleVersion: "1";
  subject: string;
  claims: Array<{
    nativeContext: "web2.domain";
    hostname: string;
    metadata: Record<string, unknown>;
  }>;
  presentedByClaimIndex: number;
  presentedAt: number;
}

/**
 * Serialize a new domain presentation from native hostnames. Every position,
 * including presentedBy, uses the canonical domain reference; historical alias
 * compatibility is confined to reading existing signed presentations.
 */
export function serializeDomainClaimArtifact(input: DomainClaimProducerInput): string {
  // Capture JSON values once, before deriving any references or emitted bytes.
  const captured = JSON.parse(canonicalize(input)) as DomainClaimProducerInput;
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const required = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key));
  if (!exact(captured, ["producerVersion", "bundleVersion", "subject", "claims", "presentedByClaimIndex", "presentedAt"]) ||
      captured.producerVersion !== "dacs1-domain-v1" || captured.bundleVersion !== "1" ||
      typeof captured.subject !== "string" || !Array.isArray(captured.claims) ||
      captured.claims.length === 0 || !Number.isSafeInteger(captured.presentedByClaimIndex) ||
      captured.presentedByClaimIndex < 0 || captured.presentedByClaimIndex >= captured.claims.length ||
      !Number.isSafeInteger(captured.presentedAt) || captured.presentedAt < 0) {
    throw new DacsError("invalid domain producer input");
  }
  const emitted = new Map<string, { ref: string; metadata: Record<string, unknown> }>();
  const sourceRefs: string[] = [];
  for (const claim of captured.claims) {
    if (!exact(claim, ["nativeContext", "hostname", "metadata"])) {
      throw new DacsError("invalid native domain claim input");
    }
    const ref = domainClaimReferenceFromNativeHostname(claim.hostname);
    if (claim.nativeContext !== "web2.domain" || ref === null) {
      throw new DacsError("domain producer requires a valid native web2.domain hostname");
    }
    const metadata = claim.metadata;
    const native = metadata?.demosGcrDomain as Record<string, unknown> | undefined;
    const tx = native?.sourceTransaction as Record<string, unknown> | undefined;
    const hex = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
    const natural = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
    const host = ref.slice("domain:".length);
    if (!required(metadata, ["demosGcrDomain"]) ||
        !required(native, ["context", "hostname", "account", "proofUrl", "sourceTransaction", "recordedAt"]) ||
        native.context !== "web2.domain" || native.hostname !== host || !hex(native.account) ||
        native.proofUrl !== `https://${host}/.well-known/demos-cci.txt` || !natural(native.recordedAt) ||
        !required(tx, ["txHash", "blockNumber"]) || !hex(tx.txHash) || !natural(tx.blockNumber)) {
      throw new DacsError("invalid persistent Demos domain metadata");
    }
    const output = { ref, metadata };
    const previous = emitted.get(ref);
    if (previous && canonicalize(previous) !== canonicalize(output)) {
      throw new DacsError("duplicate semantic domain has conflicting metadata");
    }
    if (!previous) emitted.set(ref, output);
    sourceRefs.push(ref);
  }
  return canonicalize({
    bundleVersion: captured.bundleVersion,
    subject: captured.subject,
    claims: [...emitted.values()],
    presentedBy: sourceRefs[captured.presentedByClaimIndex],
    presentedAt: captured.presentedAt,
  });
}
