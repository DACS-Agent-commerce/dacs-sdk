import { fixtureBinder } from "./authorityFixture.js";
import { journalFixture } from "./requestJournalFixture.js";
import { agreementFixture } from "./agreementFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
// Replays vectors/dacs-seller-http-v1.json. Each negative must fail with its
// own named code, not an earlier one. Request and response bodies
// go through checkWireRequest and verifyWireResponse alone, so their CF-5
// admission is the composed path's own; signing vectors go through the
// signers alone, with a counting signer. A `view` vector passes its record,
// connection, delegation payload, or a signer's payload or request, as a Proxy
// or accessor whose answer changes after n reads, and must have one outcome for
// every n. Synthetic records are approved only
// through the test approval list (./testApproval.ts), which replaces
// approval.ts in whichever src/wire is under test; no shipped module takes an
// approval list.
import { createPublicKey, generateKeyPairSync, sign, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { canonicalize } from "../../src/canonical/index.js";
import type * as WireModule from "../../src/wire/index.js";
import { withTestApproval } from "./testApproval.js";

vi.doMock("../../src/wire/approval.js", () => import("./testApproval.js"));
const wire = (await import("../../src/wire/index.js")) as typeof WireModule;
const bindTp1Fixture = fixtureBinder(wire);
const { testJournal } = journalFixture(wire);
const { signRequestWithProof, registerDiscoverySigner } = await import("./requestFixture.js");

interface Vector {
  id: string;
  kind: "request" | "delegation" | "response" | "discovery" | "binding" | "signing";
  check: string | null;
  input: Record<string, any>;
  expect: { ok: boolean; code?: string; detail?: string; readbackOnly?: boolean };
}
const file = JSON.parse(readFileSync(new URL("../../vectors/dacs-seller-http-v1.json", import.meta.url), "utf8"));
const vectors = file.vectors as Vector[];
const b = (text: string) => Buffer.from(text, "base64url");
const rawBodyText = (text: string) => b(text).toString("utf8");

/**
 * The tuple an actor kept for the purchase: the vector's own value (null, a
 * profile, or "omitted"), or by default the exact tuple of the vector record,
 * as the member `as` of the entry point's input.
 */
function kept(input: Record<string, any>, key: "purchaseProfile" | "checkPurchaseProfile" | "jobProfile", as = "purchaseProfile"): Record<string, unknown> {
  if (!Object.hasOwn(input, key)) return { [as]: file.identity.profile };
  return input[key] === "omitted" ? {} : { [as]: input[key] };
}
const jobFor = (input: Record<string, any>) => ({ listingPin: file.job.listingPin, agreementHash: file.job.agreementHash, ...kept(input, "jobProfile", "profile") });
/** The seller's kept tuple at checkWireRequest: `checkPurchaseProfile` when the vector gives one, else the one it opened with. */
const keptAtCheck = (input: Record<string, any>) => kept(input, Object.hasOwn(input, "checkPurchaseProfile") ? "checkPurchaseProfile" : "purchaseProfile");

/** A received vector's signed payload, its signature and the domain and party it should verify under. */
function signedMessage(v: Vector): { domain: string; party: string; payload: Record<string, any>; signature: Buffer } {
  const domains = { request: "dacs-seller-http:v1:request:", response: "dacs-seller-http:v1:response:", delegation: "dacs-seller-http:v1:delegation:", discovery: "dacs-seller-http:v1:discovery:" };
  if (v.kind === "delegation") {
    return { domain: domains.delegation, party: file.parties.buyer, payload: v.input.delegation.payload, signature: Buffer.from(v.input.delegation.signature.replace(/^0x/, ""), "hex") };
  }
  const envelope = JSON.parse(b(v.kind === "discovery" ? v.input.document : v.input.header).toString("utf8"));
  const party = v.kind === "request" ? file.parties.buyer : file.parties.seller;
  return { domain: domains[v.kind as "request" | "response" | "discovery"], party, payload: envelope.payload, signature: b(envelope.signature) };
}
const rawKey = (claim: string) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(claim.slice(-64), "hex")]), format: "der", type: "spki" });

function bind(local: unknown) {
  return withTestApproval(file.identity.testApprovedRecordDigests, async () => (await bindTp1Fixture({ record: file.identity.record, local })));
}

/** A signer made for one vector; it counts its calls and its key is discarded. */
function countingSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claim = `did:demos:agent:${publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`;
  const signer = { claim, calls: 0, sign(bytes: Uint8Array) { signer.calls += 1; return new Uint8Array(sign(null, Buffer.from(bytes), privateKey)); } };
  registerDiscoverySigner({ claim: signer.claim, sign: (bytes) => new Uint8Array(sign(null, Buffer.from(bytes), privateKey)) });
  return signer;
}

/**
 * A delegated request whose session signer edits the caller's delegation while
 * it signs. The header must embed the delegation that was verified, unedited,
 * and the seller must open it.
 */
async function delegatedRequestEditedWhileSigning(input: Record<string, any>, text: string): Promise<void> {
  const local = file.localBindings.buyer;
  const binding = (await bind(local));
  const wallet = countingSigner(), session = countingSigner();
  const genuine = await wire.signSellerSessionDelegation({
    version: "1", kind: "seller-session-delegation", buyer: wallet.claim, sessionPublicKey: session.claim.slice("did:demos:agent:".length),
    seller: file.parties.seller, listingPin: file.job.listingPin, jobId: file.job.jobId, notBefore: file.now - 1000, expiresAt: file.now + 3_600_000,
    profile: binding.profile,
  }, wallet, binding, local);
  const delegation = structuredClone(genuine);
  const editing = {
    claim: session.claim,
    async sign(bytes: Uint8Array) {
      const signature = session.sign(bytes);
      await Promise.resolve();
      delegation.payload.expiresAt = file.now + 24 * 3_600_000;
      delegation.signature = `0x${"0".repeat(128)}`;
      return signature;
    },
  };
  const { header } = await signRequestWithProof({ signer: editing, binding, local, path: input.path, jobId: file.job.jobId, text, seller: file.parties.seller, job: jobFor(input) as WireModule.WireJobContext, delegation, now: file.now, publicEndpoint: file.vectors.find((v: Vector) => v.id === "discovery/valid").input.listing.publicEndpoint }, b(file.vectors.find((v: Vector) => v.id === "discovery/valid").input.document));
  const embedded = JSON.parse(b(header).toString("utf8")).delegation;
  if (!isDeepStrictEqual(embedded, genuine)) throw new Error("the header embeds a delegation other than the one verified");
  (await wire.openWireEnvelope(header, "request", { binding: (await bind(file.localBindings.seller)), local: file.localBindings.seller, purchaseProfile: file.identity.profile, requireDelegation: true }));
  if (wallet.calls !== 1 || session.calls !== 1) throw new Error(`signers were called ${wallet.calls} and ${session.calls} time(s)`);
}

/**
 * A producer must refuse, before its signer, a body its peer would refuse, and
 * a payload or request that is not data (`subjectView`, from withView).
 */
async function produce(input: Record<string, any>): Promise<void> {
  const signer = countingSigner();
  const text = input.body === undefined ? "" : b(input.body).toString("utf8");
  const subject = (value: Record<string, unknown>): any => (input.subjectView ? changingView(value, input.subjectView, input.subjectView.honestReads) : value);
  if (input.producer === "request-delegated") return delegatedRequestEditedWhileSigning(input, text);
  try {
    if (input.producer === "request-eligibility") {
      const local = file.localBindings.buyer;
      const binding = (await bind(local));
      const discovery = file.vectors.find((v: Vector) => v.id === "discovery/valid").input;
      const endpointProof = (await wire.verifyEndpointProof(b(discovery.document), {
        listing: discovery.listing, binding, local, now: file.now,
        readListingEligibility: (scope) => ({ ...(readFixtureListingEligibility(scope) as Record<string, unknown>), ...input.eligibility }),
      }));
      await wire.signWireRequest({ signer, binding, local, path: input.path, jobId: file.job.jobId, text,
        seller: file.parties.seller, job: jobFor(input) as WireModule.WireJobContext,
        endpointProof, publicEndpoint: discovery.listing.publicEndpoint, now: file.now });
    } else if (input.producer === "request") {
      const local = file.localBindings.buyer;
      await signRequestWithProof({ signer, binding: (await bind(local)), local, path: input.path, jobId: file.job.jobId, text, seller: file.parties.seller, job: jobFor(input) as WireModule.WireJobContext, now: file.now, publicEndpoint: file.vectors.find((v: Vector) => v.id === "discovery/valid").input.listing.publicEndpoint }, b(file.vectors.find((v: Vector) => v.id === "discovery/valid").input.document));
    } else if (input.producer === "response") {
      const local = file.localBindings.seller;
      await wire.signWireResponse(subject({ ...input.request, seller: signer.claim }), 200, text, { signer, binding: (await bind(local)), local, now: file.now, ...kept(input, "purchaseProfile") } as unknown as WireModule.EnvelopeSigningContext & { now: number });
    } else if (input.producer === "envelope") {
      const local = file.localBindings.buyer;
      const binding = (await bind(local));
      const discovery = file.vectors.find((v: Vector) => v.id === "discovery/valid").input;
      const endpointProof = (await wire.verifyEndpointProof(b(discovery.document), { readListingEligibility: readFixtureListingEligibility, listing: discovery.listing, binding, local, now: file.now }));
      await wire.signWireEnvelope(subject({ ...input.payload }), { signer, binding, local, ...kept(input, "purchaseProfile"), endpointProof, publicEndpoint: discovery.listing.publicEndpoint, now: file.now } as unknown as WireModule.EnvelopeSigningContext, input.delegation);
    } else if (input.producer === "delegation") {
      const local = file.localBindings.buyer;
      await wire.signSellerSessionDelegation(subject({ ...input.payload, buyer: signer.claim }), signer, (await bind(local)), local);
    } else if (input.producer === "discovery") {
      const local = file.localBindings.seller;
      await wire.signDiscoveryDocument(subject({ ...input.payload, seller: signer.claim }), signer, (await bind(local)), local);
    } else throw new Error(`unknown producer ${input.producer}`);
  } catch (error) {
    if (signer.calls !== 0) throw new Error(`${input.producer} signer was called ${signer.calls} time(s) before refusing`);
    throw error;
  }
  if (signer.calls !== 1) throw new Error(`${input.producer} signer was called ${signer.calls} time(s)`);
}

/**
 * The verifier's binding and current connection. By default a binding made
 * for the actor's own connection; `verifier.forgedBinding` is a plain object
 * passed instead, and `verifier.local` a changed connection.
 */
async function verifier(input: Record<string, any>, local: unknown): Promise<{ binding: WireModule.Tp1Binding; local: unknown }> {
  if (input.verifier?.forgedBinding) return { binding: input.verifier.forgedBinding, local };
  return { binding: (await bind(local)), local: input.verifier?.local ?? local };
}

async function run(v: Vector): Promise<Record<string, unknown>> {
  const { input } = v;
  switch (v.kind) {
    case "request": {
      const own = file.localBindings.seller;
      const { binding, local } = (await verifier(input, own));
      const rawBody = b(input.body);
      const opened = (await wire.openWireEnvelope(input.header, "request", { binding, local, requireDelegation: input.requireDelegation, ...kept(input, "purchaseProfile") } as unknown as WireModule.OpenEnvelopeOptions));
      // checkSubject: what reaches checkWireRequest instead of the opened envelope.
      const subject = input.checkSubject === "decoded-header" ? JSON.parse(rawBodyText(input.header))
        : input.checkSubject === "copy" ? { ...opened } : opened;
      // retained: the job, Agreement hash and parties the seller host kept (the file's job); a vector may give another, or "omitted".
      const retained = input.retained === "omitted" ? undefined
        : input.retained ?? { jobId: file.job.jobId, agreementHash: file.job.agreementHash, buyer: file.parties.buyer, seller: file.parties.seller };
      const { readbackOnly } = (await wire.checkWireRequest(subject, { requestJournal: testJournal(), ready: true, artifacts: agreementFixture(opened), retained,
        seller: input.server?.seller ?? file.parties.seller, listingPin: input.server?.listingPin ?? file.job.listingPin,
        method: input.method ?? "POST", path: input.path, rawBody, now: file.now,
        requireDelegation: Object.hasOwn(input, "checkRequireDelegation") ? input.checkRequireDelegation : input.requireDelegation,
        binding: input.checkSubject === "other-binding" ? (await bind(own)) : binding, local: input.checkLocal ?? own,
        ...(input.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: input.maxLifetimeMs }), ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
        ...keptAtCheck(input),
      } as unknown as WireModule.RequestCheck));
      return readbackOnly ? { ok: true, readbackOnly } : { ok: true };
    }
    case "delegation":
      (await wire.verifySellerSessionDelegation(v.id === "delegation/payload-changes-between-reads" ? input.delegation : Buffer.from(JSON.stringify(input.delegation)), {
        ...(await verifier(input, file.localBindings.seller)), buyer: file.parties.buyer, seller: file.parties.seller,
        listingPin: file.job.listingPin, jobId: file.job.jobId, time: file.now, ...input.scope,
      }));
      return { ok: true };
    case "response":
      // requireDelegation: the answer is opened as a host calling the exported verifier with that flag would.
      if (input.requireDelegation) {
        (await wire.openWireEnvelope(input.header, "response", { ...(await verifier(input, file.localBindings.buyer)), purchaseProfile: input.request.profile, principal: input.request.seller, requireDelegation: true }));
        return { ok: true };
      }
      (await wire.verifyWireResponse(input.request, { header: input.header, status: input.status, body: b(input.body), now: file.now, ...(await verifier(input, file.localBindings.buyer)) }));
      return { ok: true };
    case "discovery":
      (await wire.verifyEndpointProof(b(input.document), { readListingEligibility: readFixtureListingEligibility, listing: input.listing, now: file.now, ...(await verifier(input, file.localBindings.buyer)) }));
      return { ok: true };
    case "binding": {
      const { gate, approvedRecordDigests, view: _view, local = file.localBindings.buyer, ...options } = input;
      // "test-approval": the vector's list stands in for the SDK's (approval.ts).
      if (gate === "test-approval") await withTestApproval(approvedRecordDigests, async () => (await bindTp1Fixture({ ...options, local } as WireModule.BindTp1Options)));
      // "public": no test approval is active; any vector list is passed in as a caller might try.
      else if (gate === "public") (await bindTp1Fixture({ ...options, ...(approvedRecordDigests ? { approvedRecordDigests } : {}), local } as WireModule.BindTp1Options));
      else throw new Error(`unknown gate ${gate}`);
      return { ok: true };
    }
    case "signing":
      await produce(input);
      return { ok: true };
  }
}

async function once(v: Vector): Promise<Record<string, unknown>> {
  try {
    return await run(v);
  } catch (error) {
    if (!(error instanceof wire.WireError)) throw error;
    return { ok: false, code: error.code, ...(error.detail === undefined ? {} : { detail: error.detail }) };
  }
}

/**
 * `view`: the value at `of` is passed as a Proxy, or with an accessor, whose
 * `field` answers the value's own for the first `honestReads` reads and `after`
 * from then on.
 */
function changingView(value: Record<string, unknown>, view: { as: string; field: string; after: unknown }, honestReads: number) {
  let reads = 0;
  const own = value[view.field];
  const answer = () => (reads++ < honestReads ? own : view.after);
  if (view.as === "proxy") return new Proxy({ ...value }, { get: (target, key, receiver) => (key === view.field ? answer() : Reflect.get(target, key, receiver)) });
  if (view.as === "accessor") return Object.defineProperty({ ...value }, view.field, { enumerable: true, configurable: true, get: answer });
  throw new Error(`unknown view ${view.as}`);
}

function withView(v: Vector, honestReads: number): Vector {
  const { view, ...input } = v.input;
  if (view.of === "record") return { ...v, input: { ...input, record: changingView(input.record, view, honestReads) } };
  if (view.of === "local") return { ...v, input: { ...input, local: changingView(input.local, view, honestReads) } };
  if (view.of === "delegation.payload") return { ...v, input: { ...input, delegation: { ...input.delegation, payload: changingView(input.delegation.payload, view, honestReads) } } };
  // A signer's payload or request: produce() wraps it after setting the signer's own claim.
  if (view.of === "payload" || view.of === "request") return { ...v, input: { ...input, subjectView: { ...view, honestReads } } };
  throw new Error(`unknown view target ${view.of}`);
}

/** A `view` vector's outcome must be the same whichever read its value starts to change on (0 to 16). */
async function outcome(v: Vector): Promise<Record<string, unknown>> {
  if (!v.input.view) return once(v);
  const outcomes = new Map<string, Record<string, unknown>>();
  for (let honestReads = 0; honestReads <= 16; honestReads += 1) {
    const result = await once(withView(v, honestReads));
    outcomes.set(JSON.stringify(result), result);
  }
  const [only, ...others] = outcomes.values();
  return only !== undefined && others.length === 0 ? only : { ok: "differs between reads", outcomes: [...outcomes.keys()] };
}

describe("dacs-seller-http/v1 vectors", () => {
  it("cover every acceptance class and name the check each negative targets", () => {
    expect(file.format).toBe("dacs-seller-http-v1-vectors/1");
    const ids = vectors.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of vectors) expect(v.expect.ok || typeof v.check === "string").toBe(true);
    for (const required of [
      "signing/request-listing-x402", "signing/request-listing-metered", "signing/request-listing-input",
      "request/old-domain", "request/profile-missing", "request/profile-wrong-chain", "delegation/expired",
      "delegation/wrong-seller-scope", "delegation/wrong-buyer-scope", "discovery/endpoint-mismatch", "request/cf5-body-duplicate-member",
      "request/cf5-body-malformed-utf8", "request/cf5-body-non-nfc", "request/cf5-body-invalid-number",
      "response/cf5-duplicate-member", "response/cf5-malformed-utf8", "response/cf5-non-nfc", "response/cf5-invalid-number",
      "request/lifetime-override-over-60s", "binding/record-missing", "binding/pin-missing", "binding/fixture-identity",
      "binding/mainnet-labelled-testnet-unapproved", "binding/mainnet-labelled-testnet-caller-approved", "binding/caller-list-cannot-approve",
      "discovery/cf5-duplicate-member", "discovery/cf5-malformed-utf8", "discovery/cf5-non-nfc", "discovery/cf5-invalid-number",
      "signing/request-cf5-duplicate-member", "signing/request-cf5-non-nfc", "signing/request-cf5-invalid-number",
      "signing/response-cf5-duplicate-member", "signing/response-cf5-non-nfc", "signing/response-cf5-invalid-number",
      "request/forged-binding", "delegation/forged-binding", "response/forged-binding", "discovery/forged-binding",
      "request/local-binding-changed", "request/local-binding-changed-before-check", "delegation/local-binding-changed",
      "response/local-binding-changed", "discovery/local-binding-changed",
      "request/check-unopened-envelope", "request/check-copied-envelope", "request/check-other-binding",
      // The seller's exchange, delegation-scope and retained-Agreement party bindings.
      "request/path-mismatch", "request/method-mismatch", "request/delegated-buyer-mismatch",
      "request/delegated-agreement-buyer-party-mismatch", "request/delegated-agreement-seller-party-mismatch",
      "request/valid-delegated-agreement-parties-reordered",
      // The job and Agreement hash the seller host retained, compared on every request.
      "request/retained-agreement-hash-mismatch", "request/retained-job-mismatch", "request/retained-agreement-omitted",
      "request/delegated-retained-agreement-hash-mismatch",
      // The parties the seller host retained, compared on every request with or without artifacts.
      "request/retained-buyer-mismatch", "request/retained-seller-mismatch", "request/retained-parties-omitted",
      "request/delegated-retained-buyer-mismatch",
      // A delegation is verified whenever a request carries one; a publicEndpoint is an origin.
      "request/valid-delegated-not-required", "discovery/listing-endpoint-with-path",
      "binding/record-proxy-changes-between-reads", "binding/record-accessor-changes-between-reads",
      "binding/local-proxy-changes-between-reads", "delegation/payload-changes-between-reads",
      "signing/envelope-payload-changes-between-reads", "signing/delegation-payload-changes-between-reads",
      "signing/discovery-payload-changes-between-reads", "signing/response-request-changes-between-reads",
      "signing/request-delegation-edited-while-signing",
      // Format discriminators at the signers (admission.test.ts covers the receivers with correctly signed messages).
      "signing/delegation-version-unknown", "signing/delegation-version-number", "signing/delegation-kind-unknown",
      "signing/discovery-format-unknown", "signing/discovery-transport-unknown", "signing/discovery-transport-extra",
      "signing/discovery-transport-array-like",
      // The tuple (identifier, revision, base): missing, unknown, mismatched, variant, extra and duplicate revisions,
      // identifier and base alone, the tuple kept for the purchase, and the exact tuple.
      "request/valid-exact-tuple-kept", "request/valid-new-purchase",
      "request/profile-revision-missing", "request/profile-identifier-and-base-only", "request/profile-revision-unknown",
      "request/profile-revision-mismatch", "request/profile-revision-lowercase", "request/profile-revision-mixed-case",
      "request/profile-revision-leading-space", "request/profile-revision-trailing-space", "request/profile-revision-trailing-newline",
      "request/profile-revision-number", "request/profile-revision-null", "request/profile-revision-extra-member",
      "request/profile-revision-duplicate-member", "request/purchase-profile-omitted", "request/purchase-profile-revision-missing",
      "request/purchase-profile-other-revision", "delegation/profile-revision-missing", "delegation/profile-revision-unknown",
      "response/profile-revision-missing", "response/profile-revision-unknown", "response/kept-request-revision-missing",
      "discovery/profile-revision-missing", "discovery/profile-revision-unknown", "discovery/profile-revision-mismatch",
      "signing/request-purchase-profile-missing", "signing/request-purchase-profile-revision-missing",
      "signing/request-purchase-profile-other-revision", "signing/envelope-profile-revision-missing",
      "signing/response-request-revision-unknown", "signing/delegation-profile-revision-unknown", "signing/discovery-profile-revision-missing",
      // The seller's kept tuple at each of its entry points, and the generic signer's.
      "request/open-purchase-profile-other-revision", "request/open-purchase-profile-omitted",
      "request/check-purchase-profile-other-revision", "request/check-purchase-profile-omitted",
      // The seller's required delegation at each of its entry points.
      "request/open-delegation-required", "request/check-delegation-required",
      "signing/response-purchase-profile-missing", "signing/response-purchase-profile-other-revision", "signing/response-new-purchase",
      "signing/envelope-purchase-profile-missing", "signing/envelope-purchase-profile-other-revision", "signing/envelope-request-purchase-profile-none",
      // No delegation authenticates or accompanies a seller answer: at the buyer, at the exported verifier with
      // requireDelegation set, and at the generic signer.
      "response/delegated-session-signed", "response/delegated-session-signed-delegation-required", "signing/envelope-response-delegation",
    ]) expect(ids).toContain(required);
  });

  it("every correctly signed message whose tuple is not exactly TP-1's names a profile refusal", () => {
    // The revision vectors match the identifier and base; none is admitted on them alone.
    const revisionVectors = vectors.filter((v) => /profile-(?:revision|identifier-and-base)/.test(v.id) && !v.id.includes("purchase") && v.id !== "request/profile-revision-duplicate-member");
    expect(revisionVectors.length).toBe(27);
    for (const v of revisionVectors) expect(v.expect.code, v.id).toMatch(/^tp1_profile_(?:revision_missing|revision_unknown|mismatch)$/);
    expect(file.identity.profile).toEqual({ id: "dacs-testnet-tp1", revision: "TP-1", base: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20", chainIdentity: file.identity.record.chainIdentity, pinVersion: file.identity.record.pinVersion });
    // Each received one is correctly signed by its party, under its own domain, over the tuple it names.
    const received = revisionVectors.filter((v) => v.kind !== "signing");
    expect(received.length).toBe(24);
    for (const v of received) {
      const { domain, party, payload, signature } = signedMessage(v);
      expect(payload.profile.id, v.id).toBe("dacs-testnet-tp1");
      expect(payload.profile.base ?? null, v.id).toBe("d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20");
      expect(cryptoVerify(null, Buffer.from(`${domain}${canonicalize(payload)}`, "utf8"), rawKey(party), signature), v.id).toBe(true);
    }
  });

  for (const v of vectors) {
    it(v.id, async () => {
      expect(await outcome(v)).toEqual(v.expect);
    });
  }
});
