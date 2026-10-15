import { types } from "node:util";

// No imports beyond Node built-ins: the proxy startup test transpiles this file
// alone and runs it in a child against the dispatchers Node really installed.

// An own data property keyed by a symbol with this description, as undici 6-8's
// Agent keeps its constructor options and factory.
function ownSymbolData(value: object, description: string): unknown {
  const key = Object.getOwnPropertySymbols(value).find(symbol => symbol.description === description);
  const descriptor = key === undefined ? undefined : Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function constructorName(prototype: unknown): unknown {
  if (prototype === null || typeof prototype !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  const constructor: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  return typeof constructor === "function" ? constructor.name : undefined;
}

// The name of the class that made `value`, read without running its code.
function className(value: unknown): unknown {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
  return constructorName(Object.getPrototypeOf(value));
}

/**
 * Whether `value` is an undici Agent exactly as Node creates its default global
 * dispatcher, `new Agent()`, which connects directly: an Agent itself (not a
 * subclass or compose() Proxy, and without its own dispatch), undici's default
 * factory, and no option set beyond undici 7-8's default `maxOrigins`. An Agent
 * given a `connect` function (fetch-socks), a `factory`, a socket path, TLS or
 * any other option is not Node's default, whatever route it takes.
 */
export function isNodeDefaultAgent(value: unknown): boolean {
  if (className(value) !== "Agent" || Object.hasOwn(value as object, "dispatch") ||
      constructorName(Object.getPrototypeOf(Object.getPrototypeOf(value))) !== "DispatcherBase") {
    return false;
  }
  const factory = ownSymbolData(value as object, "factory");
  const options = ownSymbolData(value as object, "options");
  if (typeof factory !== "function" || factory.name !== "defaultFactory" ||
      options === null || typeof options !== "object" || types.isProxy(options)) {
    return false;
  }
  return Reflect.ownKeys(options).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !("value" in descriptor)) return false;
    return descriptor.value === undefined || key === "maxOrigins" && descriptor.value === Infinity;
  });
}

/**
 * Whether the dispatchers under undici.globalDispatcher.2 and .1 are Node's
 * default: not loaded yet, or its default Agent, which Node 26 also wraps in a
 * Dispatcher1Wrapper under ".1".
 */
export function isNodeDefaultDispatcher([current, legacy]: readonly [unknown, unknown]): boolean {
  if (current !== undefined && !isNodeDefaultAgent(current)) return false;
  return legacy === undefined || isNodeDefaultAgent(legacy) ||
    current !== undefined && className(legacy) === "Dispatcher1Wrapper";
}
