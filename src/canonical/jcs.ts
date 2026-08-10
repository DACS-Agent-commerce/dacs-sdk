import { DacsError } from "../errors.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

/**
 * RFC 8785 (JCS) string serialisation with the DACS CF-1 rule applied: the
 * value is NFC-normalised first (JCS itself performs no normalisation), then
 * escaped with only the JCS-required escapes. Forward slash and non-ASCII code
 * points are NOT escaped.
 */
function canonString(value: string): string {
  // RFC 8785 requires invalid Unicode data (lone UTF-16 surrogates) to fail.
  // Node's UTF-8 encoder replaces such code units with U+FFFD, so accepting
  // them would make two semantically different JavaScript strings hash to the
  // same bytes.
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new DacsError(
          "canonical form: string contains an unpaired UTF-16 surrogate",
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new DacsError(
        "canonical form: string contains an unpaired UTF-16 surrogate",
      );
    }
  }
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
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new DacsError(
        "canonical form: array must use the standard Array prototype",
      );
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1) {
      throw new DacsError(
        "canonical form: arrays must be dense and contain no extra properties",
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new DacsError(
          "canonical form: arrays must be dense enumerable data properties",
        );
      }
    }
    return "[" + value.map((item) => canonValue(item)).join(",") + "]";
  }

  if (t === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsError(
        "canonical form: object must be a plain JSON object",
      );
    }
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== "string") {
        throw new DacsError(
          "canonical form: symbol-keyed properties are not valid JSON",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new DacsError(
          "canonical form: object properties must be enumerable data properties",
        );
      }
    }

    const normalizedKeys = new Set<string>();
    const entries = Object.entries(object)
      // Match JSON object serialization for optional properties. Undefined is
      // never transportable data; unlike sparse/undefined array elements, an
      // undefined object member is omitted rather than changing array shape.
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => {
        const normalizedKey = key.normalize("NFC");
        if (normalizedKeys.has(normalizedKey)) {
          throw new DacsError(
            "canonical form: object contains duplicate NFC-normalized keys",
          );
        }
        normalizedKeys.add(normalizedKey);
        return [normalizedKey, entryValue] as const;
      })
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
