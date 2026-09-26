import { DacsError } from "../errors.js";

export type RawJsonAdmissionStage = "parse" | "profile";

/** Admission failures precede canonicalization and cryptographic verification. */
export class RawJsonAdmissionError extends DacsError {
  constructor(
    readonly stage: RawJsonAdmissionStage,
    readonly code: string,
  ) {
    super(`raw JSON ${stage}: ${code}`);
    this.name = "RawJsonAdmissionError";
  }
}

function reject(stage: RawJsonAdmissionStage, code: string): never {
  throw new RawJsonAdmissionError(stage, code);
}

function scalarString(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** Compare the exact decimal token, before binary64 rounding, with 2^53-1. */
function checkNumber(token: string): void {
  const unsigned = token.replace(/^-/, "");
  const [coefficient, exponent = "0"] = unsigned.toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = (whole! + fraction).replace(/^0+/, "");
  if (digits === "") return; // Exact zero, including arbitrarily large exponents.
  const value = Number(token);
  if (/[.eE]/.test(token) && (!Number.isFinite(value) || value === 0)) {
    reject("profile", "NUMBER-NOT-BINARY64");
  }
  // No exponent-sized allocation or big-integer exponentiation. For a finite
  // nonzero binary64 value, this decimal order is small even with long tokens.
  const integerDigits = digits.length + Number(exponent) - fraction.length;
  const maximum = "9007199254740991";
  if (integerDigits > maximum.length) reject("profile", "NUMBER-OUTSIDE-DACS-MAGNITUDE");
  if (integerDigits === maximum.length) {
    const integer = digits.slice(0, maximum.length).padEnd(maximum.length, "0");
    if (integer > maximum || (integer === maximum && /[1-9]/.test(digits.slice(maximum.length)))) {
      reject("profile", "NUMBER-OUTSIDE-DACS-MAGNITUDE");
    }
  }
}

/**
 * Explicit CORE §B.2 CF-5 boundary for exact received UTF-8 bytes.
 *
 * Does not normalize keys/values, hash, verify signatures, or grant authority.
 * Call canonicalize only after this returns. Existing object-based SDK APIs
 * are not automatically protected by adding this opt-in admission function.
 */
export function admitRawJson(input: Uint8Array): unknown {
  if (!(input instanceof Uint8Array)) reject("parse", "BYTE-INPUT-REQUIRED");
  // Own the slice; never decode bytes outside a Buffer/Uint8Array view.
  const bytes = Uint8Array.from(input);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) reject("parse", "BOM");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    reject("parse", "INVALID-UTF8");
  }

  // Bound nesting iteratively before any recursive parser is called. Brackets
  // inside strings and escaped quotes do not contribute to container depth.
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[" || char === "{") {
      if (++depth > 128) reject("profile", "JSON-NESTING-TOO-DEEP");
    } else if ((char === "]" || char === "}") && depth > 0) depth -= 1;
  }

  let offset = 0;
  const profileChecks: Array<() => void> = [];
  const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function whitespace(): void {
    while (offset < text.length && /[\x20\x09\x0a\x0d]/.test(text[offset]!)) offset += 1;
  }
  function string(): string {
    const start = offset++;
    let escape = false;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') {
        let decoded: string;
        try { decoded = JSON.parse(text.slice(start, offset)) as string; }
        catch { reject("parse", "INVALID-JSON"); }
        profileChecks.push(() => {
          if (!scalarString(decoded)) reject("profile", "INVALID-UNICODE");
        });
        return decoded;
      }
    }
    return reject("parse", "INVALID-JSON");
  }
  function value(): void {
    whitespace();
    const first = text[offset];
    if (first === '"') { string(); return; }
    if (first === "{" || first === "[") {
      const object = first === "{";
      const close = object ? "}" : "]";
      const names = new Set<string>();
      offset += 1;
      whitespace();
      if (text[offset] === close) { offset += 1; return; }
      for (;;) {
        if (object) {
          if (text[offset] !== '"') reject("parse", "INVALID-JSON");
          const name = string();
          if (names.has(name)) profileChecks.push(() => reject("profile", "DUPLICATE-MEMBER"));
          names.add(name);
          whitespace();
          if (text[offset++] !== ":") reject("parse", "INVALID-JSON");
        }
        value();
        whitespace();
        if (text[offset] === close) { offset += 1; return; }
        if (text[offset++] !== ",") reject("parse", "INVALID-JSON");
        whitespace();
      }
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return; }
    }
    if (["NaN", "Infinity", "-Infinity"].some((x) => text.startsWith(x, offset))) {
      reject("parse", "NON-JSON-CONSTANT");
    }
    number.lastIndex = offset;
    const match = number.exec(text);
    if (!match) reject("parse", "INVALID-JSON");
    offset = number.lastIndex;
    const token = match[0];
    profileChecks.push(() => checkNumber(token));
  }
  value();
  whitespace();
  if (offset !== text.length) reject("parse", "TRAILING-DATA");
  for (const check of profileChecks) check();
  // Grammar, decoded-name uniqueness, scalar strings and exact raw numbers
  // have all passed. JSON.parse preserves __proto__ as an own data property.
  return JSON.parse(text) as unknown;
}
