import { describe, expect, it } from "vitest";
import { deepFreeze } from "../../src/internal/deepFreeze.js";

describe("deepFreeze", () => {
  it("freezes nested objects and arrays and returns the same value", () => {
    const value = { a: { b: [{ c: 1 }] } };
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[0])).toBe(true);
  });

  it("walks into a parent that is already frozen", () => {
    const child = { list: [{ value: 1 }] };
    const parent = Object.freeze({ child });
    expect(deepFreeze(parent)).toBe(parent);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.list)).toBe(true);
    expect(Object.isFrozen(child.list[0])).toBe(true);
  });

  it("leaves non-empty typed arrays unfrozen instead of throwing", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const value = { bytes, view: new DataView(new ArrayBuffer(4)), next: { n: 1 } };
    expect(() => deepFreeze(value)).not.toThrow();
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.next)).toBe(true);
    expect(Object.isFrozen(bytes)).toBe(false);
  });

  it("visits shared and cyclic references once", () => {
    const shared = { n: 1 };
    const node: { shared: typeof shared; again: typeof shared; self?: unknown } = { shared, again: shared };
    node.self = node;
    expect(() => deepFreeze(node)).not.toThrow();
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(shared)).toBe(true);
  });

  it("returns primitives and null unchanged", () => {
    for (const value of [null, undefined, 0, "s", true, 1n]) expect(deepFreeze(value)).toBe(value);
  });
});
