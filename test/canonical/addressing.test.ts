import { describe, expect, test } from "vitest";

import {
  attestationAddress,
  decodeAddressSegment,
  encodeAddressSegment,
  listingAddress,
  paymentEvidenceAddress,
  ratingAddress,
} from "../../src/canonical/addressing.js";
import { classifyAnchor } from "../../src/discovery/scanner.js";

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
  test("assembles a dacs1 listing address with the claim encoded and the URL-safe listingId as is", () => {
    const address = listingAddress("cci-xm:evm:mainnet:0x1234", "rfq-lot-x-1", 3);
    expect(address).toBe("dacs1:cci-xm%3Aevm%3Amainnet%3A0x1234:rfq-lot-x-1:v3");
    expect(classifyAnchor(address)).toBe("listing");
  });

  // Not a Standard vector: a legacy serviceId may hold reserved bytes, which the
  // legacy read arm addresses this way. CF-4 does not classify it as a listing.
  test("encodes a legacy serviceId that holds reserved delimiters", () => {
    const address = listingAddress("cci-xm:evm:mainnet:0x1234", "rfq:lot?x=1", 3);
    expect(address).toBe("dacs1:cci-xm%3Aevm%3Amainnet%3A0x1234:rfq%3Alot%3Fx%3D1:v3");
    expect(classifyAnchor(address)).toBe("unknown");
  });

  test("accepts a pre-formatted version segment", () => {
    expect(listingAddress("a", "b", "v3")).toBe("dacs1:a:b:v3");
  });

  test("accepts bare string versions and the legacy numeric zero version", () => {
    expect(listingAddress("a", "b", "3")).toBe("dacs1:a:b:v3");
    expect(listingAddress("a", "b", 0)).toBe("dacs1:a:b:v0");
  });

  test.each([-1, 1.5])("rejects invalid numeric Listing version %s", (version) => {
    expect(() => listingAddress("a", "b", version)).toThrow(/non-negative integer/);
  });

  test.each(["", "cafe\u0301"])("rejects noncanonical structural jobId %j", (job) => {
    expect(() => attestationAddress(job, "lei", "id", 1)).toThrow(/jobId/);
    expect(() => paymentEvidenceAddress(job, "rail", 0)).toThrow(/jobId/);
    expect(() => ratingAddress(job, "rater")).toThrow(/jobId/);
  });

  test("rejects empty variable values at every strict builder", () => {
    expect(() => attestationAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "lei", "", 1)).toThrow(/identifier/);
    expect(() => paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "", 0)).toThrow(/railId/);
    expect(() => ratingAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "")).toThrow(/rater/);
  });

  test.each(["1lei", "lei!"])("rejects scheme junk %s at either boundary", (scheme) => {
    expect(() => attestationAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", scheme, "id", 1)).toThrow(/scheme/);
  });

  test.each([null, 0, 1, "true", {}])("rejects nonboolean resolved flag %j", (resolved) => {
    expect(() => paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "rail", 0, resolved as boolean))
      .toThrow(/resolved flag must be boolean/);
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

  // The builders refuse what classifyAnchor refuses in a variable segment.
  test.each([
    ["a lone high surrogate", "evm\ud800erc20"],
    ["a lone low surrogate", "evm\udc00erc20"],
    ["non-NFC text", "café"],
  ])("rejects a variable segment with %s", (_name, value) => {
    expect(() => attestationAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "lei", value, 3)).toThrow(/identifier/);
    expect(() => paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", value, 0)).toThrow(/railId/);
    expect(() => ratingAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", value)).toThrow(/rater/);
  });

  test.each(["my wallet", "id\tvalue", "id\u0000value", "id\u0085value"])(
    "preserves scheme-specific text %j for the artifact verifier", (value) => {
      const job = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
      const address = attestationAddress(job, "cci-xm", `evm:1:${value}`, 1);
      expect(address).toBe(`dacs2:${job}:cci-xm:evm%3A1%3A${value}:v1`);
      expect(classifyAnchor(address)).toBe("verification-result");
      expect(classifyAnchor(ratingAddress(job, `cci-xm:evm:1:${value}`))).toBe("rating");
      expect(classifyAnchor(paymentEvidenceAddress(job, value, 0))).toBe("settlement-evidence");
    },
  );

  test("accepts a paired surrogate, and the classifier agrees", () => {
    const address = ratingAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "did:web:😀.example");
    expect(address).toBe("dacs5:rating:01J8ME0SXKQ4T9V2RC5HJ6WX7D:did%3Aweb%3A😀.example");
    expect(classifyAnchor(address)).toBe("rating");
  });

  // CF-2 normalization precedes CF-4 delimiter encoding.
  test.each([
    ["colon + combining acute", "did:web:\u0301x"],
    ["question mark + combining dot", "evm?\u0307x"],
    ["equals + combining dot", "evm=\u0307x"],
  ])("discovers builder output with %s", (_name, value) => {
    const job = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
    expect(value.normalize("NFC")).toBe(value);
    const encoded = encodeAddressSegment(value);
    expect(encoded.normalize("NFC")).not.toBe(encoded);
    expect(decodeAddressSegment(encoded)).toBe(value);
    expect(classifyAnchor(ratingAddress(job, value))).toBe("rating");
    expect(classifyAnchor(paymentEvidenceAddress(job, value, 0))).toBe("settlement-evidence");
    expect(classifyAnchor(attestationAddress(job, "cci-xm", value, 1))).toBe("verification-result");
    expect(classifyAnchor(listingAddress(value, "svc", 1))).toBe("listing");
  });
});
