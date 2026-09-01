import { describe, expect, test } from "vitest";

import {
  attestationAddress,
  decodeAddressSegment,
  encodeAddressSegment,
  listingAddress,
  paymentEvidenceAddress,
  ratingAddress,
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

  test("assembles DACS-2 attestation addresses with only the identifier encoded", () => {
    expect(
      attestationAddress("job-abc", "cci-xm", "evm:mainnet:0x1234", 3),
    ).toBe("dacs2:job-abc:cci-xm:evm%3Amainnet%3A0x1234:v3");
    expect(attestationAddress("job-abc", "lei", "984500ABCDEF12345678", 3)).toBe(
      "dacs2:job-abc:lei:984500ABCDEF12345678:v3",
    );
  });

  test("assembles unresolved and resolved DACS-4 payment-evidence addresses", () => {
    expect(
      paymentEvidenceAddress("DACS-VERIFY-SETTLE-0001", "evm-erc20:1:USDC", 0),
    ).toBe("dacs4:payment:DACS-VERIFY-SETTLE-0001:evm-erc20%3A1%3AUSDC:0");
    expect(paymentEvidenceAddress("job-abc", "pay-x402", 4, true)).toBe(
      "dacs4:payment:job-abc:pay-x402:4:resolved",
    );
  });

  test("assembles DACS-5 rating addresses with the rater encoded", () => {
    expect(ratingAddress("job-abc", "cci-xm:evm:mainnet:0x1234")).toBe(
      "dacs5:rating:job-abc:cci-xm%3Aevm%3Amainnet%3A0x1234",
    );
  });

  test("rejects ambiguous structural segments and invalid numeric segments", () => {
    expect(() => attestationAddress("job:abc", "lei", "984500ABCDEF12345678", 3))
      .toThrow(/jobId/);
    expect(() => attestationAddress("job-abc", "LEI", "984500ABCDEF12345678", 3))
      .toThrow(/lowercase/);
    expect(() => attestationAddress("job-abc", "lei", "984500ABCDEF12345678", 0))
      .toThrow(/recipeVersion/);
    expect(() => paymentEvidenceAddress("job-abc", "pay-x402", -1)).toThrow(
      /phaseIndex/,
    );
  });
});
