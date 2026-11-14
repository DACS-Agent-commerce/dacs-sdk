/**
 * DACS SDK — hello-world
 *
 * The start of the fixed-price lifecycle through the public API only:
 *   seller publishes a listing  →  buyer resolves/authenticates its logical address.
 * The purchase (negotiate → settle on x402 → deliver → bundle) runs in the
 * fixed-price coordinators; see docs/fixed-price-x402-coordinator.md.
 *
 * Run against a Demos node with one funded seller. The buyer only reads the
 * listing, so it needs no wallet. Env:
 *   DEMOS_RPC          Demos node RPC URL (e.g. https://node2.demos.sh)
 *   SELLER_WALLET      seller agent mnemonic / private key
 *   SELLER_DID         canonical did:demos:agent:<lowercase-ed25519-pubkey-hex>
 *   SELLER_IDENTITY_BUNDLE_JSON  verified DACS-1 §6.3.2 IdentityBundle JSON
 *   PAYWALL_URL        seller's public endpoint, published in the listing
 *   DACS_STATE_DIR     durable private state directory for the seller's wallet journal
 *
 *   npx tsx examples/hello-world.ts
 */

import { join } from "node:path";

import {
  createAgent,
  createFsDemosWriteJournal,
  createInMemoryBindingStore,
  type IdentityBundle,
} from "../src/index.js";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

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
    identity: { agentId: env("SELLER_DID") },
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

  // ── Buyer: admit the listing from its logical address ──
  // Reading a listing needs only the index: no wallet, write journal or
  // publication authority. The in-memory index works here because both agents
  // share this process; production consumers use the deployment's catalog/index.
  const buyer = await createAgent({
    demosRpc: env("DEMOS_RPC"),
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

  // The purchase runs in the buyer and seller coordinators, each over its own
  // durable store. See docs/fixed-price-x402-coordinator.md. `npm run test:live`
  // runs the funded two-agent flow end to end; docs/live-e2e.md lists what it
  // needs. Anyone can then check the finalized bundle with
  // `buyer.verifyBundle(bundleRef)`.
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
