import { expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { sha256Hex } from "../../src/canonical/hash.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/ed25519.js";
import * as wire from "../../src/wire/index.js";
import { committedPurchase, BUYER_SEED, bytes } from "./committedPurchaseFixture.js";
import { journalFixture } from "./requestJournalFixture.js";

async function fixture(path: string = "/dacs/v1/payments") {
  const p = await committedPurchase(), binding = p.scope.binding, local = binding.local;
  const journal = journalFixture(wire).testJournal({ clock: () => p.scope.now });
  let counter = 0;
  const open = async (text = "{}") => {
    const payload: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path, bodyHash: sha256Hex(text),
      ...p.scope.request, seller: p.scope.seller, listingPin: p.scope.listingPin, nonce: Buffer.alloc(16, counter++).toString("base64url"),
      expiresAt: p.scope.now + 30_000, profile: binding.profile };
    const signature = Buffer.from(ed25519Sign(wire.wireEnvelopeSigningBytes(payload), privateKeyFromSeed(BUYER_SEED))).toString("base64url");
    return wire.openWireEnvelope(Buffer.from(JSON.stringify({ payload, signature })).toString("base64url"), "request", { binding, local, purchaseProfile: binding.profile });
  };
  const check: wire.RequestCheck = { binding, local, purchaseProfile: binding.profile, seller: p.scope.seller, listingPin: p.scope.listingPin,
    method: "POST", path, now: p.scope.now, rawBody: Buffer.from("{}"), ready: true,
    retained: { ...p.scope.request, seller: p.scope.seller }, requestJournal: journal,
    commitment: bytes(p.anchored), agreement: bytes(p.agreement), signedListing: bytes(p.listing),
    readCommitmentReceipt: Object.assign(async () => "valid", { chainIdentity: binding.profile.chainIdentity }) };
  const reservations = () => readdirSync(journal.directory).filter((name) => name.startsWith("k-"));
  return { p, journal, open, check, reservations };
}

it.each(wire.CONTINUING_PATHS)("%s requires the verified Agreement before reserving any effect", async (path) => {
  const f = await fixture(path), opened = await f.open();
  for (const agreement of [undefined, Buffer.from("{}"), bytes({ ...f.p.agreement, signatures: [] })]) {
    await expect(Promise.resolve().then(() => wire.checkWireRequest(opened, { ...f.check, agreement })))
      .rejects.toMatchObject({ code: "continuation_agreement_invalid" });
    expect(f.reservations()).toEqual([]);
  }
  expect((await wire.checkWireRequest(opened, f.check)).effect?.state).toBe("new");
});

it("reserves nothing while a receipt verdict is pending or after it rejects", async () => {
  const f = await fixture(), opened = await f.open();
  let enter: (() => void) | undefined, release: ((verdict: string) => void) | undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const receipt = new Promise<string>((resolve) => { release = resolve; });
  f.check.readCommitmentReceipt = Object.assign(async () => { if (!enter) throw new Error("missing barrier"); enter(); return receipt; },
    { chainIdentity: f.p.scope.binding.profile.chainIdentity });
  const pending = Promise.resolve().then(() => wire.checkWireRequest(opened, f.check));
  // A broken gate may return a runnable effect before entering the reader.
  await Promise.race([entered, pending.then(() => { throw new Error("effect issued before receipt verification"); })]);
  expect(f.reservations()).toEqual([]);
  if (!release) throw new Error("missing receipt barrier");
  release("invalid");
  await expect(pending).rejects.toMatchObject({ code: "continuation_commitment_invalid" });
  expect(f.reservations()).toEqual([]);
});

it("refuses new purchases when the seller drains, before reserving an effect", async () => {
  const f = await fixture("/dacs/v1/commitments");
  await expect(Promise.resolve().then(async () => wire.checkWireRequest(await f.open(), { ...f.check, ready: false })))
    .rejects.toMatchObject({ code: "seller_not_ready" });
  expect(f.reservations()).toEqual([]);
});

it.each(["jobId", "agreementHash", "buyer", "seller"] as const)("rejects a retained %s mismatch before reservation", async (field) => {
  const f = await fixture("/dacs/v1/commitments");
  if (!f.check.retained) throw new Error("missing retained fixture");
  const retained = { ...f.check.retained, [field]: field === "jobId" ? "01J8ME0SXKQ4T9V2RC5HJ6WX7F" : field === "agreementHash" ? "0".repeat(64) : `did:demos:agent:${"f".repeat(64)}` };
  await expect(Promise.resolve().then(async () => wire.checkWireRequest(await f.open(), { ...f.check, retained })))
    .rejects.toMatchObject({ code: field === "jobId" ? "peer_job_mismatch" : field === "agreementHash" ? "peer_agreement_mismatch" : "peer_agreement_party_mismatch" });
  expect(f.reservations()).toEqual([]);
});

it("requires an issued restart-qualified journal instead of a host-made handle", async () => {
  const f = await fixture("/dacs/v1/commitments"), opened = await f.open();
  for (const requestJournal of [undefined, Object.freeze({ directory: f.journal.directory })]) {
    await expect(Promise.resolve().then(() => wire.checkWireRequest(opened, { ...f.check, requestJournal })))
      .rejects.toMatchObject({ code: "seller_replay_guard_required" });
  }
  expect(f.reservations()).toEqual([]);
});

it("keeps one completed operation for a job and path across changed bodies and nonces", async () => {
  const f = await fixture("/dacs/v1/commitments");
  const first = await wire.checkWireRequest(await f.open(), f.check);
  if (!first.effect || first.effect.state !== "new") throw new Error("expected issued effect");
  wire.completeWireEffect(f.journal, first.effect, { status: 200, text: "{}" });
  const text = '{"changed":true}';
  const second = await wire.checkWireRequest(await f.open(text), { ...f.check, rawBody: Buffer.from(text) });
  expect(second.effect).toMatchObject({ state: "completed", operationId: first.effect.operationId });
});
