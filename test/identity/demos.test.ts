import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  demosAgentClaimRef,
  demosAgentPublicKey,
  isDemosAgentClaimRef,
} from "../../src/identity/demos.js";

interface DemosClaimFixture {
  cases: Array<{
    id: string;
    input: string;
    expected: {
      accepted: boolean;
      canonical: string | null;
    };
  }>;
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../vendor/DACS-Standard/conformance/fixtures/identity/demos-agent-claim-reference.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as DemosClaimFixture;

describe("DACS-1 §6.3.1 Demos agent ClaimReference", () => {
  const hex = "ab".repeat(32);
  const claim = `did:demos:agent:${hex}`;

  test("emits one lowercase canonical writer form", () => {
    expect(demosAgentClaimRef(Uint8Array.from(Buffer.from(hex, "hex"))))
      .toBe(claim);
    expect(demosAgentClaimRef(`0x${hex.toUpperCase()}`)).toBe(claim);
    expect(() => demosAgentClaimRef("ab")).toThrow(/exactly 32 bytes/);
  });

  test("matches every normative Demos ClaimReference fixture", () => {
    for (const entry of fixture.cases) {
      const key = demosAgentPublicKey(entry.input);
      expect(key !== null, entry.id).toBe(entry.expected.accepted);
      expect(isDemosAgentClaimRef(entry.input), entry.id)
        .toBe(entry.expected.accepted);
      expect(key ? demosAgentClaimRef(key) : null, entry.id)
        .toBe(entry.expected.canonical);
    }
  });

  test("rejects foreign schemes, Demos lookalikes, and native addresses", () => {
    for (const invalid of [
      `did:ethr:${hex}`,
      `did:demos:other:${hex}`,
      `did:DEMOS:agent:${hex}`,
      `did:demos:AGENT:${hex}`,
      `did:demos:agent:${hex.toUpperCase()}`,
      `did:demos:agent:${hex.slice(2)}`,
      `arbitrary-prefix:${hex}`,
      `demos:0x${hex}`,
      `0x${hex}`,
      hex,
    ]) {
      expect(demosAgentPublicKey(invalid), invalid).toBeNull();
      expect(isDemosAgentClaimRef(invalid), invalid).toBe(false);
    }
  });
});
