import { describe, expect, it } from "vitest";

import {
  isSafeJsonString,
  snapshotCanonicalJson,
  snapshotCanonicalJsonConfig,
  snapshotCanonicalJsonRead,
  snapshotCanonicalJsonReceived,
  snapshotWireJsonRead,
} from "../../src/canonical/snapshot.js";

const causeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return ((error as Error).cause as Error).message;
  }
  throw new Error("expected the snapshot to throw");
};

describe("isSafeJsonString", () => {
  it.each([
    "",
    "plain",
    "\ud800\udc00",
    "\udbff\udfff",
    "\ud800\udfff",
    "a\ud800\udc00b",
  ])("accepts %j", (value) => {
    expect(isSafeJsonString(value)).toBe(true);
  });

  it.each([
    "\ud800",
    "\ud800a",
    "\ud800\ue000",
    "\udc00",
    "\udfff",
    "a\udc00",
    "\udbff",
    "\udc00\ud800",
  ])("rejects lone surrogate %j", (value) => {
    expect(isSafeJsonString(value)).toBe(false);
  });
});

describe("negative zero by snapshot boundary", () => {
  it.each([
    ["top-level", -0],
    ["object member", { n: -0 }],
    ["array element", { n: [-0] }],
  ])("refuses %s negative zero at the authoring and configuration boundaries", (_label, value) => {
    expect(() => snapshotCanonicalJson(value, "artifact"))
      .toThrow(/artifact is not stable canonical JSON/);
    expect(causeOf(() => snapshotCanonicalJson(value, "artifact")))
      .toBe("not data-only JSON");
    expect(causeOf(() => snapshotCanonicalJsonConfig(value, "config")))
      .toBe("not data-only JSON");
  });

  it.each([
    ["top-level", -0],
    ["object member", { n: -0 }],
    ["array element", { n: [-0] }],
  ])("refuses %s negative zero on the wire read before cloning", (_label, value) => {
    expect(() => snapshotWireJsonRead(value, "signed transaction"))
      .toThrow(/signed transaction is not stable wire JSON/);
    expect(causeOf(() => snapshotWireJsonRead(value, "signed transaction")))
      .toBe("not data-only JSON");
  });

  it("owns received negative zero as zero and keeps strict descriptors", () => {
    const received = snapshotCanonicalJsonReceived(
      { n: -0, list: [-0, { m: -0 }] },
      "received artifact",
    );
    expect(received).toEqual({ n: 0, list: [0, { m: 0 }] });
    expect(Object.is(received.n, 0)).toBe(true);
    expect(Object.is(received.list[0], 0)).toBe(true);
    expect(Object.is((received.list[1] as { m: number }).m, 0)).toBe(true);

    const frozen = Object.freeze({ n: -0 });
    expect(causeOf(() => snapshotCanonicalJsonReceived(frozen, "received artifact")))
      .toBe("not data-only JSON");
    expect(Object.is(snapshotCanonicalJsonRead(frozen, "stored artifact").n, 0))
      .toBe(true);
  });
});

describe("strict canonical snapshot", () => {
  it.each([
    ["exotic value in an array", [new Date(0)]],
    ["accessor inside an array", [{ get x() { return 1; } }]],
    ["symbol-keyed member", { [Symbol("hidden")]: 1, a: 1 }],
    ["frozen array", Object.freeze([1])],
    ["array subclass instance", { list: class Tagged extends Array {}.of(1) }],
    ["null-prototype array", { list: Object.setPrototypeOf([1], null) }],
    ["lone surrogate value", { s: "\ud800" }],
    ["lone surrogate member name", { ["\udc00"]: 1 }],
    ["unsafe integer", { n: 2 ** 53 }],
  ])("rejects %s", (_label, value) => {
    expect(causeOf(() => snapshotCanonicalJson(value, "artifact")))
      .toBe("not data-only JSON");
  });

  it("rejects accessors at the configuration boundary", () => {
    expect(causeOf(() =>
      snapshotCanonicalJsonConfig({ get x() { return 1; } }, "config"),
    )).toBe("not data-only JSON");
  });
});

describe("snapshotWireJsonRead", () => {
  it("owns frozen wire JSON without sorting keys or normalising strings", () => {
    const child = Object.freeze({
      operation: "subtract",
      account: "ab",
      label: "e\u0301",
    });
    const input = Object.freeze({
      content: Object.freeze({
        type: "native",
        gcr_edits: Object.freeze([child]),
      }),
      signature: Object.freeze({ type: "ed25519", data: "00" }),
      hash: "12",
    });

    const snapshot = snapshotWireJsonRead(input, "signed transaction");

    expect(snapshot).not.toBe(input);
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(input));
    expect(snapshot.content).not.toBe(input.content);
    expect(snapshot.content.gcr_edits).not.toBe(input.content.gcr_edits);
    expect(snapshot.content.gcr_edits[0]).not.toBe(child);
    expect(Object.keys(snapshot)).toEqual(["content", "signature", "hash"]);
    expect(Object.keys(snapshot.content)).toEqual(["type", "gcr_edits"]);
    expect(Object.keys(snapshot.content.gcr_edits[0]!)).toEqual([
      "operation",
      "account",
      "label",
    ]);
    expect(snapshot.content.gcr_edits[0]!.label).toBe("e\u0301");
  });

  it.each([
    ["proxy", new Proxy({ value: 1 }, {})],
    ["accessor", Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    })],
    ["undefined", { value: undefined }],
    ["exotic prototype", Object.create({ inherited: true })],
    ["sparse array", new Array(1)],
    ["negative zero", { n: -0 }],
    ["nested negative zero", { n: [-0] }],
    ["unsafe integer", { n: 2 ** 53 }],
    ["lone high surrogate", { s: "\ud800" }],
    ["lone low surrogate", { s: "a\udc00" }],
    ["lone surrogate member name", { ["\udbff"]: 1 }],
  ])("rejects %s input", (_label, value) => {
    expect(() => snapshotWireJsonRead(value, "signed transaction"))
      .toThrow(/signed transaction is not stable wire JSON/);
  });
});
