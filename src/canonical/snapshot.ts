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
 */
function isDataOnlyJson(
  value: unknown,
  ancestors = new Set<object>(),
  omitUndefinedObjectProperties = false,
): boolean {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "string") return isSafeJsonString(value);
  if (typeof value === "number") {
    return (
      Number.isFinite(value) &&
      !Object.is(value, -0) &&
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
        lengthDescriptor.writable !== true ||
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
          descriptor.writable !== true ||
          !descriptor.enumerable ||
          descriptor.configurable !== true ||
          !isDataOnlyJson(
            descriptor.value,
            ancestors,
            omitUndefinedObjectProperties,
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
        descriptor.writable !== true ||
        !descriptor.enumerable ||
        descriptor.configurable !== true ||
        (descriptor.value === undefined
          ? !omitUndefinedObjectProperties
          : !isDataOnlyJson(
              descriptor.value,
              ancestors,
              omitUndefinedObjectProperties,
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

/** Own one stable canonical JSON value without retaining caller references. */
export function snapshotCanonicalJson<T>(value: T, label: string): T {
  return snapshotCanonicalJsonInternal(value, label, false);
}

/**
 * Own callback/configuration JSON while treating optional `undefined` object
 * members as absent. Arrays and protocol artifacts remain strict: only this
 * explicit configuration boundary opts into JavaScript's optional-property
 * convention.
 */
export function snapshotCanonicalJsonConfig<T>(value: T, label: string): T {
  return snapshotCanonicalJsonInternal(value, label, true);
}

function snapshotCanonicalJsonInternal<T>(
  value: T,
  label: string,
  omitUndefinedObjectProperties: boolean,
): T {
  try {
    if (!isDataOnlyJson(value, new Set(), omitUndefinedObjectProperties)) {
      throw new TypeError("not data-only JSON");
    }
    const canonical = canonicalize(value);
    // Parsing the canonical wire form both owns the result and deliberately
    // expands repeated in-memory references into independent JSON values.
    // CF-1 normalization therefore also happens exactly once at this boundary.
    const snapshot = JSON.parse(canonical) as T;
    if (!isDataOnlyJson(snapshot) || canonicalize(snapshot) !== canonical) {
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
