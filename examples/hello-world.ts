/**
 * DACS SDK — hello-world (T5)
 *
 * The whole fixed-price + x402 lifecycle through the public API only:
 *   seller publishes a listing  →  buyer resolves/authenticates its logical address
 *   → buyer runs a session
 *   (negotiate → settle on x402 → verify)  →  anyone verifies the bundle.
 *
 * Run against a Demos node with two funded agents. Env:
 *   DEMOS_RPC          Demos node RPC URL (e.g. https://node2.demos.sh)
 *   SELLER_WALLET      seller agent mnemonic / private key
 *   BUYER_WALLET       buyer agent mnemonic / private key
 *   SELLER_DID         canonical did:demos:agent:<lowercase-ed25519-pubkey-hex>
 *   SELLER_IDENTITY_BUNDLE_JSON  verified DACS-1 §6.3.2 IdentityBundle JSON
 *   BUYER_DID          buyer agent id
 *   BUYER_IDENTITY_BUNDLE_JSON   buyer's signed DACS-1 IdentityBundle JSON
 *   BUYER_EVM_KEY      buyer EVM private key (0x…) used to sign the x402 payment
 *   BUYER_EVM_RPC      trusted independent RPC for settlement finality
 *   PAYWALL_URL        seller's paywalled delivery URL (returns HTTP 402)
 *   PAY_NETWORK        CAIP-2 network, e.g. eip155:84532 (Base Sepolia)
 *   PAY_TOKEN          ERC-20 contract address advertised by the x402 paywall
 *   SELLER_EVM         seller EVM address that x402 pays
 *   DACS_STATE_DIR     durable private state directory for wallet journals
 *
 *   npx tsx examples/hello-world.ts
 */

import { join } from "node:path";

import {
  createAgent,
  createFsDemosWriteJournal,
  createInMemoryBindingStore,
  createX402Rail,
  ed25519Verify,
  publicKeyFromRaw,
  vetCore,
  x402Settle,
  type IdentityBundle,
} from "../src/index.js";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

function verifyDemosIdentityPresentation(input: {
  bundle: Readonly<IdentityBundle>;
  signedBytes: Uint8Array;
}): boolean {
  const { bundle, signedBytes } = input;
  if (
    bundle.presentation.kind !== "per-claim" ||
    bundle.presentation.signatures.length !== bundle.claims.length ||
    !bundle.claims.some(({ ref }) => ref === bundle.presentedBy)
  ) {
    return false;
  }
  const proofs = new Map<string, string>();
  for (const proof of bundle.presentation.signatures) {
    if (proofs.has(proof.ref)) return false;
    proofs.set(proof.ref, proof.signature);
  }
  return bundle.claims.every(({ ref }) => {
    const publicKeyHex = ref.match(/^did:demos:agent:([0-9a-f]{64})$/)?.[1];
    const encoded = proofs.get(ref);
    if (!publicKeyHex || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      return false;
    }
    const signature = Uint8Array.from(Buffer.from(encoded, "base64url"));
    return signature.length === 64 &&
      Buffer.from(signature).toString("base64url") === encoded &&
      ed25519Verify(
        signedBytes,
        signature,
        publicKeyFromRaw(Uint8Array.from(Buffer.from(publicKeyHex, "hex"))),
      );
  });
}

async function main(): Promise<void> {
  // ── Seller: publish a signed, anchored fixed-price listing ──
  // Replace this same-process reference store with a well-known/catalog-backed
  // index + publisher in production.
  const bindings = createInMemoryBindingStore();
  const sellerWriteJournal = await createFsDemosWriteJournal({
    dir: join(env("DACS_STATE_DIR"), "seller-demos-writes"),
  });
  const sellerIdentity = JSON.parse(
    env("SELLER_IDENTITY_BUNDLE_JSON"),
  ) as IdentityBundle;
  const seller = await createAgent({
    demosRpc: env("DEMOS_RPC"),
    wallet: env("SELLER_WALLET"),
    demosWriteJournal: sellerWriteJournal,
    identity: { agentId: env("SELLER_DID"), bundle: sellerIdentity },
    bindings: { index: bindings, publisher: bindings },
  });

  const published = await seller.publishListing({
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "market-data",
    seller: {
      identity: sellerIdentity,
      displayName: "Market Data",
      publicEndpoint: env("PAYWALL_URL"),
    },
    offering: {
      title: "Market Data",
      description: "End-of-day prices, JSON.",
      category: "data.finance.market",
      tags: ["market-data"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: {
      kind: "fixed",
      price: { amount: "1", currency: "USDC" },
    },
    acceptedRails: [{ railId: "x402:default" }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: Date.now() },
  });
  if (
    published.status !== "published" &&
    published.status !== "already-published"
  ) {
    throw new Error(
      `listing binding was not published: ${published.status}`,
    );
  }
  console.log(
    "listing",
    published.logicalAddress,
    "anchored at",
    published.ref,
    published.listingPin,
  );

  // ── Buyer: run the session, settling via the x402 rail ──
  const buyerIdentity = JSON.parse(
    env("BUYER_IDENTITY_BUNDLE_JSON"),
  ) as IdentityBundle;
  const buyer = await createAgent({
    demosRpc: env("DEMOS_RPC"),
    wallet: env("BUYER_WALLET"),
    demosWriteJournal: await createFsDemosWriteJournal({
      dir: join(env("DACS_STATE_DIR"), "buyer-demos-writes"),
    }),
    identity: {
      agentId: env("BUYER_DID"),
      bundle: buyerIdentity,
      verifyPresentation: verifyDemosIdentityPresentation,
    },
    // Consumer access needs only the index, not the seller's publication
    // authority. The in-memory index works here because both agents share this
    // process; production consumers use the deployment's catalog/index.
    bindings: { index: bindings },
  });

  const resolved = await buyer.readListing(published.logicalAddress);
  if (
    resolved.status !== "verified" ||
    resolved.compatibility !== "normative"
  ) {
    throw new Error(`listing could not pass ordered admission: ${resolved.status}`);
  }
  console.log("listing admitted from its logical address", resolved.listingPin);

  const rail = await createX402Rail({
    evmPrivateKey: env("BUYER_EVM_KEY"),
    rpcUrl: env("BUYER_EVM_RPC"),
    finalityBlocks: 1,
  });
  const sellerEvm = env("SELLER_EVM");

  // Pass the authenticated selection so a changed record at the same native
  // address cannot alter what this session acts on before payment.
  const session = await buyer.runSession(resolved, {
    terms: {
      // amount is integer base units (USDC has 6 decimals → 1000000 = 1.0 USDC)
      price: {
        amount: "1000000",
        asset: "USDC",
        decimals: 6,
        rail: "x402:default",
      },
      deliveryPhase: "deliver-attested-payload",
      deliveryFormat: "application/json",
    },
    expectedSettlementPayee: sellerEvm,
    // A production Vet configuration supplies `vet` (which emits signed,
    // anchored DACS-2 §7.5/§7.7 records), `verifyVetRecord` (which verifies
    // their complete caller-held reference closure), and
    // `authenticateVetFinality` (which authenticates the exact finalized
    // record/ref/receipt binding). This minimal funded x402 example omits Vet
    // rather than demonstrating a shape-only trust shortcut.
    settle: x402Settle(rail, {
      url: env("PAYWALL_URL"),
      network: env("PAY_NETWORK"),
      recipientEvm: sellerEvm,
      asset: env("PAY_ASSET"),
    }),
  });
  console.log("session", session.outcome, "→ bundle", session.bundleRef);

  // ── Anyone: independently verify the attestation bundle ──
  const verdict = await buyer.verifyBundle(session.bundleRef);
  console.log("bundle ok:", verdict.ok, "| fully verified:", verdict.fullyVerified);
  for (const signature of verdict.signatures) {
    console.log(`  signer ${signature.party}: ${signature.verdict}`);
  }
  for (const ref of verdict.refs) {
    console.log(`  ${ref.kind} ${ref.id}: ${ref.verdict}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
