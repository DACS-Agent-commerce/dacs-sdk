import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

  test("accepts only case variation in the leading DID scheme", () => {
    expect(Buffer.from(demosAgentPublicKey(claim) ?? []).toString("hex")).toBe(hex);
    expect(Buffer.from(demosAgentPublicKey(`DID:demos:agent:${hex}`) ?? []).toString("hex")).toBe(hex);
    expect(demosAgentClaimRef(demosAgentPublicKey(`DiD:demos:agent:${hex}`)!)).toBe(claim);
    expect(isDemosAgentClaimRef(`dId:demos:agent:${hex}`)).toBe(true);

    for (const invalid of [
      `did:demos:agent:${hex.toUpperCase()}`,
      `did:DEMOS:agent:${hex}`,
      `did:demos:AGENT:${hex}`,
      `did:demos:other:${hex}`,
      `did:ethr:${hex}`,
      `arbitrary-prefix:${hex}`,
      `demos:0x${hex}`,
      `0x${hex}`,
      hex,
    ]) {
      expect(demosAgentPublicKey(invalid), invalid).toBeNull();
      expect(isDemosAgentClaimRef(invalid), invalid).toBe(false);
    }
  });

  test("rejects values that are not a 32-byte public key", () => {
    expect(() => demosAgentClaimRef("ab")).toThrow(/32 bytes/);
    expect(() => demosAgentClaimRef(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => demosAgentClaimRef(new Uint8Array(33))).toThrow(/32 bytes/);
    expect(() => demosAgentClaimRef("g".repeat(64))).toThrow(/32 bytes/);
  });

  test("replays the pinned Standard ClaimReference fixture", () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../vendor/DACS-Standard/conformance/fixtures/identity/demos-agent-claim-reference.json",
        import.meta.url,
      ),
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      cases: Array<{
        id: string;
        input: string;
        expected: { accepted: boolean; canonical: string | null };
      }>;
    };

    for (const vector of fixture.cases) {
      const key = demosAgentPublicKey(vector.input);
      expect(key !== null, vector.id).toBe(vector.expected.accepted);
      expect(key ? demosAgentClaimRef(key) : null, vector.id).toBe(vector.expected.canonical);
    }
  });
});
