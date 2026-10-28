import { describe, expect, it, vi } from "vitest";

import { DacsError } from "../../src/errors.js";

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

// Keep a broken surrogate traversal from hanging a table row before its verdict.
const boundedStringVerdict = (value: string): { accepted: boolean; reads: number } => {
  const charCodeAt = String.prototype.charCodeAt;
  let reads = 0;
  const spy = vi.spyOn(String.prototype, "charCodeAt").mockImplementation(function (
    this: string,
    index: number,
  ) {
    if (this === value && ++reads > value.length + 1) {
      expect(reads, "surrogate traversal exceeded one pass")
        .toBeLessThanOrEqual(value.length + 1);
    }
    return charCodeAt.call(this, index);
  });
  try {
    return { accepted: isSafeJsonString(value), reads };
  } finally {
    spy.mockRestore();
  }
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
    expect(boundedStringVerdict(value).accepted).toBe(true);
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
    expect(boundedStringVerdict(value).accepted).toBe(false);
  });

  it("accepts a surrogate pair without revisiting its code units", () => {
    const input = "\ud800\udc00";
    const verdict = boundedStringVerdict(input);
    expect(verdict.accepted).toBe(true);
    expect(verdict.reads).toBeLessThanOrEqual(input.length + 1);
  });
});

describe("negative zero by snapshot boundary", () => {
  it.each([
    ["direct", { omitted: undefined }],
    ["nested", { nested: { omitted: undefined } }],
  ])("rejects %s undefined members at the received boundary instead of erasing them", (_label, value) => {
    expect(() => snapshotCanonicalJsonReceived(value, "received artifact"))
      .toThrow("received artifact is not stable canonical JSON");
    expect(causeOf(() => snapshotCanonicalJsonReceived(value, "received artifact")))
      .toBe("not data-only JSON");
  });

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

  // allowNegativeZero relaxes only -0: other out-of-profile numbers still fail.
  it.each([
    ["unsafe integer", { n: 2 ** 53 }],
    ["negative unsafe integer in an array", { n: [-(2 ** 53)] }],
    ["NaN", { n: NaN }],
    ["Infinity", { n: Infinity }],
  ])("still refuses %s at the read and received boundaries", (_label, value) => {
    expect(() => snapshotCanonicalJsonReceived(value, "received artifact"))
      .toThrow(/received artifact is not stable canonical JSON/);
    expect(() => snapshotCanonicalJsonRead(value, "stored artifact"))
      .toThrow(/stored artifact is not stable canonical JSON/);
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

  it("rejects proxy constructors without invoking their descriptor trap", () => {
    let descriptorReads = 0;
    const constructor = new Proxy(Object, {
      getOwnPropertyDescriptor(target, key) {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const input = Object.create({ constructor });

    expect(causeOf(() => snapshotCanonicalJson(input, "artifact")))
      .toBe("not data-only JSON");
    expect(descriptorReads).toBe(0);
  });

  it("rejects a custom prototype borrowing the Object constructor", () => {
    const input = Object.create({ constructor: Object });

    expect(causeOf(() => snapshotCanonicalJson(input, "artifact")))
      .toBe("not data-only JSON");
  });

  it("accepts both inclusive safe magnitude endpoints", () => {
    const input = { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };

    expect(snapshotCanonicalJson(input, "artifact")).toEqual(input);
    expect(snapshotWireJsonRead(input, "wire")).toEqual(input);
  });

  it("rejects a keyless callable while accepting a null-prototype object", () => {
    const callable = () => 1;
    for (const key of Reflect.ownKeys(callable)) {
      Reflect.deleteProperty(callable, key);
    }
    Object.setPrototypeOf(callable, null);
    expect(Reflect.ownKeys(callable)).toEqual([]);

    expect(causeOf(() => snapshotWireJsonRead(callable, "wire")))
      .toBe("not data-only JSON");
    const input = Object.assign(Object.create(null), { n: 1 });
    expect(snapshotWireJsonRead(input, "wire")).toEqual({ n: 1 });
    expect(snapshotCanonicalJson(input, "artifact")).toEqual({ n: 1 });
  });

  it("rejects an array with only its length made read-only", () => {
    const input = [1];
    Object.defineProperty(input, "length", { writable: false });

    expect(causeOf(() => snapshotCanonicalJson(input, "artifact")))
      .toBe("not data-only JSON");
    expect(causeOf(() => snapshotCanonicalJsonReceived(input, "received")))
      .toBe("not data-only JSON");
    expect(snapshotCanonicalJsonRead(input, "stored")).toEqual([1]);
  });

  it("rejects extra array properties before cloning can drop them", () => {
    const input = Object.assign([1], { extra: 2 });

    expect(causeOf(() => snapshotCanonicalJson(input, "artifact")))
      .toBe("not data-only JSON");
    expect(causeOf(() => snapshotWireJsonRead(input, "wire")))
      .toBe("not data-only JSON");
  });

  it.each(["writable", "configurable", "enumerable"])(
    "rejects an array index with only %s disabled",
    (attribute) => {
      const input = [1];
      Object.defineProperty(input, "0", { [attribute]: false });

      expect(causeOf(() => snapshotCanonicalJson(input, "artifact")))
        .toBe("not data-only JSON");
      expect(causeOf(() => snapshotCanonicalJsonReceived(input, "received")))
        .toBe("not data-only JSON");
      if (attribute !== "enumerable") {
        expect(snapshotCanonicalJsonRead(input, "stored")).toEqual([1]);
      }
    },
  );

  it.each(["writable", "configurable"])(
    "rejects an object member with only %s disabled",
    (attribute) => {
      const input = { n: 1 };
      Object.defineProperty(input, "n", { [attribute]: false });

      expect(causeOf(() => snapshotCanonicalJson(input, "artifact")))
        .toBe("not data-only JSON");
      expect(causeOf(() => snapshotCanonicalJsonReceived(input, "received")))
        .toBe("not data-only JSON");
      expect(snapshotCanonicalJsonRead(input, "stored")).toEqual({ n: 1 });
    },
  );

  it("rejects a cycle without repeatedly reading its descriptors", () => {
    const input: { self?: unknown } = {};
    input.self = input;
    const getDescriptors = Object.getOwnPropertyDescriptors;
    let reads = 0;
    const spy = vi.spyOn(Object, "getOwnPropertyDescriptors").mockImplementation((value) => {
      if (value === input && ++reads > 1) {
        throw new Error("repeated cycle traversal");
      }
      return getDescriptors(value);
    });
    let cause: string;
    try {
      cause = causeOf(() => snapshotCanonicalJson(input, "artifact"));
    } finally {
      spy.mockRestore();
    }
    expect(cause).toBe("not data-only JSON");
    expect(reads).toBe(1);
  });
});

describe("snapshot errors", () => {
  it("preserves the initial data-only TypeError as the cause", () => {
    for (const snapshot of [
      snapshotCanonicalJson,
      snapshotCanonicalJsonConfig,
      snapshotCanonicalJsonRead,
      snapshotCanonicalJsonReceived,
      snapshotWireJsonRead,
    ]) {
      let caught: unknown;
      try {
        snapshot({ nested: [undefined] }, "input");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DacsError);
      expect((caught as Error).cause).toBeInstanceOf(TypeError);
      expect(((caught as Error).cause as Error).message).toBe("not data-only JSON");
    }

    // The configuration boundary alone may omit undefined object members.
    expect(causeOf(() => snapshotWireJsonRead({ n: undefined }, "wire")))
      .toBe("not data-only JSON");
    expect(snapshotCanonicalJsonConfig({ n: undefined }, "config")).toEqual({});
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
