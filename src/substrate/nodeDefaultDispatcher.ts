import { types } from "node:util";

// No imports beyond Node built-ins: the proxy startup test transpiles this file
// alone and runs it in a child against the dispatchers Node really installed.

// Captured at load, so a later override can't answer for the code it inspects.
const functionSource = Function.prototype.toString;
const sourceOf = (value: unknown): string => Reflect.apply(functionSource, value, []) as string;
const compact = (source: string) => source.replace(/[\s;]+/g, "");
// undici 6-8's `defaultFactory` (lib/dispatcher/agent.js), identical in the
// source of Node 20.19, 22.23, 24.22 and 26.12 and in Node's bundled copy once
// whitespace and semicolons are dropped.
const DEFAULT_FACTORY_SOURCE = compact(`function defaultFactory (origin, opts) {
  return opts && opts.connections === 1 ? new Client(origin, opts) : new Pool(origin, opts)
}`);
// Node 20-26 define global fetch in lib/internal/bootstrap/web/exposed-window-or-worker.js
// as this function, which loads Node's own undici on first call.
const NODE_FETCH_SOURCE = compact(`function fetch(input, init = undefined) {
  if (!fetchImpl) {
    const undiciModule = require('internal/deps/undici/undici');
    fetchImpl = undiciModule.fetch;
  }
  return fetchImpl(input, init);
}`);

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
 * any other option is not Node's default, whatever route it takes. The factory
 * is judged by its source text, so another function named `defaultFactory`
 * is refused; nothing here runs the object's code. This is a compatibility
 * filter, not proof of its closures: automatic reads use a private Agent.
 */
export function isNodeDefaultAgent(value: unknown): boolean {
  if (className(value) !== "Agent" || Object.hasOwn(value as object, "dispatch") ||
      constructorName(Object.getPrototypeOf(Object.getPrototypeOf(value))) !== "DispatcherBase") {
    return false;
  }
  const factory = ownSymbolData(value as object, "factory");
  const options = ownSymbolData(value as object, "options");
  if (typeof factory !== "function" || types.isProxy(factory) ||
      compact(sourceOf(factory)) !== DEFAULT_FACTORY_SOURCE ||
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
 * Whether `value` has Node's complete global-fetch source, ignoring comments,
 * whitespace and semicolons. Matching text cannot establish its closures;
 * this compatibility filter never authorizes calling it for automatic reads.
 */
export function isNodeBuiltinFetch(value: unknown): boolean {
  if (typeof value !== "function" || types.isProxy(value)) return false;
  const source = sourceOf(value);
  return compact(source.replace(/\/\/[^\n]*/g, "")) === NODE_FETCH_SOURCE;
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
