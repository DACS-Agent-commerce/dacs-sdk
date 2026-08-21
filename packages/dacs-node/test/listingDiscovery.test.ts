import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_SEPARATORS,
  signComponentArtifact,
  type Listing,
} from "@kynesyslabs/dacs/artifacts";
import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import { rawPublicKey, signedBytes } from "@kynesyslabs/dacs/crypto";
import { demosAgentClaimRef, identityBundleHash } from "@kynesyslabs/dacs/identity";

import { openDacsListingDiscoveryStoreV1 } from "../src/listingDiscovery.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function listingFixture(version = 1): Promise<Readonly<{
  listing: Listing;
  authority: string;
  ref: string;
  hash: string;
  logicalAddress: string;
}>> {
  const keys = generateKeyPairSync("ed25519");
  const authority = demosAgentClaimRef(rawPublicKey(keys.publicKey));
  const bundle = {
    bundleVersion: "1" as const,
    presentedBy: authority,
    presentedAt: 1_000,
    claims: [{ ref: authority }],
    presentation: {
      kind: "per-claim" as const,
      signatures: [{ ref: authority, signature: "pending" }],
    },
  };
  bundle.presentation.signatures[0]!.signature = sign(
    null,
    signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
    keys.privateKey,
  ).toString("base64url");
  const listing = await signComponentArtifact({
    dacsVersion: "1",
    listingVersion: version,
    listingId: "generated-live-service",
    seller: {
      identity: bundle,
      displayName: "Generated seller",
      publicEndpoint: "https://seller.example/buy",
    },
    offering: {
      title: "Generated result",
      description: "A bounded application result",
      category: "software.service",
      tags: ["dacs"],
      deliverable: { kind: "storage-program", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:base-sepolia" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "0.5", currency: "USDC" } },
    acceptedRails: [{
      railId: "x402:base-sepolia",
      railVersion: 1,
      parameters: {
        network: "eip155:84532",
        payTo: `0x${"2".repeat(40)}`,
        asset: `0x${"3".repeat(40)}`,
        httpResource: "https://seller.example/buy",
      },
    }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 900, notAfter: 2_000 },
  }, ARTIFACT_SEPARATORS.Listing, {
    algorithm: "ed25519",
    signer: authority,
    sign: (bytes) => sign(null, bytes, keys.privateKey),
  });
  const hash = contentHash(listing as unknown as Record<string, unknown>);
  return Object.freeze({
    listing,
    authority,
    ref: `stor-${String(version).padStart(40, "0")}`,
    hash,
    logicalAddress: listingAddress(authority, listing.listingId, version),
  });
}

describe("DacsListingDiscoveryStoreV1", () => {
  it("atomically publishes an integrity-bound index and exact replay", async () => {
    const fixture = await listingFixture();
    const root = await mkdtemp(join(tmpdir(), "dacs-listing-discovery-"));
    roots.push(root);
    let now = 1_000;
    const store = await openDacsListingDiscoveryStoreV1({
      directory: root,
      sellerAuthority: fixture.authority,
      sellerPublicEndpoint: "https://seller.example/buy",
      now: () => now,
    });
    now = 1_001;
    const input = {
      listing: fixture.listing,
      listingRef: fixture.ref,
      logicalAddress: fixture.logicalAddress,
      listingContentHash: fixture.hash,
    };
    const first = await store.publishActive(input);
    expect(first).toMatchObject({ status: "published" });
    const index = await store.readIndex();
    const card = await store.readAgentCard();
    expect(index).toMatchObject({
      indexVersion: "1",
      generatedAt: 1_001,
      seller: fixture.authority,
      listings: [{
        listingId: fixture.listing.listingId,
        version: 1,
        contentHash: fixture.hash,
        anchor: { kind: "storage-program", locator: fixture.ref },
        status: "active",
      }],
    });
    expect(card).toEqual({
      dacs: {
        dacsVersion: "1",
        listings: {
          indexUrl: "https://seller.example/.well-known/dacs/listings.json",
          indexHash: `sha256-${sha256Hex(canonicalize(index))}`,
        },
      },
    });
    now = 1_002;
    await expect(store.publishActive(input)).resolves.toEqual({
      status: "existing",
      indexHash: `sha256-${sha256Hex(canonicalize(index))}`,
    });
    expect(await store.readIndex()).toEqual(index);
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(root, "listings.json"))).mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(root, "listings.json"), "utf8")).toBe(canonicalize(index));
  });

  it("fails closed on a conflicting native binding for the same version", async () => {
    const fixture = await listingFixture();
    const root = await mkdtemp(join(tmpdir(), "dacs-listing-conflict-"));
    roots.push(root);
    const store = await openDacsListingDiscoveryStoreV1({
      directory: root,
      sellerAuthority: fixture.authority,
      sellerPublicEndpoint: "https://seller.example/buy",
      now: () => 1_000,
    });
    const input = {
      listing: fixture.listing,
      listingRef: fixture.ref,
      logicalAddress: fixture.logicalAddress,
      listingContentHash: fixture.hash,
    };
    await store.publishActive(input);
    await expect(store.publishActive({
      ...input,
      listingRef: `stor-${"9".repeat(40)}`,
    })).resolves.toEqual({
      status: "conflict",
      reasonCode: "listing-discovery-slot-conflict",
    });
    expect((await store.readIndex()).listings[0]!.anchor.locator).toBe(fixture.ref);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a pre-existing discovery directory with unsafe permissions",
    async () => {
      const fixture = await listingFixture();
      const root = await mkdtemp(join(tmpdir(), "dacs-listing-unsafe-"));
      roots.push(root);
      await chmod(root, 0o755);
      await expect(openDacsListingDiscoveryStoreV1({
        directory: root,
        sellerAuthority: fixture.authority,
        sellerPublicEndpoint: "https://seller.example/buy",
      })).rejects.toMatchObject({ reasonCode: "listing-discovery-directory-unsafe" });
    },
  );
});
