// The buyer's continuation capability: under a ready:false endpoint proof, only retained purchase work signs, and only with a capability this module
// registered for the request's exact scope. The two ordinary reads (agreements/state, bundles/buyer-copy) need none at either readiness.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical/index.js";
import { assertEndpointProof } from "../../src/wire/discovery.js";
import * as wire from "../../src/wire/index.js";
import { PROOF_LIFETIME_MS, buyerSide, entryPoints, header, type Sign } from "./buyerFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { ENDPOINT, JOB, NOW, P, PIN, party, world } from "./reservationFixture.js";

const OTHER_JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4J";
const STARTING_ROUTES = [P.context, P.proposals, P.commitments, P.commitmentSignature];
const ORDINARY_READS = [P.state, P.bundleBuyerCopy];
const invalid = { code: "continuation_capability_invalid", status: 500 };
const notReady = { code: "seller_not_ready", status: 503 };

describe("the buyer's continuation capability", { timeout: 60_000 }, () => {
  it("CAP K5-W1 without a capability, context, proposal and commitment requests under ready:false are seller_not_ready with signer 0", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false);
    for (const path of STARTING_ROUTES) for (const [name, sign] of entryPoints(b)) {
      await expect(sign(path, drained), `${name} ${path}`).rejects.toMatchObject(notReady);
    }
    expect(b.signatures.count).toBe(0);
  });

  it("CAP K5-W2 a registered capability with the request's scope signs once, with the same header as under a ready proof", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false), ready = await b.proofAt(true);
    for (const path of STARTING_ROUTES) for (const kind of ["retry", "next-stage"]) {
      const before = b.signatures.count;
      const continued = await b.signRequest(path, drained, { continuation: b.mint(path, { kind }) });
      expect(b.signatures.count, `${path} ${kind}`).toBe(before + 1);
      expect(continued.header, `${path} ${kind}`).toBe((await b.signRequest(path, ready)).header);
    }
  });

  it("CAP K5-W3 a capability scope differing in one member is continuation_capability_invalid", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false);
    const other = party();
    const differing: Record<string, unknown> = { seller: other.claim, publicEndpoint: "https://other.agreement.invalid", listingPin: { ...PIN, version: PIN.version + 1 },
      buyer: other.claim, jobId: OTHER_JOB, path: P.commitments, bodyHash: sha256Hex("another body") };
    expect(Object.keys(differing)).toHaveLength(7);
    for (const [member, value] of Object.entries(differing)) {
      const continuation = b.mint(P.proposals, { [member]: value });
      for (const [name, sign] of entryPoints(b)) await expect(sign(P.proposals, drained, { continuation }), `${name} ${member}`).rejects.toMatchObject(invalid);
    }
    expect(b.signatures.count).toBe(0);
  });

  it("CAP K5-W4 true, a structuredClone or another binding's capability is continuation_capability_invalid", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false);
    const otherBinding = (await world()).binding;
    const foreign = wire.retainedPurchaseContinuation(otherBinding, b.scopeFor(P.proposals) as never);
    const real = b.mint(P.proposals);
    for (const forged of [true, "retry", {}, { kind: "retry" }, structuredClone(real), { ...real }, Object.freeze({ ...real }), foreign]) {
      for (const [name, sign] of entryPoints(b)) await expect(sign(P.proposals, drained, { continuation: forged }), `${name} ${JSON.stringify(forged)}`).rejects.toMatchObject(invalid);
    }
    expect(b.signatures.count).toBe(0);
  });

  it("CAP K5-W5 a valid capability does not lift proof expiry, the Listing window or an authority refusal", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false);
    const continuation = b.mint(P.proposals);
    await expect(b.signRequest(P.proposals, drained, { continuation, now: NOW + PROOF_LIFETIME_MS }), "proof expiry").rejects.toMatchObject({ code: "discovery_expired", status: 503 });
    let windowEnded = false;
    const ended = await buyerSide({ readListing: (scope) => ({ ...readFixtureListingEligibility(scope), ...(windowEnded ? { expiresAt: NOW - 1 } : {}) }) });
    const endedProof = await ended.proofAt(false);
    windowEnded = true;
    await expect(ended.signRequest(P.proposals, endedProof, { continuation: ended.mint(P.proposals) }), "Listing window").rejects.toMatchObject({ code: "listing_unsupported", status: 500 });
    const failure = new Error("authority withdrawn");
    let withdrawn = false;
    const guarded = await buyerSide({ readAuthority: (scope) => {
      if (withdrawn) throw failure;
      return { local: { ...scope.local }, chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: "test-only-independent-authority/v1",
        sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile: guarded.x.binding.profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) };
    } });
    const proof = await guarded.proofAt(false), held = guarded.mint(P.proposals);
    withdrawn = true;
    await expect(guarded.signRequest(P.proposals, proof, { continuation: held }), "authority").rejects.toBe(failure);
    expect(b.signatures.count + ended.signatures.count + guarded.signatures.count).toBe(0);
  });

  it("CAP K5-W6 a ready proof signs with or without a valid capability and refuses an invalid one", async () => {
    const b = await buyerSide(), ready = await b.proofAt(true);
    for (const path of STARTING_ROUTES) for (const [name, sign] of entryPoints(b)) {
      await sign(path, ready);
      await sign(path, ready, { continuation: b.mint(path) });
      await expect(sign(path, ready, { continuation: b.mint(path, { jobId: OTHER_JOB }) }), `${name} ${path}`).rejects.toMatchObject(invalid);
      await expect(sign(path, ready, { continuation: true }), `${name} ${path}`).rejects.toMatchObject(invalid);
    }
  });

  it("CAP no capability is minted for the challenge, payment, delivery or read routes, and none applies to them", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false), ready = await b.proofAt(true);
    const unminted = [P.contextChallenge, P.payments, P.bundleRequest, P.bundleCountersignature, P.state, P.bundleBuyerCopy];
    for (const path of unminted) expect(() => b.mint(path), path).toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
    const stray = b.mint(P.proposals);
    for (const path of [P.payments, P.bundleRequest, P.bundleCountersignature, P.state, P.bundleBuyerCopy]) for (const proof of [drained, ready]) {
      for (const [name, sign] of entryPoints(b)) await expect(sign(path, proof, { continuation: stray }), `${name} ${path}`).rejects.toMatchObject(invalid);
    }
  });

  it("CAP minting refuses missing, extra or malformed scope members and an unknown kind", async () => {
    const b = await buyerSide();
    const scope = b.scopeFor(P.proposals);
    const refused = expect.objectContaining({ code: "wire_input_invalid", status: 500 });
    for (const member of Object.keys(scope)) {
      const { [member]: _removed, ...missing } = scope as Record<string, unknown>;
      void _removed;
      expect(() => wire.retainedPurchaseContinuation(b.x.binding, missing as never), `missing ${member}`).toThrowError(refused);
    }
    const malformed: Record<string, unknown> = { seller: "seller", publicEndpoint: "http://seller.invalid", listingPin: { listingId: "x" }, buyer: "buyer", jobId: "job",
      path: "/dacs/v1/unknown", bodyHash: "abc", kind: "first" };
    for (const [member, value] of Object.entries(malformed)) expect(() => b.mint(P.proposals, { [member]: value }), `malformed ${member}`).toThrowError(refused);
    expect(() => b.mint(P.proposals, { extra: true }), "extra member").toThrowError(refused);
    expect(() => wire.retainedPurchaseContinuation(null as never, scope as never), "no binding").toThrowError(refused);
    for (const given of [null, undefined, "scope", []]) expect(() => wire.retainedPurchaseContinuation(b.x.binding, given as never)).toThrowError(refused);
  });

  it("CAP the capability never enters the signed payload or header", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false);
    const continuation = b.mint(P.proposals);
    for (const encoded of [header(await b.signRequest(P.proposals, drained, { continuation })), await b.signEnvelope(P.proposals, drained, { continuation })]) {
      const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(Object.keys(decoded).sort()).toEqual(["payload", "signature"]);
      expect(JSON.stringify(decoded)).not.toMatch(/continuation|next-stage|retry/);
    }
  });

  it("CAP signWireEnvelope applies the same capability rule as signWireRequest", async () => {
    const b = await buyerSide(), drained = await b.proofAt(false);
    const outcome = async (sign: Sign, continuation: unknown) => {
      try { await sign(P.commitments, drained, continuation === undefined ? {} : { continuation }); return "signed"; } catch (error) { return (error as wire.WireError).code; }
    };
    const cases: Array<[string, unknown, string]> = [["none", undefined, "seller_not_ready"], ["valid", b.mint(P.commitments), "signed"],
      ["another path", b.mint(P.proposals), "continuation_capability_invalid"], ["boolean", true, "continuation_capability_invalid"]];
    for (const [name, continuation, expected] of cases) {
      expect(await outcome(b.signRequest, continuation), `signWireRequest ${name}`).toBe(expected);
      expect(await outcome(b.signEnvelope, continuation), `signWireEnvelope ${name}`).toBe(expected);
    }
  });

  it("CAP reconciliation 9 keeps both ordinary reads available at either readiness", async () => {
    const failure = new Error("authority withdrawn");
    let withdrawn = false;
    const b = await buyerSide({ readAuthority: (scope) => {
      if (withdrawn) throw failure;
      return { local: { ...scope.local }, chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: "test-only-independent-authority/v1",
        sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile: b.x.binding.profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) };
    } });
    const request = (path: string) => ({ path, jobId: JOB, buyer: b.x.buyer.claim, agreementHash: b.x.agreementHash });
    const scope = (path: string, now = NOW) => ({ binding: b.x.binding, seller: b.x.seller.claim, listingPin: PIN, publicEndpoint: ENDPOINT, now, request: request(path), ...b.withEvidence(path) });
    for (const path of ORDINARY_READS) for (const ready of [true, false]) {
      const proof = await b.proofAt(ready), name = `${path} ready=${ready}`;
      const before = b.signatures.count;
      await b.signRequest(path, proof); await b.signEnvelope(path, proof);
      expect(b.signatures.count, name).toBe(before + 2);
      await expect(assertEndpointProof(proof, scope(path)), name).resolves.toBeUndefined();
      await expect(assertEndpointProof(proof, scope(path, NOW + PROOF_LIFETIME_MS)), `${name} expired`).rejects.toMatchObject({ code: "discovery_expired" });
      for (const [entry, sign] of entryPoints(b)) await expect(sign(path, proof, { continuation: b.mint(P.proposals) }), `${name} ${entry} capability`).rejects.toMatchObject(invalid);
      withdrawn = true;
      for (const [entry, sign] of entryPoints(b)) await expect(sign(path, proof), `${name} ${entry} authority`).rejects.toBe(failure);
      withdrawn = false;
    }
    // State is read before any commitment exists; the verified proof also accepts its request.
    const document = await b.documentAt(false);
    for (const path of ORDINARY_READS) {
      await expect(b.verify(document, { request: request(path), ...b.withEvidence(path) }), path).resolves.toMatchObject({ ready: false });
    }
  });
});
