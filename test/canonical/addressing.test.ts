import { describe, expect, test } from "vitest";

import {
  decodeAddressSegment,
  encodeAddressSegment,
  listingAddress,
  listingRevocationAddress,
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

  test("assembles the independent RB-1 revocation marker address", () => {
    expect(
      listingRevocationAddress("cci-xm:evm:mainnet:0x1234", "rfq:lot", 3),
    ).toBe(
      "dacs1-revoked:cci-xm%3Aevm%3Amainnet%3A0x1234:rfq%3Alot:v3",
    );
    expect(() => listingRevocationAddress("seller", "listing", 0)).toThrow(
      /positive safe integer/,
    );
  });
});
