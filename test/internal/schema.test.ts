import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import { DacsError, TransientError } from "../../src/errors.js";
import {
  array,
  hash,
  integer,
  is,
  literal,
  object,
  oneOf,
  optional,
  parse,
  refine,
  SchemaError,
  string,
  type Infer,
} from "../../src/internal/schema.js";

interface OldGuards {
  isStr(value: unknown): boolean;
  isObj(value: unknown): boolean;
  isOneOf(set: readonly string[], value: unknown): boolean;
  hasExactWireKeys(value: unknown, required: readonly string[], optional?: readonly string[]): boolean;
  isExactWireArray(value: unknown, validate: (entry: unknown) => boolean): boolean;
  isSafeUint(value: unknown): boolean;
  isOptionalStr(value: unknown): boolean;
}

const OLD_NAMES = ["isStr", "isObj", "isOneOf", "hasExactWireKeys", "isExactWireArray", "isSafeUint", "isOptionalStr"];

/**
 * The guards the validators use are module-private, so this reads their
 * declarations out of the source file and runs them in this realm. The
 * comparison below always runs against the code as it stands.
 */
function loadOldGuards(): OldGuards {
  const path = fileURLToPath(new URL("../../src/artifacts/validators.ts", import.meta.url));
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
  const found = new Map<string, string>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && OLD_NAMES.includes(declaration.name.text)) {
        found.set(declaration.name.text, statement.getText(file));
      }
    }
  }
  const missing = OLD_NAMES.filter((name) => !found.has(name));
  if (missing.length > 0) throw new Error(`validators.ts no longer declares: ${missing.join(", ")}`);
  const script = ts.transpileModule([...found.values()].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInThisContext(`(() => {\n${script}\nreturn { ${OLD_NAMES.join(", ")} };\n})()`) as OldGuards;
}

const old = loadOldGuards();

type Outcome = { result: boolean } | { threw: string };
const run = (fn: () => boolean): Outcome => {
  try {
    return { result: fn() };
  } catch (error) {
    return { threw: String(error) };
  }
};

/** Runs both checks on every input and requires the same answer, a thrown error included. */
function expectSame(inputs: ReadonlyArray<readonly [string, unknown]>, ours: (value: unknown) => boolean, theirs: (value: unknown) => boolean): void {
  const seen = new Set<string>();
  for (const [name, value] of inputs) {
    const expected = run(() => theirs(value));
    expect({ name, ...run(() => ours(value)) }).toEqual({ name, ...expected });
    seen.add("result" in expected ? String(expected.result) : "threw");
  }
  expect(seen).toContain("true");
  expect(seen).toContain("false");
}

const boom = () => {
  throw new Error("boom");
};
const throwing = (trap: string, target: object = { a: "x" }) => new Proxy(target, { [trap]: boom });
const revoked = (): object => {
  const { proxy, revoke } = Proxy.revocable({ a: "x" }, {});
  revoke();
  return proxy;
};
class Instance {
  a = "x";
}
class Sub extends Array<unknown> {}
const symbolKey = Symbol("k");
const hiddenSymbol = Object.defineProperty({ a: "x" }, symbolKey, { value: 1, enumerable: false });
const hiddenKey = Object.defineProperty({ b: "y" }, "a", { value: "x", enumerable: false });
const nullProto = (fields: Record<string, unknown>) => Object.assign(Object.create(null) as Record<string, unknown>, fields);
const arrayWithoutPrototype = Object.setPrototypeOf(["x"], null) as unknown[];
const functionOnObjectPrototype = Object.setPrototypeOf(() => "x", Object.prototype) as unknown;
const sparse = new Array<unknown>(2);
sparse[1] = "x";
const holed = [1, 2];
delete holed[0];

const objectInputs: ReadonlyArray<readonly [string, unknown]> = [
  ["required only", { a: "x" }],
  ["required and optional", { a: "x", b: "y" }],
  ["optional present as undefined", { a: "x", b: undefined }],
  ["required present as undefined", { a: undefined }],
  ["empty", {}],
  ["extra key", { a: "x", extra: "z" }],
  ["wrong type", { a: 1 }],
  ["wrong optional type", { a: "x", b: 1 }],
  ["null prototype", nullProto({ a: "x" })],
  ["null prototype, extra key", nullProto({ a: "x", z: "z" })],
  ["class instance", new Instance()],
  ["inherited values", Object.create({ a: "x" })],
  ["inherited optional", Object.assign(Object.create({ b: "y" }), { a: "x" })],
  ["symbol key", { a: "x", [symbolKey]: 1 }],
  ["hidden symbol key", hiddenSymbol],
  ["hidden string key", hiddenKey],
  ["getter", { get a() { return "x"; } }],
  ["getter that throws", { get a(): string { return boom(); } }],
  ["optional getter", { a: "x", get b() { return "y"; } }],
  ["setter only", { set a(_value: string) {} }],
  ["frozen", Object.freeze({ a: "x" })],
  ["Unicode values", { a: "日本語 \u{1F600} é" }],
  ["Unicode key", { a: "x", "日本": "y" }],
  ["array", ["x"]],
  ["empty array", []],
  ["array without a prototype", arrayWithoutPrototype],
  ["function on Object.prototype", functionOnObjectPrototype],
  ["Date", new Date(0)],
  ["Map", new Map([["a", "x"]])],
  ["null", null],
  ["undefined", undefined],
  ["string", "a"],
  ["number", 1],
  ["function", () => "x"],
  ["proxy over a plain object", new Proxy({ a: "x" }, {})],
  ["proxy: getPrototypeOf throws", throwing("getPrototypeOf")],
  ["proxy: ownKeys throws", throwing("ownKeys")],
  ["proxy: getOwnPropertyDescriptor throws", throwing("getOwnPropertyDescriptor")],
  ["revoked proxy", revoked()],
];

describe("exact mode", () => {
  const shape = { a: refine(() => true), b: optional(refine(() => true)) };
  const exact = object(shape);

  it("is the default mode", () => {
    expect(is(object(shape), { a: "x", extra: "y" })).toBe(false);
    expect(is(object(shape, { mode: "exact" }), { a: "x" })).toBe(true);
  });

  it("gives the same answer as hasExactWireKeys on every input", () => {
    expectSame(objectInputs, (value) => is(exact, value), (value) => old.hasExactWireKeys(value, ["a"], ["b"]));
  });

  it("gives the same answer with no keys allowed, and with only optional keys", () => {
    expectSame(objectInputs, (value) => is(object({}), value), (value) => old.hasExactWireKeys(value, []));
    expectSame(
      objectInputs,
      (value) => is(object({ a: optional(refine(() => true)) }), value),
      (value) => old.hasExactWireKeys(value, [], ["a"]),
    );
  });

  it("matches hasExactWireKeys with the field checks the validators put after it", () => {
    const typed = object({ a: string(), b: optional(string()) });
    const theirs = (value: unknown) => {
      if (!old.hasExactWireKeys(value, ["a"], ["b"])) return false;
      const record = value as Record<string, unknown>;
      return old.isStr(record.a) && old.isOptionalStr(record.b);
    };
    expectSame(objectInputs, (value) => is(typed, value), theirs);
  });

  it("does not run a getter or a get trap: it reads descriptor values", () => {
    let reads = 0;
    const withGetter = { get a() { reads += 1; return "x"; } };
    expect(is(exact, withGetter)).toBe(false);
    expect(reads).toBe(0);
    const getTrap = throwing("get");
    expect(old.hasExactWireKeys(getTrap, ["a"], ["b"])).toBe(true);
    expect(parse(object({ a: string() }), getTrap)).toEqual({ a: "x" });
  });

  it("checks nested objects and arrays by the same rules", () => {
    const nested = object({ inner: object({ list: array(string()) }) });
    expect(is(nested, { inner: { list: ["x"] } })).toBe(true);
    expect(is(nested, { inner: { list: ["x"], extra: 1 } })).toBe(false);
    expect(is(nested, { inner: Object.create({ list: ["x"] }) })).toBe(false);
    expect(is(nested, { inner: { list: sparse } })).toBe(false);
  });
});

describe("open mode", () => {
  const open = object({ a: string(), b: optional(string()) }, { mode: "open" });
  const theirs = (value: unknown) => {
    if (!old.isObj(value)) return false;
    const record = value as Record<string, unknown>;
    return old.isStr(record.a) && old.isOptionalStr(record.b);
  };

  it("gives the same answer as isObj with property reads on every input", () => {
    expectSame(objectInputs, (value) => is(open, value), theirs);
  });

  it("accepts any non-array object and nothing else", () => {
    const anything = object({}, { mode: "open" });
    expectSame(objectInputs, (value) => is(anything, value), (value) => old.isObj(value));
  });

  it("accepts extra keys and a present undefined optional", () => {
    expect(is(open, { a: "x", extra: 1, more: { deep: true } })).toBe(true);
    expect(is(open, { a: "x", b: undefined })).toBe(true);
    expect(is(open, { a: "x", b: 1 })).toBe(false);
  });

  it("reads inherited values and getters, as the old property reads do", () => {
    expect(is(open, Object.create({ a: "x" }))).toBe(true);
    expect(is(open, new Instance())).toBe(true);
    expect(is(open, { get a() { return "x"; } })).toBe(true);
  });

  it("lets a throw from a property read escape instead of reporting it as bad data", () => {
    const hostile = { get a(): string { return boom(); } };
    expect(() => is(open, hostile)).toThrow("boom");
    expect(() => parse(open, throwing("get"))).toThrow("boom");
    expect(() => parse(open, revoked())).toThrow(TypeError);
  });

  it("applies the mode to the object it is set on, not to its children", () => {
    const mixed = object({ inner: object({ x: string() }) }, { mode: "open" });
    expect(is(mixed, { inner: { x: "1" }, extra: true })).toBe(true);
    expect(is(mixed, { inner: { x: "1", extra: true } })).toBe(false);
  });
});

describe("integer", () => {
  const numbers: ReadonlyArray<readonly [string, unknown]> = [
    ["zero", 0],
    ["negative zero", -0],
    ["one", 1],
    ["minus one", -1],
    ["largest safe", Number.MAX_SAFE_INTEGER],
    ["first unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["smallest safe", Number.MIN_SAFE_INTEGER],
    ["fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["numeric string", "1"],
    ["bigint", 1n],
    ["boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["array", [1]],
    ["Number object", Object(1)],
  ];

  it("with min 0 gives the same answer as isSafeUint, negative zero included", () => {
    expectSame(numbers, (value) => is(integer({ min: 0 }), value), (value) => old.isSafeUint(value));
    expect(is(integer({ min: 0 }), -0)).toBe(true);
    expect(Object.is(parse(integer({ min: 0 }), -0), -0)).toBe(true);
  });

  it("applies min and max inclusively and accepts negatives when unbounded below", () => {
    const bounded = integer({ min: 2, max: 4 });
    expect([1, 2, 3, 4, 5].map((value) => is(bounded, value))).toEqual([false, true, true, true, false]);
    expect(is(integer(), -5)).toBe(true);
    expect(is(integer({ max: -1 }), 0)).toBe(false);
    expect(is(integer({ max: 0 }), -0)).toBe(true);
  });

  it("names the bounds in expected", () => {
    const failure = failureOf(integer({ min: 0, max: 9 }), 10);
    expect(failure.expected).toContain("0");
    expect(failure.expected).toContain("9");
  });
});

describe("string", () => {
  it("accepts any string by default and nothing else", () => {
    const schema = string();
    expect([ "", "x", "日本語", "\u{1F600}"].map((value) => is(schema, value))).toEqual([true, true, true, true]);
    expect([1, null, undefined, {}, ["x"], new String("x"), true].map((value) => is(schema, value))).toEqual([false, false, false, false, false, false, false]);
    expectSame([["empty", ""], ["text", "x"], ["number", 1], ["undefined", undefined]], (value) => is(schema, value), (value) => old.isStr(value));
  });

  it("nonEmpty counts UTF-16 units, so any one character passes", () => {
    const schema = string({ nonEmpty: true });
    expect(is(schema, "")).toBe(false);
    expect(is(schema, " ")).toBe(true);
    expect(is(schema, "é")).toBe(true);
    expect(is(schema, "\u{1F600}")).toBe(true);
  });

  it("tests the pattern against the whole value as the pattern is written", () => {
    const claimRef = string({ pattern: /^[a-z][a-z0-9-]*:.+$/ });
    expect(is(claimRef, "dacs:agent-1")).toBe(true);
    expect(is(claimRef, "dacs:")).toBe(false);
    expect(is(claimRef, "Dacs:x")).toBe(false);
    expect(is(claimRef, "dacs:日本語")).toBe(true);
    expect(is(claimRef, "dacs:a\nb")).toBe(false);
    expect(is(string({ pattern: /ab/ }), "xxabxx")).toBe(true);
    expect(is(string({ pattern: /^\w+$/ }), "é")).toBe(false);
  });

  it("combines pattern and nonEmpty and gives the same answer on repeated calls", () => {
    const schema = string({ pattern: /^a*$/, nonEmpty: true });
    expect([ "", "a", "aa", "b", "a"].map((value) => is(schema, value))).toEqual([false, true, true, false, true]);
  });

  it("refuses a pattern whose matching depends on state", () => {
    expect(() => string({ pattern: /a/g })).toThrow(TypeError);
    expect(() => string({ pattern: /a/y })).toThrow(TypeError);
    expect(() => string({ pattern: "a" as unknown as RegExp })).toThrow(TypeError);
  });
});

describe("hash", () => {
  const digest = "0123456789abcdef".repeat(4);

  it("accepts exactly 64 lower-case hex characters", () => {
    expect(is(hash(), digest)).toBe(true);
    expect(is(hash(), digest.toUpperCase())).toBe(false);
    expect(is(hash(), digest.slice(1))).toBe(false);
    expect(is(hash(), `${digest}0`)).toBe(false);
    expect(is(hash(), `0x${digest}`)).toBe(false);
    expect(is(hash(), `${digest}\n`)).toBe(false);
    expect(is(hash(), `${digest.slice(1)}g`)).toBe(false);
    expect(is(hash(), 1)).toBe(false);
    expect(is(hash(), null)).toBe(false);
  });
});

describe("literal and oneOf", () => {
  it("literal accepts only the same value of the same type", () => {
    expect(is(literal("x"), "x")).toBe(true);
    expect(is(literal("x"), "y")).toBe(false);
    expect(is(literal(1), "1")).toBe(false);
    expect(is(literal(1), 1)).toBe(true);
    expect(is(literal(true), 1)).toBe(false);
    expect(is(literal(null), null)).toBe(true);
    expect(is(literal(null), undefined)).toBe(false);
  });

  it("oneOf gives the same answer as isOneOf", () => {
    const values = ["a", "b"] as const;
    const inputs: ReadonlyArray<readonly [string, unknown]> = [
      ["first", "a"],
      ["second", "b"],
      ["other", "c"],
      ["empty", ""],
      ["number", 1],
      ["null", null],
      ["undefined", undefined],
      ["inherited name", "toString"],
      ["proto name", "__proto__"],
      ["case", "A"],
    ];
    expectSame(inputs, (value) => is(oneOf(values), value), (value) => old.isOneOf(values, value));
  });

  it("oneOf keeps the list it was given even if the caller changes the array later", () => {
    const values = ["a", "b"];
    const schema = oneOf(values);
    values.push("c");
    expect(is(schema, "c")).toBe(false);
  });
});

describe("array", () => {
  const arrayInputs: ReadonlyArray<readonly [string, unknown]> = [
    ["empty", []],
    ["strings", ["a", "b"]],
    ["one wrong entry", ["a", 1]],
    ["sparse", sparse],
    ["deleted entry", holed],
    ["extra property", Object.assign(["a"], { extra: 1 })],
    ["subclass", Sub.from(["a"])],
    ["no prototype", arrayWithoutPrototype],
    ["getter entry", Object.defineProperty(["a"], "0", { get: () => "a", enumerable: true })],
    ["hidden entry", Object.defineProperty(["a"], "0", { value: "a", enumerable: false })],
    ["frozen", Object.freeze(["a"])],
    ["Unicode", ["日本語", "\u{1F600}"]],
    ["proxy over an array", new Proxy(["a"], {})],
    ["proxy: getPrototypeOf throws", throwing("getPrototypeOf", ["a"])],
    ["proxy: ownKeys throws", throwing("ownKeys", ["a"])],
    ["proxy: getOwnPropertyDescriptor throws", throwing("getOwnPropertyDescriptor", ["a"])],
    ["revoked proxy", revoked()],
    ["array-like", { 0: "a", length: 1 }],
    ["string", "ab"],
    ["typed array", new Uint8Array(1)],
    ["null", null],
    ["undefined", undefined],
  ];

  it("gives the same answer as isExactWireArray on every input", () => {
    expectSame(arrayInputs, (value) => is(array(string()), value), (value) => old.isExactWireArray(value, old.isStr));
  });

  it("reports the index of the first failing entry", () => {
    expect(failureOf(array(integer()), [1, 2, "3", "4"]).path).toBe("$[2]");
  });

  it("lets a throw from an entry check escape", () => {
    const bad = array(refine(boom));
    expect(() => is(bad, ["a"])).toThrow("boom");
    expect(is(bad, [])).toBe(true);
  });
});

describe("optional", () => {
  it("accepts undefined or what the inner check accepts", () => {
    const schema = optional(string({ nonEmpty: true }));
    expect(is(schema, undefined)).toBe(true);
    expect(is(schema, "x")).toBe(true);
    expect(is(schema, "")).toBe(false);
    expect(is(schema, null)).toBe(false);
  });

  it("leaves an absent or undefined optional field out of the result", () => {
    const open = object({ a: string(), b: optional(string()) }, { mode: "open" });
    expect(Object.hasOwn(parse(open, { a: "x" }), "b")).toBe(false);
    expect(Object.hasOwn(parse(open, { a: "x", b: undefined }), "b")).toBe(false);
    expect(parse(open, { a: "x", b: "y" })).toEqual({ a: "x", b: "y" });
  });
});

describe("refine", () => {
  const isEven = (value: unknown): value is number => typeof value === "number" && value % 2 === 0;

  it("accepts what the predicate accepts and reports the label it was given", () => {
    const schema = refine(isEven, "an even number");
    expect(is(schema, 2)).toBe(true);
    expect(is(schema, 3)).toBe(false);
    expect(failureOf(schema, 3).expected).toBe("an even number");
    expect(failureOf(refine(isEven), 3).expected).not.toBe("");
  });

  it("composes inside objects and arrays", () => {
    const schema = object({ values: array(refine(isEven, "an even number")) });
    expect(failureOf(schema, { values: [2, 4, 5] })).toMatchObject({ path: "$.values[2]", expected: "an even number" });
  });

  it("treats a permanent DacsError from the predicate as bad data and keeps it as the cause", () => {
    const cause = new DacsError("not canonical", { category: "permanent" });
    const schema = refine(() => { throw cause; }, "canonical");
    expect(is(schema, "x")).toBe(false);
    expect(caught(() => parse(schema, "x"))).toMatchObject({ code: "schema.invalid_field", expected: "canonical" });
    expect((caught(() => parse(schema, "x")) as Error).cause).toBe(cause);
  });

  it("does not turn any other throw into bad data", () => {
    const programmer = new TypeError("predicate bug");
    const outage = new TransientError("rpc down");
    const plain = new Error("plain");
    for (const thrown of [programmer, outage, plain]) {
      const schema = refine(() => { throw thrown; });
      expect(caught(() => is(schema, "x"))).toBe(thrown);
      expect(caught(() => parse(schema, "x"))).toBe(thrown);
      expect(caught(() => parse(object({ field: schema }), { field: "x" }))).toBe(thrown);
    }
  });

  it("rejects a predicate that is not a function when the schema is built", () => {
    expect(() => refine(undefined as unknown as () => boolean)).toThrow(TypeError);
  });

  it("hands back a copy of an accepted object and does not freeze the caller's object", () => {
    const input = { nested: { n: 1 } };
    const output = parse(refine((value) => typeof value === "object"), input) as typeof input;
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.isFrozen(output.nested)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.nested)).toBe(false);
  });

  it("returns the very copy the predicate checked, even when a getter answers differently on each read", () => {
    const seen: unknown[] = [];
    const schema = refine((value): value is { signer: string } => {
      seen.push(value);
      return (value as { signer: string }).signer === "approved";
    });
    for (const [first, later] of [["approved", "attacker"], ["attacker", "approved"]]) {
      let reads = 0;
      const input = { get signer() { reads += 1; return reads === 1 ? first : later; } };
      seen.length = 0;
      if (first === "approved") {
        const output = parse(schema, input);
        expect(output.signer).toBe("approved");
        expect(output).toBe(seen[0]);
      } else {
        expect(is(schema, input)).toBe(false);
      }
    }
  });

  it("says no, and does not throw, for a value that cannot be copied", () => {
    const schema = refine(() => true, "anything");
    const uncloneable = [
      { run() { return 1; } },
      { symbol: Symbol("x") },
      new Proxy({}, {}),
      { get boom(): string { throw new Error("getter"); } },
    ];
    for (const input of uncloneable) {
      expect(is(schema, input)).toBe(false);
      expect(caught(() => parse(schema, input))).toMatchObject({ code: "schema.invalid_field", expected: "anything" });
    }
  });

  it("refuses a Map, a Set or a Date, top level or nested, because freezing cannot make them read-only", () => {
    const schema = refine(() => true, "plain data");
    for (const input of [new Map([["a", 1]]), new Set([1]), new Date(0), { nested: [new Map()] }]) {
      expect(is(schema, input)).toBe(false);
    }
    expect(is(refine((value) => value instanceof Map), new Map())).toBe(false);
    expect(is(schema, { nested: [1, { n: 2 }] })).toBe(true);
  });
});

describe("definitions that are wrong are programmer errors", () => {
  it("throw TypeError when the schema is built, not a data failure at parse time", () => {
    expect(() => object({ a: {} as never })).toThrow(TypeError);
    expect(() => object({ a: undefined as never })).toThrow(TypeError);
    expect(() => object({}, { mode: "closed" as never })).toThrow(TypeError);
    expect(() => array({} as never)).toThrow(TypeError);
    expect(() => optional(null as never)).toThrow(TypeError);
    expect(() => oneOf([])).toThrow(TypeError);
    expect(() => oneOf([1] as never)).toThrow(TypeError);
    expect(() => integer({ min: 1.5 })).toThrow(TypeError);
    expect(() => integer({ min: 3, max: 2 })).toThrow(TypeError);
    expect(() => integer({ max: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it("a schema whose own check throws is not reported as bad data by parse or is", () => {
    const broken = { read: () => { throw new TypeError("schema bug"); } };
    expect(() => parse(broken, 1)).toThrow("schema bug");
    expect(() => is(broken, 1)).toThrow("schema bug");
    expect(() => parse({} as never, 1)).toThrow(TypeError);
  });
});

describe("parse", () => {
  const schema = object({
    user: object({
      name: string({ nonEmpty: true }),
      tags: array(object({ id: integer({ min: 0 }), digest: hash() })),
      kind: oneOf(["person", "agent"]),
      version: literal(1),
    }),
  });
  const digest = "ab".repeat(32);
  const valid = () => ({ user: { name: "Ada", tags: [{ id: 0, digest }, { id: 7, digest }], kind: "agent", version: 1 } });

  it("returns a deeply frozen copy and leaves the input alone", () => {
    const input = valid();
    const output = parse(schema, input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.user)).toBe(true);
    expect(Object.isFrozen(output.user.tags)).toBe(true);
    expect(Object.isFrozen(output.user.tags[1])).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.user.tags[0])).toBe(false);
    input.user.name = "changed";
    expect(output.user.name).toBe("Ada");
  });

  it("freezes a top-level array and returns primitives as they are", () => {
    expect(Object.isFrozen(parse(array(integer()), [1, 2]))).toBe(true);
    expect(parse(string(), "x")).toBe("x");
    expect(parse(optional(string()), undefined)).toBeUndefined();
  });

  it("names the path of the first bad field and what was expected there", () => {
    const input = valid();
    input.user.tags[1]!.id = -1;
    const error = caught(() => parse(schema, input)) as SchemaError;
    expect(error).toBeInstanceOf(DacsError);
    expect(error).toBeInstanceOf(SchemaError);
    expect(error.code).toBe("schema.invalid_field");
    expect(error.category).toBe("permanent");
    expect(error.path).toBe("$.user.tags[1].id");
    expect(error.expected).toContain("integer");
    expect(error.message).toBe(`${error.path}: expected ${error.expected}`);
  });

  it("reports the top level as $ and a wrong object kind at its own path", () => {
    expect(failureOf(schema, null).path).toBe("$");
    expect(failureOf(schema, { user: [] }).path).toBe("$.user");
    expect(failureOf(schema, { user: { ...valid().user, extra: 1 } }).path).toBe("$.user");
    expect(failureOf(schema, { user: { ...valid().user, kind: "robot" } }).path).toBe("$.user.kind");
    expect(failureOf(schema, { user: { ...valid().user, version: 2 } }).path).toBe("$.user.version");
  });

  it("does not put the rejected value in the error", () => {
    const error = caught(() => parse(object({ secret: integer() }), { secret: "hunter2-token" })) as SchemaError;
    expect(JSON.stringify([error.message, error.path, error.expected])).not.toContain("hunter2");
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it("carries a key called __proto__ as data", () => {
    const input = JSON.parse('{"__proto__":"x"}') as unknown;
    const output = parse(object({ ["__proto__"]: string() }), input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(output, "__proto__")?.value).toBe("x");
  });

  it("does not carry extra keys of an open object", () => {
    const output = parse(object({ a: string() }, { mode: "open" }), { a: "x", extra: 1 });
    expect(output).toEqual({ a: "x" });
  });
});

describe("is", () => {
  it("returns false for data failures and true for good data, and never throws for either", () => {
    const schema = object({ a: integer({ min: 0 }) });
    for (const [, value] of objectInputs) expect(() => is(schema, value)).not.toThrow();
    expect(is(schema, { a: 1 })).toBe(true);
    expect(is(schema, { a: "1" })).toBe(false);
  });

  it("narrows the type of the value", () => {
    const value: unknown = { a: 1 };
    const schema = object({ a: integer() });
    if (is(schema, value)) expectTypeOf(value).toEqualTypeOf<{ readonly a: number }>();
  });
});

describe("Infer", () => {
  it("gives the type each check accepts", () => {
    const schema = object({
      name: string(),
      count: integer(),
      digest: hash(),
      kind: oneOf(["a", "b"]),
      one: literal(1),
      note: optional(string()),
      items: array(object({ id: integer() })),
      anything: refine((value): value is boolean => typeof value === "boolean"),
    });
    expectTypeOf<Infer<typeof schema>>().toEqualTypeOf<{
      readonly name: string;
      readonly count: number;
      readonly digest: string;
      readonly kind: "a" | "b";
      readonly one: 1;
      readonly note?: string | undefined;
      readonly items: readonly { readonly id: number }[];
      readonly anything: boolean;
    }>();
  });
});

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function failureOf(schema: Parameters<typeof parse>[0], value: unknown): SchemaError {
  return caught(() => parse(schema, value)) as SchemaError;
}
