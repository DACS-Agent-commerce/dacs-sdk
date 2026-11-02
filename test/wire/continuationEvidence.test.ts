// Every signed route is classified once, and every route that continues a committed purchase refuses signing, endpoint proof and seller admission
// without its full commitment evidence, at either readiness: the commitment, the Agreement both parties signed and the signed Listing.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertEndpointProof, CONTINUING_PATHS, isCommittedRoute } from "../../src/wire/discovery.js";
import * as wire from "../../src/wire/index.js";
import { buyerSide, entryPoints, type Buyer } from "./buyerFixture.js";
import { received, signedAgreement, tp1Listing } from "./commitmentFixture.js";
import { journalDirectory } from "./requestJournalFixture.js";
import { ENDPOINT, JOB, LISTING, NOW, P, PIN } from "./reservationFixture.js";

const CLASSES = {
  starting: [P.context, P.proposals, P.commitments, P.commitmentSignature],
  preAgreement: [P.contextChallenge],
  // Readback before any commitment exists; the public discovery document is one, and has no signed-request entry.
  preCommitmentReadback: [P.state, wire.DACS_SELLER_DISCOVERY_PATH],
  continuing: [P.payments, P.bundleRequest, P.bundleCountersignature, P.bundleBuyerCopy],
};
const CONTINUING_EFFECT: readonly string[] = [P.payments, P.bundleRequest, P.bundleCountersignature];
const STARTING_ROUTES = CLASSES.starting;

const flipped = (value: string) => { const bytes = Buffer.from(value, "base64url"); bytes[0]! ^= 1; return bytes.toString("base64url"); };

type Evidence = Record<"commitment" | "agreement" | "signedListing", unknown>;
/** One way to break the commitment evidence, with the code each side refuses it with. */
interface Fault { name: string; change: (good: Evidence, b: Buyer) => Partial<Evidence>; buyer: string; seller: string }
const FAULTS: Fault[] = [
  { name: "commitment omitted", change: () => ({ commitment: undefined }), buyer: "continuation_commitment_invalid", seller: "seller_commitment_required" },
  { name: "Agreement omitted", change: () => ({ agreement: undefined }), buyer: "continuation_agreement_invalid", seller: "continuation_agreement_invalid" },
  { name: "signed Listing omitted", change: () => ({ signedListing: undefined }), buyer: "continuation_listing_invalid", seller: "continuation_listing_invalid" },
  { name: "Agreement with one forged signature", buyer: "continuation_agreement_invalid", seller: "continuation_agreement_invalid", change: (_, b) => {
    const [first, second] = b.x.agreement.signatures;
    return { agreement: received({ ...b.x.agreement, signatures: [{ ...first, value: flipped(first!.value) }, second] }) };
  } },
  { name: "Agreement with the wrong hash", buyer: "continuation_agreement_invalid", seller: "continuation_agreement_invalid", change: (_, b) =>
    ({ agreement: received(signedAgreement({ buyer: b.x.buyer, seller: b.x.seller, jobId: JOB, listingPin: PIN, generatedAt: NOW + 1 }).agreement) }) },
  { name: "commitment forged", buyer: "continuation_commitment_invalid", seller: "continuation_commitment_invalid", change: (_, b) => {
    const { record } = b.x.commitment;
    return { commitment: received({ ...b.x.commitment, record: { ...record, signature: { ...record.signature, value: flipped(record.signature.value) } } }) };
  } },
  { name: "signed Listing forged", buyer: "continuation_listing_invalid", seller: "continuation_listing_invalid",
    change: () => ({ signedListing: received({ ...LISTING, signature: { ...LISTING.signature, value: flipped(LISTING.signature.value) } }) }) },
  { name: "signed Listing hash-mismatched", buyer: "continuation_listing_invalid", seller: "continuation_listing_invalid",
    change: (_, b) => ({ signedListing: received(tp1Listing({ seller: b.x.seller, listingId: "another-listing" }).listing) }) },
];

describe("route classification", () => {
  it("CAP every route is classified once and every continuing route refuses signing, proof and seller admission without full evidence: classes", () => {
    const classified = Object.values(CLASSES).flat();
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...wire.DACS_SELLER_HTTP_ROUTES.map((route) => route.path)].sort());
    expect([...CONTINUING_PATHS].sort()).toEqual([...CONTINUING_EFFECT].sort());
    // The routes that need the commitment evidence are exactly the continuing class, the buyer copy included.
    expect(classified.filter(isCommittedRoute).sort()).toEqual([...CLASSES.continuing].sort());
  });
});

describe("continuing routes need full commitment evidence", { timeout: 120_000 }, () => {
  it("CAP every route is classified once and every continuing route refuses signing, proof and seller admission without full evidence", async () => {
    const b = await buyerSide();
    const good = (): Evidence => ({ commitment: received(b.x.commitment), agreement: received(b.x.agreement), signedListing: received(LISTING) });
    const request = (path: string) => ({ path, jobId: JOB, buyer: b.x.buyer.claim, agreementHash: b.x.agreementHash });
    const assertScope = (path: string, evidence: Evidence) => ({ binding: b.x.binding, seller: b.x.seller.claim, listingPin: PIN, publicEndpoint: ENDPOINT, now: NOW, request: request(path), ...evidence });
    const directory = journalDirectory();
    const journal = wire.openWireRequestJournal(directory);
    for (const ready of [true, false]) {
      const proof = await b.proofAt(ready), document = await b.documentAt(ready);
      for (const path of CLASSES.continuing) for (const fault of FAULTS) {
        const evidence = { ...good(), ...fault.change(good(), b) };
        const name = `${path} ready=${ready} ${fault.name}`;
        for (const [entry, sign] of entryPoints(b)) await expect(sign(path, proof, evidence), `${entry} ${name}`).rejects.toMatchObject({ code: fault.buyer, status: 500 });
        await expect(assertEndpointProof(proof, assertScope(path, evidence)), `assertEndpointProof ${name}`).rejects.toMatchObject({ code: fault.buyer });
        await expect(b.verify(document, { request: request(path), ...evidence }), `verifyEndpointProof ${name}`).rejects.toMatchObject({ code: fault.buyer });
        // The forged-Agreement case rejects: it never resolves with a reserve.
        const check = { ...b.x.check(path), ...evidence, ready, requestJournal: journal };
        await expect(wire.checkWireRequest(await b.x.open(path), check), `checkWireRequest ${name}`).rejects.toMatchObject({ code: fault.seller });
      }
    }
    expect(b.signatures.count).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("CAP complete evidence signs once through either signer, passes both proof entries and admits at the seller; no capability exempts a continuing route", async () => {
    const b = await buyerSide();
    const evidence = b.evidence;
    const request = (path: string) => ({ path, jobId: JOB, buyer: b.x.buyer.claim, agreementHash: b.x.agreementHash });
    const directory = journalDirectory();
    const journal = wire.openWireRequestJournal(directory);
    for (const ready of [true, false]) {
      const proof = await b.proofAt(ready), document = await b.documentAt(ready);
      for (const path of CLASSES.continuing) {
        const before = b.signatures.count;
        for (const [, sign] of entryPoints(b)) await sign(path, proof, evidence);
        expect(b.signatures.count, `${path} ready=${ready}`).toBe(before + 2);
        await expect(assertEndpointProof(proof, { binding: b.x.binding, seller: b.x.seller.claim, listingPin: PIN, publicEndpoint: ENDPOINT, now: NOW, request: request(path), ...evidence })).resolves.toBeUndefined();
        await expect(b.verify(document, { request: request(path), ...evidence }), path).resolves.toMatchObject({ ready });
        // A capability minted for a starting route exempts nothing here.
        for (const [entry, sign] of entryPoints(b)) {
          await expect(sign(path, proof, { ...evidence, continuation: b.mint(P.proposals) }), `${entry} ${path}`).rejects.toMatchObject({ code: "continuation_capability_invalid" });
        }
        const checked = await wire.checkWireRequest(await b.x.open(path), { ...b.x.check(path), ready, requestJournal: journal });
        expect(checked.reserve === null, `${path} reserve`).toBe(!CONTINUING_EFFECT.includes(path));
        expect(readdirSync(directory), path).toEqual([]);
      }
    }
  });

  it("CAP agreements/state signs before a commitment and the four starting routes sign under a ready proof", async () => {
    const b = await buyerSide();
    const ready = await b.proofAt(true);
    for (const [, sign] of entryPoints(b)) {
      await sign(P.state, ready);
      for (const path of STARTING_ROUTES) await sign(path, ready);
    }
    expect(b.signatures.count).toBe(2 * (1 + STARTING_ROUTES.length));
  });
});
