import { describe, expect, it } from "vitest";

import { snapshotWireJsonRead } from "../../src/canonical/snapshot.js";

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
  ])("rejects %s input", (_label, value) => {
    expect(() => snapshotWireJsonRead(value, "signed transaction"))
      .toThrow(/signed transaction is not stable wire JSON/);
  });
});
