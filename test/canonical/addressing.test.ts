import { describe, expect, test } from "vitest";

import {
  decodeAddressSegment,
  encodeAddressSegment,
  listingAddress,
  listingStorageName,
} from "../../src/canonical/addressing.js";

describe("CF-4 logical addressing (§6.3.4)", () => {
  // Golden vector: cf4-encode-delimiters
  const RAW = "cci-xm:evm:mainnet:0x1234?x=1&y=100%";
  const ENCODED = "cci-xm%3Aevm%3Amainnet%3A0x1234%3Fx%3D1%26y%3D100%25";

  test("encodes the five reserved delimiters with uppercase hex, nothing else", () => {
    expect(encodeAddressSegment(RAW)).toBe(ENCODED);
  });

  test("decode is the exact inverse (round-trips the golden vector)", () => {
    expect(decodeAddressSegment(ENCODED)).toBe(RAW);
    expect(decodeAddressSegment(encodeAddressSegment(RAW))).toBe(RAW);
  });

  test("does not encode unreserved bytes", () => {
    expect(encodeAddressSegment("0x1234abcdEF-_.~")).toBe("0x1234abcdEF-_.~");
  });

  // Golden vector: cf4-dacs1-listing-address
  test("assembles a dacs1 listing address with encoded variable segments", () => {
    expect(listingAddress("cci-xm:evm:mainnet:0x1234", "rfq:lot?x=1", 3)).toBe(
      "dacs1:cci-xm%3Aevm%3Amainnet%3A0x1234:rfq%3Alot%3Fx%3D1:v3",
    );
  });

  test("accepts a pre-formatted version segment", () => {
    expect(listingAddress("a", "b", "v3")).toBe("dacs1:a:b:v3");
  });

  test("listingStorageName maps a colon-bearing logical address to a colon-free native name (#46)", () => {
    const logical = listingAddress("cci-xm:evm:mainnet:0x1234", "rfq:lot", 3);
    const name = listingStorageName(logical);
    expect(logical).toContain(":"); // logical address is colon-bearing…
    expect(name).not.toContain(":"); // …native storage-program name is not (Demos rejects `:`)
    expect(name).toMatch(/^dacs1-[0-9a-f]{64}$/); // opaque, deterministic
    expect(listingStorageName(logical)).toBe(name); // deterministic re-derivation → discoverable
  });
});
