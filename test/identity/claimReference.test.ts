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
      schemeStatus: "registered",
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

    expect(isCanonicalClaimReference(`key:${"ab".repeat(8)}`)).toBe(true);
    expect(isCanonicalClaimReference("key:ABCDEF")).toBe(false);

    expect(isCanonicalClaimReference(
      `erc8004:1:0x${"ab".repeat(20)}:0`,
    )).toBe(true);
    expect(isCanonicalClaimReference("erc8004:01:0xABC:01")).toBe(false);
    expect(isCanonicalClaimReference(
      `erc8004:1:0x${"ab".repeat(20)}:${1n << 256n}`,
    )).toBe(false);
  });

  it.each([
    "cci-xm:solana:mainnet:123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
    "cci-web2:twitter:alice",
    "cci-pqc:falcon:abcdef",
    "cci-ud:alice.crypto",
    "cci-nomis:subject",
    "cci-humanpassport:subject",
    "cci-ethos:subject",
    "cci-tlsn:abcdef",
    "lei:984500ABCDEF12345678",
    "finra-crd:123456",
    "sam-uei:ABCDEFGHIJKL",
    "fedramp:FR123456",
    "naics:123456",
    "cmmc:CERT-123",
    "stor-cred:ofac-clear:subject",
    "did:web:example.com",
    `erc8004:1:0x${"ab".repeat(20)}:0`,
    "domain:example.com",
    `key:${"ab".repeat(8)}`,
    "substrate-validator-set:demos-mainnet:42",
    "substrate-validator-set:demos-testnet:0",
  ])("classifies the registered v0.1 profile %s", (reference) => {
    expect(parseCanonicalClaimReference(reference)?.schemeStatus).toBe("registered");
  });

  it.each([
    "cci-xm:solana",
    "cci-xm:solana::address",
    "cci-xm:solana:mainnet:0OIl",
    "cci-web2:twitter",
    "cci-web2:unknown:alice",
    "cci-pqc:falcon",
    "cci-pqc:unknown:abcdef",
    "stor-cred:typeonly",
    "substrate-validator-set:demos-mainnet",
    "substrate-validator-set:evil:42",
    "substrate-validator-set:demos-mainnet:01",
    "substrate-validator-set:demos-mainnet:epoch-42",
    "lei:lowercase1234567890",
    "finra-crd:0123",
    "sam-uei:abcdefgh1234",
    "naics:12345",
  ])("rejects malformed registered-profile bytes %s", (reference) => {
    expect(isCanonicalClaimReference(reference)).toBe(false);
  });

  it.each([
    "cci-xm:EVM:8453:0x1111111111111111111111111111111111111111",
    "cci-xm:evm:mainnet:0x1111111111111111111111111111111111111111",
    "cci-xm:evm:testnet:0x1111111111111111111111111111111111111111",
    "cci-xm:evm:sepolia:0x1111111111111111111111111111111111111111",
    "cci-xm:evm:08453:0x1111111111111111111111111111111111111111",
    "cci-xm:evm:0:0x1111111111111111111111111111111111111111",
  ])("keeps non-PB-2 EVM coordinates readable as generic cci-xm claims: %s", (reference) => {
    expect(parseCanonicalClaimReference(reference)).toMatchObject({
      reference,
      schemeStatus: "registered",
    });
  });

  it("preserves and explicitly classifies unknown schemes", () => {
    const reference = "x-example:opaque:id?note=a%3Ab";
    expect(parseCanonicalClaimReference(reference)).toEqual({
      reference,
      identity: { scheme: "x-example", identifier: "opaque:id" },
      schemeStatus: "unknown",
    });
    // The CCI-native regulatory contexts are explicitly deferred beyond v0.1;
    // their unprefixed equivalents above remain the registered v0.1 schemes.
    expect(parseCanonicalClaimReference("cci-lei:future")?.schemeStatus)
      .toBe("unknown");
  });

  it("fails closed through the throwing boundary", () => {
    expect(() => requireCanonicalClaimReference("did:demos:agent:abc?a=%"))
      .toThrow(/CORE B\.1 CF-2/);
  });
});
