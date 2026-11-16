import { DacsError } from "../errors.js";
import { deepFreeze } from "./deepFreeze.js";

/**
 * Small checks for untrusted wire data that compose into one schema.
 *
 * `parse` returns a frozen copy or throws `SchemaError`; `is` answers true or
 * false. Only a failed check is a data failure. A bad schema definition throws
 * `TypeError` when the schema is built, and a `refine` predicate that throws
 * anything but a permanent `DacsError` is rethrown as it is, so a bug is never
 * reported as bad input.
 */

type Failure = { readonly ok: false; readonly path: string; readonly expected: string; readonly cause?: unknown };
type Outcome<T> = { readonly ok: true; readonly value: T } | Failure;

/** A check. `read` returns a failure for bad data and holds a fresh copy of the value on success. */
export interface Schema<T> {
  readonly read: (value: unknown, path: string) => Outcome<T>;
  readonly optional?: true;
}

/** A check that also accepts `undefined`; an `object` shape may leave its key out. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}

/** The type a schema accepts. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Readonly<Record<string, Schema<unknown>>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never }[keyof S];
type ObjectOf<S extends Shape> = {
  readonly [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]>;
} & {
  readonly [K in OptionalKeys<S>]?: Infer<S[K]>;
} extends infer O
  ? { [K in keyof O]: O[K] }
  : never;

/** Thrown by `parse`. The message and the two fields hold the path and the expectation, never the rejected value. */
export class SchemaError extends DacsError {
  constructor(
    readonly path: string,
    readonly expected: string,
    cause?: unknown,
  ) {
    super(`${path}: expected ${expected}`, { code: "schema.invalid_field", ...(cause === undefined ? {} : { cause }) });
    this.name = "SchemaError";
  }
}

const fail = (path: string, expected: string, cause?: unknown): Failure =>
  cause === undefined ? { ok: false, path, expected } : { ok: false, path, expected, cause };

function leaf<T>(expected: string, accepts: (value: unknown) => boolean): Schema<T> {
  return { read: (value, path) => (accepts(value) ? { ok: true, value: value as T } : fail(path, expected)) };
}

function assertSchema(schema: unknown): asserts schema is Schema<unknown> {
  if (typeof (schema as Schema<unknown> | undefined)?.read !== "function") throw new TypeError("expected a schema");
}

/** A string, optionally non-empty and matching `pattern`. The pattern must not carry the `g` or `y` flag. */
export function string(options: { pattern?: RegExp; nonEmpty?: boolean } = {}): Schema<string> {
  const { pattern, nonEmpty = false } = options;
  if (pattern !== undefined && (!(pattern instanceof RegExp) || pattern.global || pattern.sticky)) {
    throw new TypeError("string pattern must be a RegExp without the g or y flag");
  }
  const expected = `${nonEmpty ? "non-empty string" : "string"}${pattern === undefined ? "" : ` matching ${pattern}`}`;
  return leaf(expected, (value) =>
    typeof value === "string" && (!nonEmpty || value.length > 0) && (pattern === undefined || pattern.test(value)),
  );
}

/** A safe integer from `min` to `max`, both inclusive. */
export function integer(options: { min?: number; max?: number } = {}): Schema<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new TypeError("integer bounds must be safe integers with min <= max");
  }
  const bounds = [options.min === undefined ? "" : ` >= ${min}`, options.max === undefined ? "" : ` <= ${max}`].join("");
  return leaf(`safe integer${bounds}`, (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max);
}

/** Exactly `expected`, compared with `===`. */
export function literal<const T extends string | number | boolean | null>(expected: T): Schema<T> {
  return leaf(JSON.stringify(expected), (value) => value === expected);
}

/** One of the given strings. */
export function oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "string")) {
    throw new TypeError("oneOf needs a non-empty list of strings");
  }
  const allowed = new Set<string>(values);
  return leaf(`one of ${values.map((value) => JSON.stringify(value)).join(", ")}`, (value) => typeof value === "string" && allowed.has(value));
}

const HASH = /^[0-9a-f]{64}$/;

/** A 64-character lower-case hex string. */
export function hash(): Schema<string> {
  return leaf("64-character lower-case hex string", (value) => typeof value === "string" && HASH.test(value));
}

/**
 * Accepts what `predicate` accepts. The predicate says the data is bad by
 * returning false or by throwing a permanent `DacsError`, which `parse` keeps
 * as the cause; any other throw is rethrown unchanged. An object is copied
 * first and the predicate checks that copy, which is also what the result
 * holds, so it never aliases the caller's value and cannot differ from what was
 * checked. A value that cannot be copied, or that holds a `Map`, `Set` or
 * `Date` (which freezing cannot make read-only), is bad data.
 */
export function refine<T>(predicate: (value: unknown) => value is T, expected?: string): Schema<T>;
export function refine(predicate: (value: unknown) => boolean, expected?: string): Schema<unknown>;
export function refine(predicate: (value: unknown) => boolean, expected = "a value the check accepts"): Schema<unknown> {
  if (typeof predicate !== "function") throw new TypeError("refine needs a predicate function");
  return {
    read(value, path) {
      let snapshot = value;
      if (typeof value === "object" && value !== null) {
        try {
          snapshot = structuredClone(value);
        } catch {
          return fail(path, expected);
        }
        if (holdsMutableCollection(snapshot, new Set())) return fail(path, expected);
      }
      try {
        if (!predicate(snapshot)) return fail(path, expected);
      } catch (cause) {
        if (cause instanceof DacsError && cause.category === "permanent") return fail(path, expected, cause);
        throw cause;
      }
      return { ok: true, value: snapshot };
    },
  };
}

/** True when `value` is, or reaches through enumerable own properties, a `Map`, `Set` or `Date`, which freezing cannot make read-only. */
function holdsMutableCollection(value: unknown, seen: Set<object>): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  if (value instanceof Map || value instanceof Set || value instanceof Date) return true;
  seen.add(value);
  return Object.values(value).some((child) => holdsMutableCollection(child, seen));
}

/** `schema`, or `undefined`. */
export function optional<T>(schema: Schema<T>): OptionalSchema<T> {
  assertSchema(schema);
  return { read: (value, path) => (value === undefined ? { ok: true, value } : schema.read(value, path)), optional: true };
}

/**
 * The enumerable own data values of a plain wire record, or `undefined` when
 * the record has another prototype, a symbol key, a key outside `required` and
 * `optionalKeys`, a missing required key, or any accessor, hidden or `undefined`
 * property. A throw while reflecting (a proxy trap) means it is not a plain
 * record. No getter runs, and nothing but reflection sits inside the `try`.
 */
function plainValues(value: unknown, required: readonly string[], optionalKeys: readonly string[]): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const values = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !(required.includes(key) || optionalKeys.includes(key))) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) return undefined;
      values.set(key, descriptor.value);
    }
    return required.every((key) => values.has(key)) ? values : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An object with the keys of `shape`. `exact` (the default) takes only a plain
 * record with exactly those keys, required ones present and optional ones
 * present or absent. `open` takes any non-array object, reads each key as a
 * property and ignores the others. The result holds the shape's keys only.
 */
export function object<const S extends Shape>(shape: S, options: { mode?: "exact" | "open" } = {}): Schema<ObjectOf<S>> {
  const { mode = "exact" } = options;
  if (mode !== "exact" && mode !== "open") throw new TypeError("object mode must be exact or open");
  const fields = Object.entries(shape);
  for (const [, field] of fields) assertSchema(field);
  const required = fields.filter(([, field]) => !field.optional).map(([key]) => key);
  const allowed = fields.filter(([, field]) => field.optional).map(([key]) => key);
  return {
    read(value, path) {
      let read: (key: string) => unknown;
      if (mode === "exact") {
        const own = plainValues(value, required, allowed);
        if (own === undefined) return fail(path, `object with exactly the keys ${[...required, ...allowed.map((key) => `${key}?`)].join(", ")}`);
        read = (key) => own.get(key);
      } else {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(path, "object");
        read = (key) => (value as Record<string, unknown>)[key];
      }
      const entries: [string, unknown][] = [];
      for (const [key, field] of fields) {
        const raw = read(key);
        if (raw === undefined && field.optional) continue;
        const outcome = field.read(raw, `${path}.${key}`);
        if (!outcome.ok) return outcome;
        entries.push([key, outcome.value]);
      }
      return { ok: true, value: Object.fromEntries(entries) as ObjectOf<S> };
    },
  };
}

/**
 * An array of `item`. Like an `exact` object it takes only a plain `Array` whose
 * entries are enumerable data properties, with no holes and no extra keys.
 */
export function array<T>(item: Schema<T>): Schema<readonly T[]> {
  assertSchema(item);
  return {
    read(value, path) {
      if (!Array.isArray(value)) return fail(path, "array");
      const entries = plainEntries(value);
      if (entries === undefined) return fail(path, "array of plain entries");
      const items: T[] = [];
      for (const [index, entry] of entries.entries()) {
        const outcome = item.read(entry, `${path}[${index}]`);
        if (!outcome.ok) return outcome;
        items.push(outcome.value);
      }
      return { ok: true, value: items };
    },
  };
}

function plainEntries(value: unknown[]): unknown[] | undefined {
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) return undefined;
    const entries: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      entries.push(descriptor.value);
    }
    return entries;
  } catch {
    return undefined;
  }
}

/** The frozen copy of `value` that `schema` accepts, or a `SchemaError` naming the first bad field. */
export function parse<T>(schema: Schema<T>, value: unknown): T {
  const outcome = schema.read(value, "$");
  if (!outcome.ok) throw new SchemaError(outcome.path, outcome.expected, outcome.cause);
  return deepFreeze(outcome.value);
}

/** True when `schema` accepts `value`. */
export function is<T>(schema: Schema<T>, value: unknown): value is T {
  return schema.read(value, "$").ok;
}
