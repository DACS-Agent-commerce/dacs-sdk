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
  if (!labels.every(isIdna2008Label)) return null;
  return ascii;
}

// RFC 5892 section 2.6 exceptions. Code points absent here take their
// derived property from the section 2 categories below.
const EXCEPTION_PVALID = new Set([0x00df, 0x03c2, 0x06fd, 0x06fe, 0x0f0b, 0x3007]);
const EXCEPTION_DISALLOWED = new Set([
  0x0640, 0x07fa, 0x302e, 0x302f, 0x3031, 0x3032, 0x3033, 0x3034, 0x3035, 0x303b,
]);
const LETTER_DIGIT = /^[\p{Ll}\p{Lu}\p{Lo}\p{Nd}\p{Lm}\p{Mn}\p{Mc}]$/u;
const IGNORABLE_PROPERTY =
  /^[\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Noncharacter_Code_Point}]$/u;
const UNSTABLE = /^\p{Changes_When_NFKC_Casefolded}$/u;
const UNASSIGNED = /^\p{Cn}$/u;
const COMBINING_MARK = /^\p{M}$/u;
const GREEK = /^\p{Script=Greek}$/u;
const HEBREW = /^\p{Script=Hebrew}$/u;
const HIRAGANA_KATAKANA_HAN = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]$/u;

function isArabicIndicDigit(cp: number): boolean {
  return cp >= 0x0660 && cp <= 0x0669;
}

function isExtendedArabicIndicDigit(cp: number): boolean {
  return cp >= 0x06f0 && cp <= 0x06f9;
}

function isContextO(cp: number): boolean {
  return (
    cp === 0x00b7 ||
    cp === 0x0375 ||
    cp === 0x05f3 ||
    cp === 0x05f4 ||
    cp === 0x30fb ||
    isArabicIndicDigit(cp) ||
    isExtendedArabicIndicDigit(cp)
  );
}

/** RFC 5892 section 3 derived property, reduced to "may appear in a U-label". */
function isPermittedCodePoint(cp: number): boolean {
  if (EXCEPTION_PVALID.has(cp) || isContextO(cp)) return true;
  if (EXCEPTION_DISALLOWED.has(cp)) return false;
  const ch = String.fromCodePoint(cp);
  if (UNASSIGNED.test(ch)) return false;
  if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39) || cp === 0x2d) {
    return true;
  }
  // CONTEXTJ (ZWNJ/ZWJ): Node's UTS #46 conversion runs with CheckJoiners,
  // which applies the RFC 5892 Appendix A.1/A.2 rules; this check leaves that
  // existing behaviour unchanged.
  if (cp === 0x200c || cp === 0x200d) return true;
  if (UNSTABLE.test(ch) || IGNORABLE_PROPERTY.test(ch)) return false;
  if (
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0x1d100 && cp <= 0x1d24f) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xd7b0 && cp <= 0xd7ff)
  ) {
    // IgnorableBlocks (symbol diacritics, musical notation) and OldHangulJamo.
    return false;
  }
  return LETTER_DIGIT.test(ch);
}

/** RFC 5892 Appendix A CONTEXTO rules for the code point at `i`. */
function contextORuleHolds(cps: readonly number[], i: number): boolean {
  const cp = cps[i]!;
  const at = (j: number): string =>
    j >= 0 && j < cps.length ? String.fromCodePoint(cps[j]!) : "";
  switch (cp) {
    case 0x00b7: // A.3 MIDDLE DOT: only between two 'l'.
      return cps[i - 1] === 0x6c && cps[i + 1] === 0x6c;
    case 0x0375: // A.4 GREEK LOWER NUMERAL SIGN: followed by Greek.
      return GREEK.test(at(i + 1));
    case 0x05f3: // A.5/A.6 HEBREW GERESH/GERSHAYIM: preceded by Hebrew.
    case 0x05f4:
      return HEBREW.test(at(i - 1));
    case 0x30fb: // A.7 KATAKANA MIDDLE DOT: label has Hiragana/Katakana/Han.
      return cps.some((c) => HIRAGANA_KATAKANA_HAN.test(String.fromCodePoint(c)));
    default:
      if (isArabicIndicDigit(cp)) return !cps.some(isExtendedArabicIndicDigit); // A.8
      if (isExtendedArabicIndicDigit(cp)) return !cps.some(isArabicIndicDigit); // A.9
      return true;
  }
}

/**
 * IDNA2008 (RFC 5891 section 4.2.3, RFC 5892) label check applied to the
 * canonical A-label spelling. Node's UTS #46 conversion is wider than
 * IDNA2008: it admits symbols such as emoji, CONTEXTO characters out of
 * context, and reserved "??--" labels.
 */
function isIdna2008Label(alabel: string): boolean {
  const isALabel = alabel.startsWith("xn--");
  const ulabel = isALabel ? domainToUnicode(alabel) : alabel;
  if (ulabel.length === 0 || ulabel !== ulabel.normalize("NFC")) return false;
  // Positions are code points, not UTF-16 code units.
  const cps = Array.from(ulabel, (ch) => ch.codePointAt(0)!);
  // 4.2.3.1: no hyphen in both the third and fourth positions (an A-label's
  // own "xn--" prefix is checked on its decoded U-label), and none at either end.
  if (
    (cps[2] === 0x2d && cps[3] === 0x2d) ||
    cps[0] === 0x2d ||
    cps[cps.length - 1] === 0x2d
  ) {
    return false;
  }
  if (!isALabel) return true; // Plain LDH labels already matched DOMAIN_LABEL.
  // 4.2.3.2: no leading combining mark.
  if (COMBINING_MARK.test(String.fromCodePoint(cps[0]!))) return false;
  return cps.every((cp, i) => isPermittedCodePoint(cp) && contextORuleHolds(cps, i));
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
