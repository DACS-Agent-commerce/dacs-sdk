import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test } from "vitest";

import {
  deriveIdentityTier,
  claimScheme,
  claimHasStructuralProof,
  type BundleClaimLike,
  type IdentityBundleLike,
} from "../../src/identity/tier.js";

// The predicate is REQUIRED — tests exercise the structural-only opt-in
// explicitly (the offline read; NOT IT-1-conformant on its own).
const derive = (b: IdentityBundleLike | null | undefined) =>
  deriveIdentityTier(b, claimHasStructuralProof);

const verified = (ref: string): BundleClaimLike => ({
  ref,
  verifiedBy: {
    anchor: { kind: "storage-program", locator: `stor-verify-${ref}` },
    contentHash: "a".repeat(64),
    recipeVersion: 1,
  },
});
const selfAsserted = (ref: string): BundleClaimLike => ({ ref });

describe("deriveIdentityTier (§6.3.2.1, IT-1..IT-3)", () => {
  test("claimScheme reads the scheme before the first colon, lower-cased", () => {
    expect(claimScheme("lei:529900T8BM49AURSDO55")).toBe("lei");
    expect(claimScheme("DOMAIN:example.com")).toBe("domain");
    expect(claimScheme("nocolon")).toBe("");
  });

  test("IT-1: a verified authority-issued (tier-1) claim → institutional", () => {
    expect(
      derive({ claims: [selfAsserted("key:aaaa"), verified("lei:5299")] }),
    ).toBe("institutional");
  });

  test("IT-2: a verified non-tier-1 claim → verified", () => {
    expect(
      derive({ claims: [selfAsserted("key:bbbb"), verified("domain:example.com")] }),
    ).toBe("verified");
  });

  test("IT-2: a verified key: is `verified` (verification status, not scheme strength)", () => {
    expect(derive({ claims: [verified("key:bbbb")] })).toBe("verified");
  });

  test("IT-3: only a raw key / no verified claim → self-declared", () => {
    expect(derive({ claims: [selfAsserted("key:cccc")] })).toBe("self-declared");
    expect(derive({ claims: [] })).toBe("self-declared");
    expect(derive(null)).toBe("self-declared");
  });

  test("a self-asserted (unverified) tier-1 claim does NOT elevate → self-declared", () => {
    // An `lei:` the presenter merely asserts, with no verifiedBy, must not launder a tier.
    expect(derive({ claims: [selfAsserted("lei:5299")] })).toBe("self-declared");
  });

  test("institutional precedence is strict: verified lei + verified did → institutional", () => {
    expect(
      derive({ claims: [verified("did:demos:agent:x"), verified("lei:5299")] }),
    ).toBe("institutional");
  });

  test("a declared identityTier on the bundle is ignored — derivation keys only on claims", () => {
    const lying = { identityTier: "institutional", claims: [selfAsserted("key:dddd")] } as never;
    expect(derive(lying)).toBe("self-declared");
  });

  test("a custom predicate models staleness: a stale verifiedBy is not-verified", () => {
    const claims = [verified("lei:5299")];
    // Predicate says nothing is currently verified (e.g. all anchors resolved stale).
    expect(deriveIdentityTier({ claims }, () => false)).toBe("self-declared");
  });
});

// ── §14 golden conformance: drive the reference identity-tier fixtures ──
const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const read = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));

describe("§14 identityTier golden vectors", () => {
  if (!haveVectors) {
    it.skip("vectors not synced — run `npm run conformance:sync`", () => {});
    return;
  }
  const golden = read("vectors/golden.json").identityTier as {
    cases: Array<{ id: string; fixture?: string; expected: string }>;
  };

  for (const c of golden.cases) {
    if (!c.fixture) continue; // cases without a fixture are described by derivation alone
    it(`${c.id} → ${c.expected}`, () => {
      const fx = read(c.fixture!.replace(/^conformance\//, ""));
      expect(derive(fx.identityBundle)).toBe(fx.expectedIdentityTier);
      expect(fx.expectedIdentityTier).toBe(c.expected);
    });
  }
});
