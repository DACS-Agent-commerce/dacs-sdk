import { describe, expect, test } from "vitest";

import { buildSignedArtifact, verifySignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import {
  runSessionCore,
  sessionAnchorName,
  type SessionDeps,
} from "../../src/agent/runSessionCore.js";
import { vetCore } from "../../src/agent/vetCore.js";
import {
  verifyBundleCore,
  type VerifyBundleDeps,
} from "../../src/agent/verifyBundleCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { verifyComponentSignature } from "../../src/artifacts/signatures.js";
import { listingAddress } from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  x402SettleCore,
  type X402ClientLike,
  type X402PaymentRequired,
} from "../../src/rails/x402.js";

// ── Identities (CCI == ed25519 pubkey hex embedded in the DID) ──
const SELLER_SEED = Uint8Array.from(Buffer.alloc(32, 11));
const BUYER_SEED = Uint8Array.from(Buffer.alloc(32, 13));
const NETWORK = "eip155:84532";
const RECIPIENT_EVM = "0x1111111111111111111111111111111111111111";
const BUYER_EVM = "0x2222222222222222222222222222222222222222";

function signerFor(seed: Uint8Array): Signer {
  const priv = privateKeyFromSeed(seed);
  return (bytes) => ed25519Sign(bytes, priv);
}
function didFor(seed: Uint8Array): string {
  return `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
}
const sellerDid = didFor(SELLER_SEED);
const buyerDid = didFor(BUYER_SEED);
const signSeller = signerFor(SELLER_SEED);
const signBuyer = signerFor(BUYER_SEED);

const verify = (b: Uint8Array, s: Uint8Array, p: Uint8Array) =>
  ed25519Verify(b, s, publicKeyFromRaw(p));
function resolveFromDid(did: string): Uint8Array | null {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

// ── In-memory substrate (anchor/read against a Map) ──
function memSubstrate() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    anchor: async (name: string, value: object) => {
      const address = `stor:${name}`;
      store.set(address, value as Record<string, unknown>);
      return address;
    },
    anchorAddress: async (name: string) => `stor:${name}`,
    read: async (ref: string) => store.get(ref) ?? null,
    resolveAnchor: async (name: string) => {
      const ref = `stor:${name}`;
      const value = store.get(ref);
      return value
        ? { status: "present" as const, ref, value }
        : { status: "absent" as const };
    },
  };
}

// ── Bundle-verification deps: resolve referenced artifacts via the substrate ──
function verifyDeps(sub: ReturnType<typeof memSubstrate>): VerifyBundleDeps {
  return {
    readArtifact: sub.read,
    resolveRef: async (kind, jobId) => {
      const name =
        kind === "dacs-3-agreement"
          ? sessionAnchorName.agreement(jobId)
          : kind === "dacs-4-evidence"
            ? sessionAnchorName.evidence(jobId)
            : kind === "dacs-2-verifyresult"
              ? sessionAnchorName.vet(jobId)
              : null;
      if (!name) return null;
      return sub.read(await sub.anchorAddress(name));
    },
    resolvePublicKey: async (did) => resolveFromDid(did),
    verify,
  };
}

// ── Fake x402 seller: advertises exactly the agreed base-unit amount ──
function fakeClient(accepts: X402PaymentRequired["accepts"]): X402ClientLike {
  return {
    getPaymentRequiredResponse: () => ({ accepts }),
    createPaymentPayload: async (pr) => pr,
    encodePaymentSignatureHeader: () => ({ "X-PAYMENT": "signed" }),
    getPaymentSettleResponse: () => ({ transaction: "0xsettlement" }),
  };
}
function fakeFetch(): typeof fetch {
  let n = 0;
  return (async () => {
    n += 1;
    return n === 1
      ? new Response("{}", { status: 402 })
      : new Response(JSON.stringify({ data: "deliverable" }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("end-to-end session (publish → negotiate → x402 settle → verify)", () => {
  async function runFlow(sub = memSubstrate(), listingVersion?: number) {
    // 1. Seller publishes a signed, anchored fixed-price listing. When a
    // listingVersion is given, anchor at the versioned §6.3.4 address (#29).
    const listingSigned = await buildSignedArtifact(
      {
        agentId: sellerDid,
        serviceId: "market-data",
        name: "Market Data",
        description: "EOD prices",
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
        ...(listingVersion !== undefined ? { listingVersion } : {}),
      },
      ARTIFACT_SEPARATORS.Listing,
      signSeller,
    );
    const listingRef = await sub.anchor(
      listingVersion !== undefined
        ? listingAddress(sellerDid, "market-data", listingVersion)
        : `dacs1:listing:${sellerDid}:market-data`,
      listingSigned,
    );

    // 2. Buyer runs the session: the x402 rail is the injected settle executor.
    const deps: SessionDeps = {
      buyerId: buyerDid,
      expectedSettlementPayee: RECIPIENT_EVM,
      readListing: sub.read,
      sign: (artifact, sep) =>
        buildSignedArtifact(artifact, sep as never, signBuyer),
      signBytes: async (bytes) => signBuyer(bytes),
      anchor: sub.anchor,
      resolveAnchor: sub.resolveAnchor,
      settle: (req) =>
        x402SettleCore(
          {
            paywallUrl: "https://seller.example/deliver",
            network: NETWORK,
            recipientEvm: RECIPIENT_EVM,
            amount: req.amount,
            asset: req.asset,
          },
          {
            client: fakeClient([
              { network: NETWORK, payTo: RECIPIENT_EVM, amount: req.amount, asset: req.asset },
            ]),
            fetchImpl: fakeFetch(),
            payerAddress: BUYER_EVM,
          },
        ),
      // Vet the seller (self-signed recipe) before paying — full 5-stage flow.
      vet: (subject) =>
        vetCore(
          { subject, recipe: { id: "self-signed", method: "self-signed", availability: "live", params: {} } },
          { proxyFetch: async () => ({ status: 200, responseHash: "0x" }), now: () => "2026-01-01T00:00:00Z" },
        ),
      newJobId: () => "job-e2e",
      now: () => "2026-01-01T00:00:00Z",
      nowMs: () => 1780000000000,
      // #41 — REAL listing verification end to end: recompute the signature over
      // the stored artifact and check it against the key in the advertised seller
      // claim. Proves the happy path runs on a genuinely signed listing.
      verifyListing: (raw, sellerClaim) => {
        const key = resolveFromDid(sellerClaim);
        return key
          ? verifySignedArtifact(raw, ARTIFACT_SEPARATORS.Listing, key, verify)
          : false;
      },
    };
    const result = await runSessionCore(
      listingRef,
      {
        price: { amount: "1000000", asset: "USDC", decimals: 6, rail: "pay-x402" },
        deliveryPhase: "deliver-attested-payload",
        deliveryFormat: "application/json",
      },
      deps,
    );
    return { sub, listingRef, result };
  }

  test("completes and strict verification fail-closes the legacy one-sided bundle", async () => {
    const { sub, listingRef, result } = await runFlow();

    expect(result.outcome).toBe("completed");
    expect(result.agreementRef).toBe("stor:dacs3:agreement:job-e2e");
    expect(result.settlementRef).toBe("stor:dacs4:evidence:job-e2e");

    // The verifier below did not participate in production. Artifacts whose
    // normative schema uses ComponentSignature must authenticate independently.
    // AgreementSignature[] migration is owned by #98.
    const lifecycleArtifacts = [
      [result.vetRef!, ARTIFACT_SEPARATORS.CompositeVerificationRecord],
      [result.settlementRef, ARTIFACT_SEPARATORS.SettlementEvidence],
    ] as const;
    for (const [ref, separator] of lifecycleArtifacts) {
      const artifact = sub.store.get(ref)!;
      await expect(
        verifyComponentSignature(artifact, separator, {
          isSignerAuthorized: (_record, signature) =>
            signature.signer === buyerDid,
          resolvePublicKey: (signature) => resolveFromDid(signature.signer),
          verify: ({ signedBytes, signature, publicKey }) =>
            verify(
              signedBytes,
              Uint8Array.from(Buffer.from(signature.value, "base64url")),
              publicKey,
            ),
        }),
      ).resolves.toMatchObject({ status: "valid" });
    }

    // runSessionCore still emits the legacy MVP buyer-only bundle. A strict
    // third-party verifier must reject it until the two-sided producer helper
    // is wired into this orchestration path.
    const v = await verifyBundleCore(result.bundleRef, verifyDeps(sub));

    expect(v.ok).toBe(false);
    expect(v.fullyVerified).toBe(false);
    expect(v.reason).toMatch(/missing required signature/);
    expect(v.reason).toContain(sellerDid);
    // The bundle's buyer signature verifies over the §10.4.1 signed scope.
    expect(v.signatures).toEqual([{ party: buyerDid, verdict: "valid" }]);
    // Full 5-stage spec bundle: content-addressed listing/agreement refs +
    // vet record + settlement evidence.
    expect(result.vetRef).toBeDefined();
    expect(v.bundle?.outcome).toBe("completed");
    expect(v.bundle?.vetRecords).toHaveLength(1);
    expect(v.bundle?.settlementEvidence).toHaveLength(1);
    expect(v.bundle?.listingRef.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.bundle?.agreementRef?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Settlement evidence carries the rail's reported tx hash.
    const evidence = sub.store.get(result.settlementRef);
    // DACS-4 spec shape: outcome + payment txRefs (was the flat txHash/ok).
    expect(evidence).toMatchObject({
      evidenceVersion: "1",
      outcome: "success",
      paymentTxRefs: [{ txHash: "0xsettlement", kind: "payment" }],
    });
  });

  test("versioned listing (#29): the bundle pins the version it was struck against, and a later version doesn't break it", async () => {
    const sub = memSubstrate();
    // Deal struck against listing v2, anchored at the versioned §6.3.4 address.
    const { result } = await runFlow(sub, 2);
    const v = await verifyBundleCore(result.bundleRef, verifyDeps(sub));
    // Strict two-sided verification fail-closes the legacy buyer-only bundle
    // (see the first test) — assert that the missing seller signature is the
    // ONLY failure: every referenced artifact, including the v2 listing at its
    // versioned §6.3.4 address, must still dereference and hash-match. That
    // ref integrity is what #29's version pinning is about.
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/missing required signature/);
    expect(v.refs.every((r) => r.verdict === "ok")).toBe(true);
    // The bundle records the exact version it pinned, not a hardcoded 1.
    expect(v.bundle?.listingRef.version).toBe(2);
    const pinnedHash = v.bundle?.listingRef.contentHash;

    // The seller publishes v3 (a new address); v2's anchor is untouched, so the
    // historical bundle still verifies against the version it pinned.
    const v3Signed = await buildSignedArtifact(
      {
        agentId: sellerDid,
        serviceId: "market-data",
        name: "Market Data",
        description: "EOD prices + intraday", // edited content
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
        listingVersion: 3,
      },
      ARTIFACT_SEPARATORS.Listing,
      signSeller,
    );
    await sub.anchor(listingAddress(sellerDid, "market-data", 3), v3Signed);

    const after = await verifyBundleCore(result.bundleRef, verifyDeps(sub));
    // Still only the one-sided gap — v3's publication changed nothing: the
    // pinned v2 ref still resolves and hash-matches at its own address.
    expect(after.reason).toMatch(/missing required signature/);
    expect(after.refs.every((r) => r.verdict === "ok")).toBe(true);
    expect(after.bundle?.listingRef.contentHash).toBe(pinnedHash);
  });

  test("tampering the anchored bundle breaks signature verification", async () => {
    const { sub, result } = await runFlow();
    // Mutate a supported signed-scope field of the bundle after it was signed.
    const bundle = { ...sub.store.get(result.bundleRef)! };
    bundle.finalisedAt = 1780000000001;
    sub.store.set(result.bundleRef, bundle);

    const v = await verifyBundleCore(result.bundleRef, verifyDeps(sub));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/signature/);
  });
});
