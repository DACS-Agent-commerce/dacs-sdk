import { describe, expect, test } from "vitest";

import {
  canonicalContentHash,
  contentHash,
  signatureScopeHash,
  stripSignature,
} from "../../src/canonical/index.js";

describe("signed-scope hashing", () => {
  test("separates signature payloads from complete stored content", () => {
    const first = { value: "bound", signature: { value: "first" } };
    const second = { value: "bound", signature: { value: "second" } };

    expect(signatureScopeHash(first)).toBe(signatureScopeHash(second));
    expect(contentHash(first)).toBe(signatureScopeHash(first));
    expect(canonicalContentHash(first)).not.toBe(canonicalContentHash(second));
  });

  test("preserves an own __proto__ field as signed data without changing the prototype", () => {
    const record = JSON.parse(
      '{"value":"bound","__proto__":{"value":"unsigned"},"signature":"00"}',
    ) as Record<string, unknown>;

    const scope = stripSignature(record) as Record<string, unknown>;

    expect(Object.getPrototypeOf(scope)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(scope, "__proto__")).toBe(true);
    expect(scope["__proto__"]).toEqual({ value: "unsigned" });
    expect(scope["signature"]).toBeUndefined();
    expect(contentHash(record)).not.toBe(contentHash({ value: "bound" }));
  });

  test("rejects the lone-surrogate collision that UTF-8 replacement would create", () => {
    expect(() => contentHash({ value: "\ud800" })).toThrow(
      /not stable canonical JSON/,
    );
    expect(() => contentHash({ value: "\ufffd" })).not.toThrow();
  });

  test("does not invoke or erase non-JSON properties while stripping signatures", () => {
    let getterInvoked = false;
    const accessor = { value: "bound", signature: "00" };
    Object.defineProperty(accessor, "extension", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return "unsigned";
      },
    });
    expect(() => contentHash(accessor)).toThrow(/not stable canonical JSON/);
    expect(getterInvoked).toBe(false);

    const hidden = { value: "bound", signature: "00" };
    Object.defineProperty(hidden, "extension", { value: "unsigned" });
    expect(() => contentHash(hidden)).toThrow(/not stable canonical JSON/);
  });
});
