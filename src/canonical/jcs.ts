import { DacsError } from "../errors.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/**
 * RFC 8785 (JCS) string serialisation with the DACS CF-1 rule applied: the
 * value is NFC-normalised first (JCS itself performs no normalisation), then
 * escaped with only the JCS-required escapes. Forward slash and non-ASCII code
 * points are NOT escaped.
 */
function canonString(value: string): string {
  const nfc = value.normalize("NFC");
  let out = '"';
  for (const ch of nfc) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default: {
        const code = ch.codePointAt(0)!;
        if (code < 0x20) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += ch;
        }
      }
    }
  }
  return out + '"';
}

function canonValue(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return canonString(value as string);

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new DacsError(`canonical form: non-finite number (${n})`);
    }
    if (!Number.isInteger(n)) {
      throw new DacsError(
        `canonical form: non-integer JSON number not allowed (${n}); carry as a decimal string`,
      );
    }
    if (Math.abs(n) > MAX_SAFE) {
      throw new DacsError(
        `canonical form: number outside IEEE-754 safe-integer range (${n}); carry as a string`,
      );
    }
    return String(n);
  }

  if (t === "bigint") {
    throw new DacsError(
      "canonical form: bigint not allowed; carry large integers as decimal or 0x-hex strings",
    );
  }

  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonValue(item)).join(",") + "]";
  }

  if (t === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.normalize("NFC"), v] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return (
      "{" +
      entries.map(([k, v]) => canonString(k) + ":" + canonValue(v)).join(",") +
      "}"
    );
  }

  throw new DacsError(`canonical form: unsupported value type (${t})`);
}

/**
 * RFC 8785 JSON Canonicalization Scheme serialisation with the DACS profile:
 * NFC-normalised strings (CF-1) and integer-only JSON numbers within the
 * safe-integer range (everything larger must be a string). Throws on any value
 * that has no reproducible canonical form.
 */
export function canonicalize(value: unknown): string {
  return canonValue(value);
}
