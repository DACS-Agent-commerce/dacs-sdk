import { describe, expect, test } from "vitest";
import {
  demosAgentClaimRef,
  demosAgentPublicKey,
  isDemosAgentClaimRef,
} from "../../src/identity/demos.js";

describe("DACS-1 Demos agent ClaimReference", () => {
  const hex = "ab".repeat(32);
  const claim = `did:demos:agent:${hex}`;

  test("emits one lowercase canonical form from bytes or hex", () => {
    expect(demosAgentClaimRef(Uint8Array.from(Buffer.from(hex, "hex")))).toBe(claim);
    expect(demosAgentClaimRef(`0x${hex.toUpperCase()}`)).toBe(claim);
  });

  test("resolves the canonical DID profile and case-insensitive scheme", () => {
    expect(Buffer.from(demosAgentPublicKey(claim) ?? []).toString("hex")).toBe(hex);
    expect(isDemosAgentClaimRef(claim)).toBe(true);
    expect(Buffer.from(demosAgentPublicKey(`DID:demos:agent:${hex}`) ?? []).toString("hex")).toBe(hex);
    expect(demosAgentClaimRef(demosAgentPublicKey(`DID:demos:agent:${hex}`)!)).toBe(claim);
    expect(isDemosAgentClaimRef(`DiD:demos:agent:${hex}`)).toBe(true);
    expect(demosAgentPublicKey(`did:demos:agent:${hex.toUpperCase()}`)).toBeNull();
    expect(demosAgentPublicKey(`did:DEMOS:agent:${hex}`)).toBeNull();
    expect(demosAgentPublicKey(`demos:0x${hex}`)).toBeNull();
    expect(isDemosAgentClaimRef(`demos:0x${hex}`)).toBe(false);
  });

  test("rejects values that are not a 32-byte public key", () => {
    expect(() => demosAgentClaimRef("ab")).toThrow(/32 bytes/);
    expect(() => demosAgentClaimRef(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});
