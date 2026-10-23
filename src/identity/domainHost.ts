import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";

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
