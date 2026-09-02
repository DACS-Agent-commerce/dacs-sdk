import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { IdentityBundle } from "../../src/artifacts/types.js";
import {
  identityBundleHash,
  siwdBundleResource,
  siwdResourcesBindBundleHash,
} from "../../src/identity/index.js";

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

describe("SIWD bundle-resource binding — DACS-1 §6.3.2", () => {
  const hash = "6d7c726a881c38fe307d01439051f5e197702da21d072265a6f4e7d1e1a9f128";
  const resource =
    "dacs:646163732d62756e646c652d70726573656e746174696f6e3a76313a36643763373236613838316333386665333037643031343339303531663565313937373032646132316430373232363561366634653764316531613966313238";

  it("encodes the complete domain-separated bytes as exact lowercase hex", () => {
    expect(siwdBundleResource(hash)).toBe(resource);
    expect(Buffer.from(resource.slice("dacs:".length), "hex").toString("utf8")).toBe(
      `dacs-bundle-presentation:v1:${hash}`,
    );
  });

  it("accepts exact membership in an authenticated parsed Resources list", () => {
    expect(siwdResourcesBindBundleHash([
      "https://service.example/order/1",
      resource,
    ], hash)).toBe(true);
  });

  it.each([
    ["missing resource", ["https://service.example/order/1"]],
    ["bare hex", [resource.slice("dacs:".length)]],
    ["uppercase hex", [resource.toUpperCase()]],
    ["alternate URI", [`dacs://${resource.slice("dacs:".length)}`]],
    ["non-string member", [resource, 1]],
    ["sparse list", Object.assign(new Array(2), { 1: resource })],
  ])("rejects %s", (_label, resources) => {
    expect(siwdResourcesBindBundleHash(resources, hash)).toBe(false);
  });

  it("rejects malformed hashes and accessor-backed or hostile inputs", () => {
    expect(() => siwdBundleResource(hash.toUpperCase())).toThrow(/lowercase SHA-256/);
    expect(siwdResourcesBindBundleHash([resource], hash.toUpperCase())).toBe(false);

    let accessed = false;
    const accessor = [resource];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        accessed = true;
        return resource;
      },
    });
    expect(siwdResourcesBindBundleHash(accessor, hash)).toBe(false);
    expect(accessed).toBe(false);

    const target = [resource];
    const revoked = Proxy.revocable(target, {});
    revoked.revoke();
    expect(siwdResourcesBindBundleHash(revoked.proxy, hash)).toBe(false);
  });
});
