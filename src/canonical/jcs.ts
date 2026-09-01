import { DacsError } from "../errors.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1
const MAX_NESTING_DEPTH = 64;
const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);

/**
 * RFC 8785 (JCS) string serialisation. DACS CF-1 NFC-normalises string values,
 * but RFC 8785 requires object member names to remain unchanged. Forward slash
 * and non-ASCII code points are NOT escaped.
 */
function canonString(value: string, normalizeValue: boolean): string {
  assertNoLoneSurrogates(value);
  const input = normalizeValue ? value.normalize("NFC") : value;
  let out = '"';
  for (const ch of input) {
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

function canonValue(value: unknown, ancestors: Set<object>, depth: number): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return canonString(value as string, true);

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new DacsError(`canonical form: non-finite number (${n})`);
    }
    if (Math.abs(n) > MAX_SAFE) {
      throw new DacsError(
        `canonical form: number outside IEEE-754 safe-integer range (${n}); carry as a string`,
      );
    }
    return JSON.stringify(n);
  }

  if (t === "bigint") {
    throw new DacsError(
      "canonical form: bigint not allowed; carry large integers as decimal or 0x-hex strings",
    );
  }

  if (Array.isArray(value)) {
    return withCycleGuard(value, ancestors, () => {
      assertNestingDepth(depth);
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new DacsError(
          "canonical form: array must use the standard Array prototype",
        );
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new DacsError(
            `canonical form: sparse array; arrays must be dense (missing entry at index ${index})`,
          );
        }
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
        items.push(canonValue(descriptor.value, ancestors, depth + 1));
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1) {
        throw new DacsError(
          "canonical form: arrays must be dense and contain no extra properties",
        );
      }
      return "[" + items.join(",") + "]";
    });
  }

  if (t === "object") {
    const object = value as object;
    return withCycleGuard(object, ancestors, () => {
      assertNestingDepth(depth);
      if (!isPlainJsonObject(object)) {
        throw new DacsError("canonical form: only plain JSON objects are supported");
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

      const entries: Array<[string, unknown]> = [];
      for (const [key, entry] of Object.entries(object)) {
        if (entry === undefined) continue;
        assertNoLoneSurrogates(key);
        entries.push([key, entry]);
      }

      entries.sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );
      return (
        "{" +
        entries
          .map(([key, entry]) =>
            canonString(key, false) + ":" + canonValue(entry, ancestors, depth + 1)
          )
          .join(",") +
        "}"
      );
    });
  }

  throw new DacsError(`canonical form: unsupported value type (${t})`);
}

/**
 * RFC 8785 JSON Canonicalization Scheme serialisation with the DACS profile:
 * NFC-normalised string values (CF-1), byte-preserved member names, and finite
 * JSON numbers within the IEEE-754 safe-integer magnitude range (everything
 * larger must be a string). Throws on any value that has no reproducible
 * canonical form.
 */
export function canonicalize(value: unknown): string {
  return canonValue(value, new Set<object>(), 0);
}

function assertNoLoneSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new DacsError(
          "canonical form: unpaired UTF-16 surrogate: lone high surrogate",
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new DacsError(
        "canonical form: unpaired UTF-16 surrogate: lone low surrogate",
      );
    }
  }
}

function assertNestingDepth(depth: number): void {
  if (depth >= MAX_NESTING_DEPTH) {
    throw new DacsError(`canonical form: nesting depth exceeds ${MAX_NESTING_DEPTH}`);
  }
}

function isPlainJsonObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null) return true;

  const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  return (
    typeof constructor === "function" &&
    constructor.prototype === prototype &&
    Function.prototype.toString.call(constructor) === OBJECT_CONSTRUCTOR_SOURCE
  );
}

function withCycleGuard<T>(
  value: object,
  ancestors: Set<object>,
  operation: () => T,
): T {
  if (ancestors.has(value)) {
    throw new DacsError("canonical form: cyclic structure");
  }
  ancestors.add(value);
  try {
    return operation();
  } finally {
    ancestors.delete(value);
  }
}
