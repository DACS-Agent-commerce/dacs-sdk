import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/canonical/index.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey, signedBytes } from "../../src/crypto/index.js";

import {
  evaluateRailAvailabilitySelection,
  type RailAvailabilityAuthority,
} from "../../src/registry/index.js";

interface Vector {
  name: string;
  expected: "pass" | "fail" | "error" | "indeterminate";
  rail: Record<string, unknown>;
  ctx: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/standard-next/rail-availability-selection-v0.1.json",
    ),
    "utf8",
  ),
) as { count: number; vectors: Vector[] };

const authority = (ctx: Record<string, unknown>): RailAvailabilityAuthority => ({
  stewardClaim: (ctx.stewardClaim as string | null) ?? null,
  stewardPublicKey: (ctx.stewardPublicKey as string | null) ?? null,
  pinnedRailDigest: (ctx.pinnedRailDigest as string | null) ?? null,
  sessionState: ctx.sessionState as "new" | "in-flight",
  operatorPreflightOk: ctx.operatorPreflightOk as boolean,
  operatorContext: ctx.operatorContext as RailAvailabilityAuthority["operatorContext"],
});

describe("DACS-4 RAV-R1..RAV-R5 rail availability", () => {
  it("accepts a correctly signed signatures extension and refuses its mutation", () => {
    const vector = fixture.vectors.find((item) => item.name === "live-signed-pinned")!;
    const seed = new Uint8Array(32).fill(43);
    const key = rawPublicKey(publicKeyFromSeed(seed));
    const claim = `did:demos:agent:${Buffer.from(key).toString("hex")}`;
    const rail = structuredClone(vector.rail) as Record<string, any>;
    rail.signatures = [{ note: "authenticated extension" }];
    rail.signature.signer = claim;
    const digest = contentHash(rail);
    rail.signature.value = Buffer.from(ed25519Sign(signedBytes("dacs-rail:v1:", digest), privateKeyFromSeed(seed))).toString("base64url");
    const trusted = { ...authority(vector.ctx), stewardClaim: claim,
      stewardPublicKey: Buffer.from(key).toString("base64url"), pinnedRailDigest: digest };
    expect(evaluateRailAvailabilitySelection(rail, trusted).decision).toBe("pass");
    for (const signatures of [[], [{ note: "changed" }]]) {
      expect(evaluateRailAvailabilitySelection({ ...rail, signatures }, trusted).decision).toBe("fail");
    }
  });

  it("replays every adopted Standard security vector", () => {
    expect(fixture.count).toBe(28);
    expect(fixture.vectors).toHaveLength(28);
    for (const vector of fixture.vectors) {
      expect(
        evaluateRailAvailabilitySelection(vector.rail, authority(vector.ctx)).decision,
        vector.name,
      ).toBe(vector.expected);
    }
  });

  it("keeps the entire RailDefinition, including unknown members, in the signature scope", () => {
    const vector = fixture.vectors.find((item) => item.name === "live-signed-pinned")!;
    for (const mutate of [
      (rail: Record<string, any>) => { rail.asset.symbol = "USDT"; },
      (rail: Record<string, any>) => {
        rail.network.resourceBaseUrl = "https://attacker.example/pay";
      },
      (rail: Record<string, any>) => { rail.parameters.authorization = "permit2"; },
      (rail: Record<string, any>) => { rail.governance.acceptedAt = 999; },
      (rail: Record<string, any>) => { rail.futureSignedMember = "preserved-by-SIG-5"; },
      (rail: Record<string, any>) => { rail.signatures = [{ appended: true }]; },
    ]) {
      const rail = structuredClone(vector.rail);
      mutate(rail);
      expect(
        evaluateRailAvailabilitySelection(rail, authority(vector.ctx)).decision,
      ).toBe("fail");
    }
    const appended = structuredClone(vector.rail);
    appended.signatures = [{ appended: true }];
    expect(
      evaluateRailAvailabilitySelection(appended, authority(vector.ctx)),
    ).toMatchObject({ decision: "fail", reason: "signature-invalid" });
  });

  it("does not let discovery or counterparty hints alter authenticated selection", () => {
    for (const vector of fixture.vectors.filter(
      (item) => item.ctx.discoveryAvailabilityHint !== undefined,
    )) {
      const withoutHint = structuredClone(vector.ctx);
      delete withoutHint.discoveryAvailabilityHint;
      expect(
        evaluateRailAvailabilitySelection(vector.rail, authority(vector.ctx)).decision,
      ).toBe(
        evaluateRailAvailabilitySelection(vector.rail, authority(withoutHint)).decision,
      );
    }
  });

  it("rejects extra caller authority fields instead of normalising them away", () => {
    const vector = fixture.vectors.find((item) => item.name === "live-signed-pinned")!;
    expect(
      evaluateRailAvailabilitySelection(vector.rail, {
        ...authority(vector.ctx),
        discoveryAvailabilityHint: "failed",
      }).decision,
    ).toBe("error");
  });

  it("fails closed on accessor and proxy authority inputs without invoking them", () => {
    let touched = false;
    const source = {
      get stewardClaim() {
        touched = true;
        return "did:demos:steward";
      },
    };
    const result = evaluateRailAvailabilitySelection({}, source);
    expect(result.decision).toBe("error");
    expect(touched).toBe(false);
    expect(evaluateRailAvailabilitySelection({}, new Proxy({}, {})).decision).toBe(
      "error",
    );
  });
});
