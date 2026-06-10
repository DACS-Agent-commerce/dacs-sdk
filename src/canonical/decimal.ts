import { DacsError } from "../errors.js";

// CD-1: a plain decimal — digits with at most one dot. No exponent, no sign,
// no whitespace. (§14.4)
const DECIMAL_RE = /^[0-9]*\.?[0-9]*$/;

/**
 * Canonicalise a CD-1 decimal string (§14.4): strip leading integer zeros and
 * trailing fractional zeros so economically-equal amounts share one form
 * (`1.50` / `01.5` / `1.500` → `1.5`; `0.0` → `0`; `.5` → `0.5`). Rejects
 * exponent notation, leading `+`/`-`, and any non-numeric input.
 */
export function canonicalizeDecimal(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new DacsError(`invalid decimal: ${JSON.stringify(input)}`);
  }
  if (!DECIMAL_RE.test(input) || !/[0-9]/.test(input)) {
    throw new DacsError(
      `invalid decimal (exponent, sign, or non-numeric not allowed): ${input}`,
    );
  }

  const parts = input.split(".");
  let intPart = (parts[0] ?? "").replace(/^0+/, "");
  if (intPart === "") intPart = "0";
  const fracPart = (parts[1] ?? "").replace(/0+$/, "");

  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}

/**
 * Canonicalise an amount and enforce the §9.3 positivity rule (amount > 0).
 * Returns the canonical form. Throws on zero or non-decimal input.
 */
export function assertPositiveAmount(input: string): string {
  const canon = canonicalizeDecimal(input);
  if (canon === "0") {
    throw new DacsError(`amount MUST be > 0: ${input}`);
  }
  return canon;
}
