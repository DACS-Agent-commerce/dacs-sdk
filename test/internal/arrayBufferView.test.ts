import { describe, expect, it } from "vitest";
import { containsArrayBufferView } from "../../src/internal/arrayBufferView.js";

describe("containsArrayBufferView", () => {
  it("finds typed arrays and DataViews at any depth, empty or not", () => {
    expect(containsArrayBufferView(new Uint8Array(0))).toBe(true);
    expect(containsArrayBufferView({ a: [{ b: new Int16Array([1]) }] })).toBe(true);
    expect(containsArrayBufferView({ view: new DataView(new ArrayBuffer(2)) })).toBe(true);
  });

  it("is false for plain JSON-shaped data and primitives", () => {
    expect(containsArrayBufferView({ a: [1, "x", null, { b: true }] })).toBe(false);
    expect(containsArrayBufferView(null)).toBe(false);
    expect(containsArrayBufferView("bytes")).toBe(false);
  });

  it("visits a cycle once", () => {
    const node: Record<string, unknown> = {};
    node.self = node;
    expect(containsArrayBufferView(node)).toBe(false);
  });
});
