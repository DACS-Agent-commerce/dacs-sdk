import { types as nodeTypes } from "node:util";

import { DacsError } from "../errors.js";

import { canonicalize } from "./jcs.js";

const OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);
const ARRAY_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Array);

/** True when a string is valid JSON text data; CF-1 may still NFC-normalize it. */
export function isSafeJsonString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasIntrinsicConstructor(
  prototype: object,
  expectedSource: string,
): boolean {
  const constructor = Object.getOwnPropertyDescriptor(
    prototype,
    "constructor",
  )?.value;
  if (typeof constructor !== "function" || nodeTypes.isProxy(constructor)) {
    return false;
  }
  const declaredPrototype = Object.getOwnPropertyDescriptor(
    constructor,
    "prototype",
  )?.value;
  return (
    declaredPrototype === prototype &&
    Function.prototype.toString.call(constructor) === expectedSource
  );
}

/**
 * Protocol artifacts cross trust boundaries as JSON data, never as live object
 * graphs. Reject every JavaScript view that JSON/JCS would omit or alias before
 * taking an owned clone: accessors, proxies, sparse arrays, exotic prototypes,
 * symbols, `undefined`, negative zero, cycles, and unsupported scalar values.
 *
 * Negative zero is a local authoring alias only. CORE §B.2 admits it as a JSON
 * number that serialises as `0`, so received data may opt in: the canonical
 * snapshot below re-parses `0`, and the owned value never retains `-0`.
 */
function isDataOnlyJson(
  value: unknown,
  ancestors: Set<object>,
  omitUndefinedObjectProperties: boolean,
  allowReadOnlyDescriptors: boolean,
  allowNegativeZero: boolean,
): boolean {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") return isSafeJsonString(value);
  if (typeof value === "number") {
    return (
      Number.isFinite(value) &&
      (allowNegativeZero || !Object.is(value, -0)) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER
    );
  }
  if (
    typeof value !== "object" ||
    nodeTypes.isProxy(value) ||
    ancestors.has(value)
  ) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && nodeTypes.isProxy(prototype)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) return false;

    ancestors.add(value);
    if (Array.isArray(value)) {
      if (
        prototype === null ||
        !hasIntrinsicConstructor(prototype, ARRAY_CONSTRUCTOR_SOURCE)
      ) {
        return false;
      }
      const lengthDescriptor = descriptors["length"];
      if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
      const length = lengthDescriptor.value;
      const stringKeys = keys as string[];
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        (!allowReadOnlyDescriptors && lengthDescriptor.writable !== true) ||
        lengthDescriptor.enumerable ||
        lengthDescriptor.configurable ||
        stringKeys.length !== length + 1 ||
        !stringKeys.includes("length")
      ) {
        return false;
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !("value" in descriptor) ||
          (!allowReadOnlyDescriptors && descriptor.writable !== true) ||
          !descriptor.enumerable ||
          (!allowReadOnlyDescriptors && descriptor.configurable !== true) ||
          !isDataOnlyJson(
            descriptor.value,
            ancestors,
            omitUndefinedObjectProperties,
            allowReadOnlyDescriptors,
            allowNegativeZero,
          )
        ) {
          return false;
        }
      }
      return true;
    }

    if (
      prototype !== null &&
      !hasIntrinsicConstructor(prototype, OBJECT_CONSTRUCTOR_SOURCE)
    ) {
      return false;
    }
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        !isSafeJsonString(key) ||
        !descriptor ||
        !("value" in descriptor) ||
        (!allowReadOnlyDescriptors && descriptor.writable !== true) ||
        !descriptor.enumerable ||
        (!allowReadOnlyDescriptors && descriptor.configurable !== true) ||
        (descriptor.value === undefined
          ? !omitUndefinedObjectProperties
          : !isDataOnlyJson(
              descriptor.value,
              ancestors,
              omitUndefinedObjectProperties,
              allowReadOnlyDescriptors,
              allowNegativeZero,
            ))
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Re-home a validated JSON graph in this realm without invoking caller code.
 * Descriptor values are used instead of property reads, so accessors remain
 * impossible and repeated references become independent JSON values.
 */
function cloneValidatedJson(
  value: unknown,
  omitUndefinedObjectProperties: boolean,
): unknown {
  if (value === null || typeof value !== "object") return value;

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const length = (descriptors["length"] as PropertyDescriptor).value as number;
    const clone = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      clone[index] = cloneValidatedJson(
        (descriptors[String(index)] as PropertyDescriptor).value,
        omitUndefinedObjectProperties,
      );
    }
    return clone;
  }

  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    const propertyValue = (descriptors[key] as PropertyDescriptor).value;
    if (propertyValue === undefined && omitUndefinedObjectProperties) continue;
    Object.defineProperty(clone, key, {
      value: cloneValidatedJson(propertyValue, omitUndefinedObjectProperties),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return clone;
}

/** Own one stable canonical JSON value without retaining caller references. */
export function snapshotCanonicalJson<T>(value: T, label: string): T {
  return snapshotCanonicalJsonInternal(value, label, false, false, false);
}

/**
 * Own one received protocol artifact handed directly to a verifier or reader.
 * This is {@link snapshotCanonicalJson} with one difference: CORE §B.2 admits
 * negative zero as a JSON number that serialises as `0`, so a CF-5-admitted
 * `-0.0` is owned as `0` instead of being refused as an authoring alias. The
 * strict descriptor checks are kept: unlike {@link snapshotCanonicalJsonRead},
 * it refuses read-only views such as those returned by storage/callback reads.
 */
export function snapshotCanonicalJsonReceived<T>(value: T, label: string): T {
  return snapshotCanonicalJsonInternal(value, label, false, false, true);
}

/**
 * Own callback/configuration JSON while treating optional `undefined` object
 * members as absent. Arrays and protocol artifacts remain strict: only this
 * explicit configuration boundary opts into JavaScript's optional-property
 * convention. Read-only data descriptors are accepted because freezing a
 * verifier configuration does not change its JSON meaning; accessors, proxies,
 * hidden properties, and exotic prototypes remain forbidden.
 */
export function snapshotCanonicalJsonConfig<T>(value: T, label: string): T {
  return snapshotCanonicalJsonInternal(value, label, true, true, false);
}

/**
 * Own JSON returned by a storage/callback read. A compliant adapter may return
 * the exact deeply frozen object previously handed to its write callback, so
 * property writability/configurability cannot be used as a wire discriminator
 * at this boundary. Accessors, proxies, exotic prototypes, hidden properties,
 * unsupported scalars, cycles, sparse arrays, and `undefined` remain rejected.
 *
 * Received data may also carry negative zero, e.g. CF-5-admitted `-0.0`. CORE
 * §B.2 serialises it as `0`, so the owned snapshot holds `0` and hashes,
 * signed scopes and verifiers agree with the admitted bytes instead of failing.
 *
 * This is also the hashing boundary: `stripSignature`, `contentHash` and so
 * `signArtifact` own every input here, so they normalise an in-memory `-0`.
 * The authoring refusal of read-only views and `-0` applies only to
 * {@link snapshotCanonicalJson} / `snapshotCanonicalJsonObject` callers such as
 * `signComponentArtifact`, `buildComponentSignature` and
 * `prepareChannelMessageSigningInput`.
 */
export function snapshotCanonicalJsonRead<T>(value: T, label: string): T {
  return snapshotCanonicalJsonInternal(value, label, false, true, true);
}

/**
 * Own JSON returned by an external wire/signing boundary without changing its
 * byte-significant object-key order or string representation.
 *
 * This is deliberately narrower than protocol canonicalisation. Some deployed
 * transports still bind signatures or validity checks to `JSON.stringify`
 * output, so sorting keys or NFC-normalising strings after signing invalidates
 * the wire object. The same data-only checks as {@link snapshotCanonicalJsonRead}
 * still reject accessors, proxies, exotic prototypes, sparse arrays, symbols,
 * unsupported scalars, cycles, hidden properties, and `undefined`; only the
 * subsequent JCS normalisation is omitted.
 *
 * Negative zero stays refused here: without re-parsing canonical bytes the
 * owned clone would retain `-0` rather than the `0` it serialises as.
 */
export function snapshotWireJsonRead<T>(value: T, label: string): T {
  try {
    if (!isDataOnlyJson(value, new Set(), false, true, false)) {
      throw new TypeError("not data-only JSON");
    }
    const snapshot = cloneValidatedJson(value, false) as T;
    if (!isDataOnlyJson(snapshot, new Set(), false, false, false)) {
      throw new TypeError("wire snapshot changed data shape");
    }
    if (JSON.stringify(snapshot) !== JSON.stringify(value)) {
      throw new TypeError("wire snapshot changed JSON serialization");
    }
    return snapshot;
  } catch (cause) {
    throw new DacsError(`${label} is not stable wire JSON`, { cause });
  }
}

function snapshotCanonicalJsonInternal<T>(
  value: T,
  label: string,
  omitUndefinedObjectProperties: boolean,
  allowReadOnlyDescriptors: boolean,
  allowNegativeZero: boolean,
): T {
  try {
    if (
      !isDataOnlyJson(
        value,
        new Set(),
        omitUndefinedObjectProperties,
        allowReadOnlyDescriptors,
        allowNegativeZero,
      )
    ) {
      throw new TypeError("not data-only JSON");
    }
    const canonical = canonicalize(
      cloneValidatedJson(value, omitUndefinedObjectProperties),
    );
    // Parsing the canonical wire form both owns the result and deliberately
    // expands repeated in-memory references into independent JSON values.
    // CF-1 string-value normalization therefore happens exactly once at this
    // boundary; canonical member names are deliberately preserved.
    const snapshot = JSON.parse(canonical) as T;
    if (
      !isDataOnlyJson(snapshot, new Set(), false, false, false) ||
      canonicalize(snapshot) !== canonical
    ) {
      throw new TypeError("snapshot changed canonical bytes");
    }
    return snapshot;
  } catch (cause) {
    throw new DacsError(`${label} is not stable canonical JSON`, { cause });
  }
}

/** Own one stable canonical JSON object (arrays are not object documents). */
export function snapshotCanonicalJsonObject<
  T extends Record<string, unknown>,
>(value: T, label: string): T {
  const snapshot = snapshotCanonicalJson(value, label);
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new DacsError(`${label} must be a JSON object in canonical form`);
  }
  return snapshot;
}
