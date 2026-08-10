import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { IdentityBundle } from "../../src/artifacts/types.js";
import { identityBundleHash } from "../../src/identity/index.js";

const bundle = (): IdentityBundle => ({
  bundleVersion: "1",
  presentedBy: "did:example:alice",
  presentedAt: 1_780_358_400_000,
  sessionNonce: "session-0123456789abcdef",
  claims: [
    { ref: "did:example:alice", metadata: { displayName: "Alice" } },
    { ref: "domain:alice.example" },
  ],
  presentation: {
    kind: "per-claim",
    signatures: [{ ref: "did:example:alice", signature: "c2lnLTE" }],
  },
});

describe("identityBundleHash — DACS-1 §6.3.2", () => {
  it("matches the Standard preserve-unknown fixture", () => {
    const vectors = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/listing-preserve-unknown-v0.1.json",
      import.meta.url,
    ), "utf8")) as {
      fixtures: {
        identityBundleHash: string;
        "listing-with-inert-extension": {
          listing: { seller: { identity: IdentityBundle } };
        };
      };
    };

    expect(identityBundleHash(
      vectors.fixtures["listing-with-inert-extension"].listing.seller.identity,
    )).toBe(vectors.fixtures.identityBundleHash);
  });

  it("omits only presentation from the canonical bundle hash", () => {
    const original = bundle();
    const differentPresentation = structuredClone(original);
    differentPresentation.presentation = {
      kind: "session-key",
      key: "did:key:z6MkDifferentSessionKey",
      signature: "c2lnLTI",
    };

    expect(identityBundleHash(differentPresentation)).toBe(
      identityBundleHash(original),
    );
  });

  it("changes when a hashed claim or session nonce changes", () => {
    const original = bundle();
    const changedClaim = structuredClone(original);
    changedClaim.claims[1]!.ref = "domain:mallory.example";
    const changedNonce = structuredClone(original);
    changedNonce.sessionNonce = "different-session-nonce";

    expect(identityBundleHash(changedClaim)).not.toBe(identityBundleHash(original));
    expect(identityBundleHash(changedNonce)).not.toBe(identityBundleHash(original));
  });

  it("keeps unknown minor-version fields inside the hash", () => {
    const original = bundle();
    const extended = structuredClone(original) as IdentityBundle & {
      futureBinding?: { mode: string };
    };
    extended.futureBinding = { mode: "strict" };

    expect(identityBundleHash(extended)).not.toBe(identityBundleHash(original));
  });
});
