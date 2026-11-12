import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const modulePath = "../../tools/lint/error-codes.mjs";
const { findErrorClasses, findProblems, readCatalog } = await import(modulePath);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dacs-error-codes-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const CLASSES = [
  "export class DacsError extends Error { declare readonly code?: string; }",
  "export class TransientError extends DacsError {}",
  "export class CounterpartyError extends DacsError {}",
  "export class SubstrateError extends DacsError {}",
].join("\n");

function errorsFile(table = { "schema.invalid_field": "permanent", "net.timeout": "transient" } as Record<string, string>): string {
  return `const codeCategory = ${JSON.stringify(table)} as const satisfies Record<string, string>;\n${CLASSES}\n`;
}

type Retained = { path: string; throw: string; reason?: string };

/** A repo whose `src/migrated.ts` is declared migrated unless `migrated` says otherwise. */
function problemsOf(source: string, options: { retained?: Retained[]; migrated?: string[]; extra?: Record<string, string> } = {}): string[] {
  const root = repo({
    "src/errors.ts": errorsFile(),
    "src/migrated.ts": source,
    "tools/lint/error-codes.json": JSON.stringify({ migrated: options.migrated ?? ["src/migrated.ts"], retainedPlainThrows: options.retained ?? [] }),
    ...options.extra,
  });
  return findProblems(root);
}

describe("error code check", () => {
  it("reads the catalog from src/errors.ts", () => {
    const root = repo({ "src/errors.ts": errorsFile() });
    const { codes, problems } = readCatalog(root);
    expect([...codes]).toEqual([["schema.invalid_field", "permanent"], ["net.timeout", "transient"]]);
    expect(problems).toEqual([]);
  });

  it("refuses a malformed table", () => {
    const root = repo({ "src/errors.ts": errorsFile({ "sdk.unclassified": "permanent", "Bad.Code": "permanent", "net.slow": "weird", "plain": "permanent" }) });
    expect(readCatalog(root).problems).toEqual([
      'src/errors.ts: catalog code "sdk.unclassified" is reserved for lint and cannot be in the catalog',
      'src/errors.ts: catalog code "Bad.Code" is not shaped like domain.reason in lower case',
      'src/errors.ts: catalog code "net.slow" has unknown category "weird"',
      'src/errors.ts: catalog code "plain" is not shaped like domain.reason in lower case',
    ]);
    expect(readCatalog(repo({ "src/errors.ts": CLASSES })).problems).toEqual(["src/errors.ts: no codeCategory table found"]);
  });

  it("finds every class that extends DacsError, through other classes", () => {
    const root = repo({
      "src/errors.ts": errorsFile(),
      "src/a.ts": [
        'import { DacsError, SubstrateError, TransientError } from "./errors.js";',
        "export class Plain extends DacsError {}",
        "export class Deeper extends Plain {}",
        "export class Retry extends TransientError {}",
        'export class Anchor extends SubstrateError { readonly code: string = "x"; }',
        "export class Wire extends DacsError { constructor(readonly code: string) { super(code); } }",
        "export class Unrelated extends Error {}",
      ].join("\n"),
    });
    expect(Object.fromEntries(findErrorClasses(root))).toEqual({
      DacsError: "catalog",
      TransientError: "catalog",
      CounterpartyError: "catalog",
      SubstrateError: "catalog",
      Plain: "closed",
      Deeper: "closed",
      Retry: "closed",
      Anchor: "owned",
      Wire: "owned",
    });
  });

  it("classes the error classes of the real tree and checks a base-class construction against the real errors file", () => {
    const kinds = Object.fromEntries(findErrorClasses(repoRoot));
    for (const name of ["DacsError", "TransientError", "CounterpartyError", "SubstrateError"]) expect(kinds[name]).toBe("catalog");
    for (const name of ["WireError", "RawJsonAdmissionError", "AnchorWaitError"]) expect(kinds[name]).toBe("owned");
    expect(readCatalog(repoRoot).problems).toEqual([]);
    const root = repo({
      "src/errors.ts": readFileSync(join(repoRoot, "src/errors.ts"), "utf8"),
      "src/migrated.ts": 'export const a = new DacsError("x");\nexport const b = new DacsError("x", { code: "sdk.unclassified" });',
      "tools/lint/error-codes.json": JSON.stringify({ migrated: ["src/migrated.ts"], retainedPlainThrows: [] }),
    });
    expect(findProblems(root)).toEqual([
      "src/migrated.ts:1: DacsError must be given a catalog code written as a string literal",
      'src/migrated.ts:2: "sdk.unclassified" marks code that is not classified yet; it is not a catalog code',
    ]);
  });

  it("accepts a coded construction in a migrated file", () => {
    expect(problemsOf([
      'import { DacsError, TransientError } from "./errors.js";',
      'export const a = new DacsError("x", { code: "schema.invalid_field", cause: 1 });',
      'export const b = new TransientError("x", { code: "net.timeout" });',
    ].join("\n"))).toEqual([]);
  });

  it("refuses an uncoded construction in a migrated file", () => {
    const problems = problemsOf([
      'import { DacsError } from "./errors.js";',
      'export const a = new DacsError("x");',
      'export const b = new DacsError("x", { cause: 1 });',
      'export const c = new DacsError("x", { code: someCode });',
      'export const d = new DacsError("x", options);',
    ].join("\n"));
    expect(problems).toEqual([
      "src/migrated.ts:2: DacsError must be given a catalog code written as a string literal",
      "src/migrated.ts:3: DacsError must be given a catalog code written as a string literal",
      "src/migrated.ts:4: DacsError must be given a catalog code written as a string literal",
      "src/migrated.ts:5: DacsError must be given a catalog code written as a string literal",
    ]);
  });

  it("refuses an unknown code and the unclassified marker", () => {
    expect(problemsOf([
      'export const a = new DacsError("x", { code: "schema.invalid_feild" });',
      'export const b = new DacsError("x", { code: "sdk.unclassified" });',
    ].join("\n"))).toEqual([
      'src/migrated.ts:1: "schema.invalid_feild" is not in the catalog in src/errors.ts',
      'src/migrated.ts:2: "sdk.unclassified" marks code that is not classified yet; it is not a catalog code',
    ]);
  });

  it("refuses a catalog code whose category differs from a fixed-category class", () => {
    expect(problemsOf([
      'export const a = new TransientError("x", { code: "schema.invalid_field" });',
      'export const b = new SubstrateError("x", { code: "net.timeout" });',
      'export const c = new TransientError("x", { code: "net.timeout" });',
    ].join("\n"))).toEqual([
      'src/migrated.ts:1: TransientError is transient but "schema.invalid_field" is permanent in the catalog',
      'src/migrated.ts:2: SubstrateError is substrate but "net.timeout" is transient in the catalog',
    ]);
  });

  it("refuses an explicit category beside a code", () => {
    expect(problemsOf('export const a = new DacsError("x", { code: "net.timeout", category: "permanent" });')).toEqual([
      "src/migrated.ts:1: DacsError takes its category from the catalog; remove `category` beside `code`",
    ]);
  });

  it("refuses a subclass that cannot carry a catalog code", () => {
    expect(problemsOf('export const a = new NotImplementedError("feature");', {
      extra: { "src/other.ts": 'export class NotImplementedError extends DacsError {}' },
    })).toEqual(["src/migrated.ts:1: NotImplementedError cannot carry a catalog code; throw a coded DacsError instead"]);
  });

  it("leaves subclass-owned codes outside the catalog but refuses a missing code", () => {
    const owned = { "src/wire.ts": 'export class WireError extends DacsError { constructor(readonly code: string) { super(code); } }' };
    const importFail = 'import { fail } from "./wire/validate.js";';
    expect(problemsOf([
      importFail,
      'export const a = new WireError("bad_sig");',
      'export function f() { return fail("peer_signature_invalid", 401); }',
    ].join("\n"), { extra: owned })).toEqual([]);
    expect(problemsOf([
      importFail,
      "export const a = new WireError();",
      'export const b = new WireError("");',
      "export function f() { return fail(); }",
      'export function g() { return fail("sdk.unclassified"); }',
    ].join("\n"), { extra: owned })).toEqual([
      "src/migrated.ts:2: WireError needs a code argument",
      "src/migrated.ts:3: WireError needs a code argument",
      "src/migrated.ts:4: fail needs a code argument",
      "src/migrated.ts:5: fail needs a code argument",
    ]);
  });

  it("checks a class imported under another name as the class it stands for", () => {
    const imports = [
      'import { DacsError as SDKError, SubstrateError as Chain } from "./errors.js";',
      'import { NotImplementedError as Missing } from "./other.js";',
    ];
    const extra = { "src/other.ts": "export class NotImplementedError extends DacsError {}" };
    expect(problemsOf([...imports,
      'export const a = new SDKError("x", { code: "schema.invalid_field" });',
      'export const b = new Chain("x", { code: "net.timeout" });',
    ].join("\n"), { extra })).toEqual([
      'src/migrated.ts:4: SubstrateError is substrate but "net.timeout" is transient in the catalog',
    ]);
    expect(problemsOf([...imports,
      'export const a = new SDKError("missing code");',
      'export const b = new SDKError("x", { code: "net.timeout", category: "permanent" });',
      'export const c = new Missing("feature");',
    ].join("\n"), { extra })).toEqual([
      "src/migrated.ts:3: DacsError must be given a catalog code written as a string literal",
      "src/migrated.ts:4: DacsError takes its category from the catalog; remove `category` beside `code`",
      "src/migrated.ts:5: NotImplementedError cannot carry a catalog code; throw a coded DacsError instead",
    ]);
  });

  it("checks an owned class imported under another name", () => {
    const owned = {
      "src/wire.ts": "export class WireError extends DacsError { constructor(readonly code: string) { super(code); } }",
      "src/raw.ts": "export class RawJsonAdmissionError extends DacsError { constructor(m: string, readonly code: string) { super(m); } }",
      "src/anchor.ts": "export class AnchorWaitError extends DacsError { constructor(readonly code: string) { super(code); } }",
    };
    const imports = 'import { WireError as Wire, RawJsonAdmissionError as Raw, AnchorWaitError as Wait } from "./all.js";';
    expect(problemsOf([imports, 'export const a = [new Wire("bad"), new Raw("m", "bad"), new Wait("late")];'].join("\n"), { extra: owned })).toEqual([]);
    expect(problemsOf([imports, "export const a = [new Wire(), new Raw(\"m\"), new Wait()];"].join("\n"), { extra: owned })).toEqual([
      "src/migrated.ts:2: WireError needs a code argument",
      "src/migrated.ts:2: RawJsonAdmissionError needs a code argument",
      "src/migrated.ts:2: AnchorWaitError needs a code argument",
    ]);
  });

  it("does not take a local name for the class it shadows when the import renames another class", () => {
    expect(problemsOf([
      'import { Unrelated as DacsError } from "./other.js";',
      'export const a = new DacsError("x");',
    ].join("\n"))).toEqual([]);
  });

  it("checks a helper call only where the name is the real helper", () => {
    const declareReject = 'function reject(stage: string, code: string): never { throw new DacsError(stage, { code: "net.timeout" }); }';
    const rawJson = (...lines: string[]) => ({ migrated: ["src/canonical/rawJson.ts"], extra: { "src/canonical/rawJson.ts": [declareReject, ...lines].join("\n") } });
    const executor = 'export const a = new Promise((resolve, reject) => reject(new DacsError("x", { code: "schema.invalid_field" })));';
    expect(problemsOf(executor)).toEqual([]);
    expect(problemsOf("", rawJson('export function f(code: string) { return reject("parse", code); }', executor))).toEqual([]);
    expect(problemsOf("", rawJson('export function f() { return reject("parse"); }', executor))).toEqual([
      "src/canonical/rawJson.ts:2: reject needs a code argument",
    ]);
    expect(problemsOf([
      'import { fail } from "./other.js";',
      'import { fail as refuse } from "./wire/validate.js";',
      "export function f() { return fail(); }",
      "export function g() { return refuse(); }",
      "export function h(fail: () => void) { return fail(); }",
    ].join("\n"))).toEqual(["src/migrated.ts:4: refuse needs a code argument"]);
  });

  it("refuses plain error throws that are not retained", () => {
    const source = [
      'export function a() { throw new Error("unreachable"); }',
      'export function b() { throw new TypeError("x"); }',
      "export function c(error: unknown) { throw error; }",
      'export function d() { return new Error("returned, not thrown"); }',
    ].join("\n");
    expect(problemsOf(source)).toEqual([
      "src/migrated.ts:1: plain Error throw; throw a coded DacsError, or list it in retainedPlainThrows with a reason",
      "src/migrated.ts:2: plain TypeError throw; throw a coded DacsError, or list it in retainedPlainThrows with a reason",
    ]);
    expect(problemsOf(source, { retained: [
      { path: "src/migrated.ts", throw: 'new Error("unreachable")', reason: "the branch is closed by the switch above" },
      { path: "src/migrated.ts", throw: 'new TypeError("x")', reason: "programmer assertion" },
    ] })).toEqual([]);
  });

  it("refuses a plain error thrown without new unless it is retained", () => {
    const source = [
      'export function a() { throw Error("plain error"); }',
      'export function b() { throw TypeError("x"); }',
      'export function c() { throw RangeError("x"); }',
      'export function d() { throw SyntaxError("x"); }',
      'export function e() { throw makeError("x"); }',
      'export function f() { return Error("returned, not thrown"); }',
    ].join("\n");
    expect(problemsOf(source)).toEqual([
      "src/migrated.ts:1: plain Error throw; throw a coded DacsError, or list it in retainedPlainThrows with a reason",
      "src/migrated.ts:2: plain TypeError throw; throw a coded DacsError, or list it in retainedPlainThrows with a reason",
      "src/migrated.ts:3: plain RangeError throw; throw a coded DacsError, or list it in retainedPlainThrows with a reason",
      "src/migrated.ts:4: plain SyntaxError throw; throw a coded DacsError, or list it in retainedPlainThrows with a reason",
    ]);
    expect(problemsOf(source, { retained: [
      { path: "src/migrated.ts", throw: 'Error("plain error")', reason: "closed by the switch above" },
      { path: "src/migrated.ts", throw: 'TypeError("x")', reason: "programmer assertion" },
      { path: "src/migrated.ts", throw: 'RangeError("x")', reason: "programmer assertion" },
      { path: "src/migrated.ts", throw: 'SyntaxError("x")', reason: "programmer assertion" },
    ] })).toEqual([]);
  });

  it("refuses retained plain throws with no reason or that match nothing", () => {
    expect(problemsOf('export function a() { throw new Error("unreachable"); }', { retained: [
      { path: "src/migrated.ts", throw: 'new Error("unreachable")' },
      { path: "src/migrated.ts", throw: 'new Error("gone")', reason: "was here" },
    ] })).toEqual([
      'tools/lint/error-codes.json: retained throw `new Error("unreachable")` in src/migrated.ts has no reason',
      'tools/lint/error-codes.json: retained throw `new Error("gone")` in src/migrated.ts matches no plain throw',
    ]);
  });

  it("ignores files that are not migrated", () => {
    expect(problemsOf('export const a = new DacsError("x");', { migrated: [] })).toEqual([]);
  });

  it("checks every file in a migrated folder", () => {
    expect(problemsOf("", { migrated: ["src/area/"], extra: { "src/area/deep/one.ts": 'export const a = new DacsError("x");' } })).toEqual([
      "src/area/deep/one.ts:1: DacsError must be given a catalog code written as a string literal",
    ]);
  });

  it("refuses a migrated path that does not exist", () => {
    expect(problemsOf("", { migrated: ["src/nope.ts"] })).toEqual(['tools/lint/error-codes.json: migrated path "src/nope.ts" does not exist']);
  });
});
