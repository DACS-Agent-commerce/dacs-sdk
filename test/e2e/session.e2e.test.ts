import { describe, expect, test } from "vitest";

import { buildSignedArtifact, type Signer } from "../../src/agent/signedArtifact.js";
import { runSessionCore, type SessionDeps } from "../../src/agent/runSessionCore.js";
import { vetCore } from "../../src/agent/vetCore.js";
import { verifyBundleCore } from "../../src/agent/verifyBundleCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
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
  async function runFlow(sub = memSubstrate()) {
    // 1. Seller publishes a signed, anchored fixed-price listing.
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
      },
      ARTIFACT_SEPARATORS.Listing,
      signSeller,
    );
    const listingRef = await sub.anchor(
      `dacs1:listing:${sellerDid}:market-data`,
      listingSigned,
    );

    // 2. Buyer runs the session: the x402 rail is the injected settle executor.
    const deps: SessionDeps = {
      buyerId: buyerDid,
      readListing: sub.read,
      sign: (artifact, sep) =>
        buildSignedArtifact(artifact, sep as never, signBuyer),
      anchor: sub.anchor,
      anchorAddress: sub.anchorAddress,
      readAnchor: sub.read,
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
              { network: NETWORK, payTo: RECIPIENT_EVM, amount: req.amount },
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

  test("completes and the bundle independently verifies end to end", async () => {
    const { sub, listingRef, result } = await runFlow();

    expect(result.outcome).toBe("completed");
    expect(result.agreementRef).toBe("stor:dacs3:agreement:job-e2e");
    expect(result.settlementRef).toBe("stor:dacs4:evidence:job-e2e");

    // A third party verifies the anchored bundle from scratch.
    const v = await verifyBundleCore(result.bundleRef, {
      readArtifact: sub.read,
      resolvePublicKey: async (did) => resolveFromDid(did),
      verify,
    });

    expect(v.ok).toBe(true);
    expect(v.fullyVerified).toBe(true);
    expect(v.bundleSignature).toBe("valid");
    // Full 5-stage bundle: listing, vet record, agreement, settlement.
    expect(result.vetRef).toBeDefined();
    expect(v.bundle?.artifactRefs).toEqual([
      listingRef,
      result.vetRef,
      result.agreementRef,
      result.settlementRef,
    ]);
    expect(v.artifacts.map((a) => a.signature)).toEqual([
      "valid",
      "valid",
      "valid",
      "valid",
    ]);
    expect(v.artifacts.map((a) => a.kind)).toEqual([
      "Listing",
      "CompositeVerificationRecord",
      "AgreementDocument",
      "SettlementEvidence",
    ]);

    // Settlement evidence carries the rail's reported tx hash.
    const evidence = sub.store.get(result.settlementRef);
    // DACS-4 spec shape: outcome + payment txRefs (was the flat txHash/ok).
    expect(evidence).toMatchObject({
      evidenceVersion: "1",
      outcome: "success",
      paymentTxRefs: [{ txHash: "0xsettlement", kind: "payment" }],
    });
  });

  test("tampering an anchored artifact breaks verification", async () => {
    const { sub, result } = await runFlow();
    const agreement = { ...sub.store.get(result.agreementRef)! };
    agreement.price = { amount: "1", asset: "USDC", decimals: 6, rail: "pay-x402" };
    sub.store.set(result.agreementRef, agreement);

    const v = await verifyBundleCore(result.bundleRef, {
      readArtifact: sub.read,
      resolvePublicKey: async (did) => resolveFromDid(did),
      verify,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/signature/);
  });
});
