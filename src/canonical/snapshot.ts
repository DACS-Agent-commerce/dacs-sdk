import { types as nodeTypes } from "node:util";

import { DacsError } from "../errors.js";

import { canonicalize } from "./jcs.js";

/**
 * Protocol artifacts cross trust boundaries as JSON data, never as live object
 * graphs. Reject every JavaScript view that JSON/JCS would omit or alias before
 * taking an owned clone: accessors, proxies, sparse arrays, exotic prototypes,
 * symbols, `undefined`, negative zero, cycles, and unsupported scalar values.
 */
function isDataOnlyJson(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
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
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === "symbol")) return false;

    ancestors.add(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return false;
      const length = value.length;
      const stringKeys = keys as string[];
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
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
          !descriptor.enumerable ||
          !isDataOnlyJson(descriptor.value, ancestors)
        ) {
          return false;
        }
      }
      return true;
    }

    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.value === undefined ||
        !isDataOnlyJson(descriptor.value, ancestors)
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
  try {
    if (!isDataOnlyJson(value)) throw new TypeError("not data-only JSON");
    const canonical = canonicalize(value);
    const snapshot = structuredClone(value);
    if (!isDataOnlyJson(snapshot) || canonicalize(snapshot) !== canonical) {
      throw new TypeError("snapshot changed canonical bytes");
    }
    return snapshot;
  } catch (cause) {
    throw new DacsError(`${label} is not stable canonical JSON`, { cause });
  }
}
