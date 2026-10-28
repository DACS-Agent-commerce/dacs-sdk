import { beforeEach, describe, expect, test, vi } from "vitest";

// HTLC-1: the buyer salt comes from the platform CSPRNG. Length and
// distinctness checks alone would also pass a counter, so this pins the source.
const csprng = vi.hoisted(() => ({ calls: [] as number[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    randomBytes: (size: number) => {
      csprng.calls.push(size);
      return Buffer.alloc(size, 0xa5);
    },
  };
});

const { generateHtlcBuyerSalt } = await import("../../src/rails/crossChainHtlc.js");

describe("HTLC-1 buyer salt source", () => {
  beforeEach(() => {
    csprng.calls.length = 0;
  });

  test.each([16, 32, 64])("returns exactly one %i-byte draw from node:crypto randomBytes", (bytes) => {
    const salt = generateHtlcBuyerSalt(bytes);
    expect(csprng.calls).toEqual([bytes]);
    expect(Buffer.from(salt).equals(Buffer.alloc(bytes, 0xa5))).toBe(true);
  });

  test("draws 32 bytes by default and nothing for a salt under 128 bits", () => {
    expect(generateHtlcBuyerSalt().byteLength).toBe(32);
    expect(csprng.calls).toEqual([32]);
    expect(() => generateHtlcBuyerSalt(15)).toThrow("at least 128 bits");
    expect(csprng.calls).toEqual([32]);
  });
});
