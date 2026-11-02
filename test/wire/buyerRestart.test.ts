import * as wireValidate from "../../src/wire/validate.js";
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as wire from "../../src/wire/index.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/ed25519.js";
import { committedPurchase, BUYER_SEED, SELLER_SEED, COMMITTED_AT, bytes } from "./committedPurchaseFixture.js";
import { journalDirectory, journalFixture } from "./requestJournalFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";

it("a fresh buyer process rechecks retained bytes and reuses the seller's completed operation", async () => {
  const p = await committedPurchase((listing) => { listing.seller.publicEndpoint = "https://seller.restart.invalid"; });
  const binding = p.scope.binding, local = binding.local, now = COMMITTED_AT + 120_000;
  const publicEndpoint = "https://seller.restart.invalid";
  const listing = { seller: p.scope.seller, publicEndpoint, listingPin: p.scope.listingPin };
  const request = { ...p.scope.request, path: "/dacs/v1/payments" };
  const seller = { claim: p.scope.seller, sign: (input: Uint8Array) => ed25519Sign(input, privateKeyFromSeed(SELLER_SEED)) };
  const discovery = await wire.signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: binding.profile, seller: seller.claim,
    publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [listing.listingPin], capabilities: wire.TP1_CAPABILITIES,
    ready: false, issuedAt: now, expiresAt: now + 60_000 }, seller, binding, local);
  const evidence = { commitment: bytes(p.anchored), agreement: bytes(p.agreement), signedListing: bytes(p.listing) };
  const reader = Object.assign(() => "valid", { chainIdentity: binding.profile.chainIdentity });
  const readListingEligibility: wire.ListingEligibilityReader = (scope) => ({ ...readFixtureListingEligibility(scope),
    notBefore: p.listing.validity.notBefore, expiresAt: p.listing.validity.notAfter ?? Number.MAX_SAFE_INTEGER });
  const endpointProof = await wire.verifyEndpointProof(discovery, { binding, local, now, listing, request,
    ...evidence, readCommitmentReceipt: reader, readListingEligibility });
  const buyer = { claim: request.buyer, sign: (input: Uint8Array) => ed25519Sign(input, privateKeyFromSeed(BUYER_SEED)) };
  const first = await wire.signWireRequest({ signer: buyer, binding, local, now, publicEndpoint, endpointProof, ...request,
    text: "{}", seller: seller.claim, job: { listingPin: listing.listingPin, agreementHash: request.agreementHash, profile: binding.profile },
    nonce: Buffer.alloc(16, 1).toString("base64url"), ...evidence });
  const journal = journalFixture(wire).testJournal({ clock: () => now });
  let serverReads = 0;
  const check: wire.RequestCheck = { binding, local, purchaseProfile: binding.profile, seller: seller.claim, listingPin: listing.listingPin,
    method: "POST", path: request.path, rawBody: Buffer.from("{}"), now, retained: { ...p.scope.request, seller: seller.claim },
    requestJournal: journal, ...evidence,
    readCommitmentReceipt: Object.assign(() => { serverReads++; return "valid"; }, { chainIdentity: binding.profile.chainIdentity }) };
  const open = (header: string) => wire.openWireEnvelope(header, "request", { binding, local, purchaseProfile: binding.profile });
  const issued = await wire.checkWireRequest(await open(first.header), check);
  if (!issued.effect || issued.effect.state !== "new") throw new Error("expected first effect");
  wire.completeWireEffect(journal, issued.effect, { status: 200, text: '{"retained":true}' });

  const directory = journalDirectory(), inputPath = join(directory, "input.json"), outputPath = join(directory, "output.json");
  const retained = { local, now, listing, request, discovery: Buffer.from(discovery).toString(), commitment: evidence.commitment.toString(),
    agreement: evidence.agreement.toString(), signedListing: evidence.signedListing.toString(), nonce: Buffer.alloc(16, 2).toString("base64url") };
  const run = () => spawnSync(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "test/fixtures/wire-buyer-restart-child.test.ts", "--maxWorkers=1"], {
    cwd: process.cwd(), env: { ...process.env, DACS_BUYER_RESTART_INPUT: inputPath, DACS_BUYER_RESTART_OUTPUT: outputPath },
    encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024,
  });
  // Independent CA-7 validation in the new process refuses tampered retained bytes.
  writeFileSync(inputPath, JSON.stringify({ ...retained, agreement: "{}" }));
  const refused = run();
  expect(refused.status, refused.stdout + refused.stderr).not.toBe(0);
  expect(refused.stdout + refused.stderr).toContain("continuation_agreement_invalid");
  expect(existsSync(outputPath)).toBe(false);
  writeFileSync(inputPath, JSON.stringify(retained));
  const child = run();
  expect(child.status, child.stdout + child.stderr).toBe(0);
  const answer: unknown = JSON.parse(readFileSync(outputPath, "utf8"));
  if (!wireValidate.hasKeys(answer, ["pid", "header", "calls"]) || !wireValidate.isUint(answer.pid) || typeof answer.header !== "string" || answer.calls !== 1) {
    throw new Error("invalid isolated buyer result");
  }
  expect(answer.pid).not.toBe(process.pid);
  const repeated = await wire.checkWireRequest(await open(answer.header), check);
  expect(repeated.effect).toMatchObject({ state: "completed", operationId: issued.effect.operationId, outcome: { status: 200, text: '{"retained":true}' } });
  expect(serverReads).toBe(2);
}, 60_000);
