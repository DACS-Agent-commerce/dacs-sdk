import { describe, expect, it } from "vitest";

import {
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
  requireCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../../src/identity/index.js";

describe("CORE B.1 canonical ClaimReference", () => {
  it("parses exact CF-2 bytes and derives the parameter-free CF-3 identity", () => {
    const reference = "cci-xm:evm:8453:0xAbC?jurisdiction=US&note=a%3Ab";
    expect(parseCanonicalClaimReference(reference)).toEqual({
      reference,
      identity: { scheme: "cci-xm", identifier: "evm:8453:0xAbC" },
    });
    expect(sameCanonicalClaimIdentity(reference, "cci-xm:evm:8453:0xAbC")).toBe(true);
    expect(sameCanonicalClaimIdentity(reference, "cci-xm:evm:8453:0xabc")).toBe(false);
  });

  it.each([
    "DID:demos:agent:abc",
    "did:demos:agent:e\u0301",
    "did:demos:agent:abc?z=1&a=2",
    "did:demos:agent:abc?a=1&a=2",
    "did:demos:agent:abc?a=x:y",
    "did:demos:agent:abc?a=x%3ay",
    "did:demos:agent:abc?a=x%41y",
    "did:demos:agent:abc?",
    "did:demos:agent:abc?a",
  ])("rejects non-canonical CF-2 form %s", (reference) => {
    expect(isCanonicalClaimReference(reference)).toBe(false);
  });

  it("sorts parameter keys by their decoded Unicode code points", () => {
    expect(isCanonicalClaimReference("x-test:id?0=value&%3Akey=value")).toBe(true);
    expect(isCanonicalClaimReference("x-test:id?%3Akey=value&0=value")).toBe(false);
  });

  it("enforces the registered CF-2 identifier profiles", () => {
    const demosKey = "ab".repeat(32);
    expect(isCanonicalClaimReference(
      `did:demos:agent:${demosKey}?jurisdiction=GB`,
    )).toBe(true);
    expect(isCanonicalClaimReference(
      `did:demos:agent:${demosKey.toUpperCase()}`,
    )).toBe(false);

    expect(isCanonicalClaimReference("domain:example.com")).toBe(true);
    expect(isCanonicalClaimReference("domain:xn--fa-hia.example")).toBe(true);
    expect(isCanonicalClaimReference("domain:EXAMPLE.COM")).toBe(false);
    expect(isCanonicalClaimReference("domain:example.com?region=GB")).toBe(false);
    expect(isCanonicalClaimReference("domain:127.0.0.1")).toBe(false);

    expect(isCanonicalClaimReference("key:abcdef0123456789")).toBe(true);
    expect(isCanonicalClaimReference("key:ABCDEF")).toBe(false);

    expect(isCanonicalClaimReference(
      `erc8004:1:0x${"ab".repeat(20)}:0`,
    )).toBe(true);
    expect(isCanonicalClaimReference("erc8004:01:0xABC:01")).toBe(false);
    expect(isCanonicalClaimReference(
      `erc8004:1:0x${"ab".repeat(20)}:${1n << 256n}`,
    )).toBe(false);
  });

  it("fails closed through the throwing boundary", () => {
    expect(() => requireCanonicalClaimReference("did:demos:agent:abc?a=%"))
      .toThrow(/CORE B\.1 CF-2/);
  });
});
