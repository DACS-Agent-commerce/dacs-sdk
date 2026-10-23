import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { journalFixture } from "./requestJournalFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { registerDiscoverySigner, signRequestWithProof as signWireRequest } from "./requestFixture.js";
// 2026-10-20 approval through the real approval module. No mock or replacement approval.
// The supplied decision record is used offline; generated keys and .invalid
// endpoints test wire admission only, not retained chain-effect adapters.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";
import {
  checkWireRequest, openWireEnvelope, signWireEnvelope, signWireResponse,
  signSellerSessionDelegation, verifySellerSessionDelegation, signDiscoveryDocument, verifyEndpointProof,
  verifyWireResponse, TP1_APPROVED_IDENTITY_RECORD_DIGESTS, TP1_APPROVED_IDENTITY_RECORD,
  TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES, TP1_CAPABILITIES, WireError,
  type LocalNetworkBinding, type Tp1Binding, type Tp1WireProfile, type WireRequestPayload,
} from "../../src/wire/index.js";

const bindTp1Fixture = fixtureBinder(fixtureWire);
const { testJournal } = journalFixture(fixtureWire);

const RECORD = TP1_APPROVED_IDENTITY_RECORD;
const DIGEST = "5c234f784b8fbbb77a53886594dbdf3689fbbc336f04c2c930edfd57f225e330";
// The record approved on 2026-10-15 for the chain node2 served before its 2026-10-20 rebuild. No longer approved.
const PREVIOUS_CHAIN = "83082fbb733d76475a33a9f52fe3700d667a976c2d46bef33a149f47057f7dd4";
const PREVIOUS_RECORD = {
  format: "dacs-testnet-identity-record/v1",
  recordId: "dacs-demos-testnet-identity/2026-10-15",
  network: "demos-testnet",
  chainIdentity: PREVIOUS_CHAIN,
  pinVersion: "dacs-demos-testnet-identity/2026-10-15",
  provenance: {
    approvedBy: "the owner",
    approvedAt: "2026-10-15T16:41:00Z",
    source: "Approved Demos testnet identity record (2026-10-15T16:41:00Z)",
    sourceKind: "confirmed-block-one-predecessor",
    documentation: "Demos testnet nodes do not serve block 0 (`getBlockByNumber` 0 returns 400). The chain identity is block 1's `content.previousHash`, checked against the approved record `dacs-demos-testnet-identity/2026-10-15`.",
  },
} as const;
const PREVIOUS_DIGEST = "c4e63ad6a75207c57c9342ed2c4fe38619c2b7cba17610753fbad2d5b4cc3cbd";
const NOW = Date.UTC(2026, 9, 15, 17);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const PIN = { listingId: "approved-identity", version: 1, contentHash: "d".repeat(64) };
const A = { endpoint: "https://rpc-a.identity.invalid/", transportAuthority: "test-a", connectionId: "a-1" };
const B = { endpoint: "https://rpc-b.identity.invalid/", transportAuthority: "test-b", connectionId: "b-1" };
const BODY = `{"jobId":"${JOB}"}`;
const job = { listingPin: PIN, agreementHash: "a".repeat(64) };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function party() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  registerDiscoverySigner({ claim: `did:demos:agent:${key}`, sign: (bytes) => new Uint8Array(sign(null, Buffer.from(bytes), privateKey)) });
  return { key, claim: `did:demos:agent:${key}`, calls: 0, sign(bytes: Uint8Array) {
    this.calls += 1;
    return new Uint8Array(sign(null, Buffer.from(bytes), privateKey));
  } };
}
const changed = (patch: Record<string, unknown>) => ({ ...RECORD, ...patch });
const refusal = async (fn: () => unknown) => {
  try { await fn(); return "ok"; } catch (e) { if (e instanceof WireError) return e.code; throw e; }
};
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline test"); })));
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function request(buyer: ReturnType<typeof party>, seller: ReturnType<typeof party>, binding: Tp1Binding, local: LocalNetworkBinding) {
  return signWireRequest({ signer: buyer, binding, local, path: "/dacs/v1/commitments", jobId: JOB, text: BODY, seller: seller.claim, job: { ...job, profile: (binding as Tp1Binding | undefined)?.profile as Tp1WireProfile }, now: NOW });
}

describe("identity approved on 2026-10-20 using shipped approval", () => {
  it("pins the complete canonical record, including provenance and fallback documentation", () => {
    expect(RECORD.recordId).toBe("dacs-demos-testnet-identity/2026-10-20");
    expect(RECORD.chainIdentity).toBe("d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc");
    expect(RECORD.pinVersion).toBe(RECORD.recordId);
    expect(RECORD.provenance).toMatchObject({ approvedBy: "the owner", approvedAt: "2026-10-20", sourceKind: "confirmed-block-one-predecessor" });
    expect(RECORD.provenance.documentation).toBe("Demos testnet nodes refuse a numeric block 0 (`getBlockByNumber` with `blockNumber: 0` returns RPC result 400). The chain identity is block 1's `content.previousHash`, the genesis hash a string `blockNumber: \"0\"` returns, checked against the approved record `dacs-demos-testnet-identity/2026-10-20`.");
    expect(hash(canonicalize(RECORD))).toBe(DIGEST);
    expect(TP1_APPROVED_IDENTITY_RECORD_DIGESTS).toEqual([DIGEST]);
    expect(Object.isFrozen(RECORD) && Object.isFrozen(RECORD.provenance)).toBe(true);
    expect(RECORD).not.toHaveProperty("endpoint");
    expect(RECORD).not.toHaveProperty("transportAuthority");
    expect(bindTp1Fixture({ record: RECORD, local: A }).recordDigest).toBe(DIGEST);
  });

  it("binds the 2026-10-20 chain and refuses the 2026-10-15 record and its chain before signing", async () => {
    expect(hash(canonicalize(PREVIOUS_RECORD))).toBe(PREVIOUS_DIGEST);
    expect(TP1_APPROVED_IDENTITY_RECORD_DIGESTS).not.toContain(PREVIOUS_DIGEST);
    const bound = bindTp1Fixture({ record: structuredClone(RECORD), local: A });
    expect(bound.profile).toMatchObject({ chainIdentity: "d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc", pinVersion: "dacs-demos-testnet-identity/2026-10-20" });
    expect(bound.recordDigest).toBe(DIGEST);
    const buyer = party(), seller = party();
    await request(buyer, seller, bound, A);
    expect(buyer.calls).toBe(1);
    // The previous record exactly as approved, and the previous chain under the current record's other fields.
    for (const record of [PREVIOUS_RECORD, changed({ chainIdentity: PREVIOUS_CHAIN }), changed({ recordId: PREVIOUS_RECORD.recordId, pinVersion: PREVIOUS_RECORD.pinVersion, chainIdentity: PREVIOUS_CHAIN })]) {
      let sends = 0;
      expect(await refusal(async () => {
        await request(buyer, seller, bindTp1Fixture({ record, local: A }), A);
        sends += 1;
      }), record.recordId).toBe("tp1_identity_unapproved");
      expect(sends).toBe(0);
    }
    expect(buyer.calls + seller.calls).toBe(1);
  });

  it.each([[A, B], [B, A]])("signs and verifies requests and responses in both directions with different RPC bindings (%j)", async (buyerLocal, sellerLocal) => {
    const buyer = party(), seller = party();
    const bb = bindTp1Fixture({ record: structuredClone(RECORD), local: buyerLocal });
    const sb = bindTp1Fixture({ record: RECORD, local: sellerLocal });
    expect(bb.profile).toEqual(sb.profile);
    const { payload, header } = await request(buyer, seller, bb, buyerLocal);
    const opened = openWireEnvelope(header, "request", { binding: sb, local: sellerLocal, purchaseProfile: sb.profile });
    checkWireRequest(opened, { requestJournal: testJournal(), ready: true, retained: { jobId: JOB, agreementHash: job.agreementHash, buyer: buyer.claim, seller: seller.claim }, seller: seller.claim, listingPin: PIN, method: "POST", path: payload.path, rawBody: Buffer.from(BODY), now: NOW, binding: sb, local: sellerLocal, purchaseProfile: sb.profile });
    const response = await signWireResponse(opened.payload, 200, "{}", { signer: seller, binding: sb, local: sellerLocal, now: NOW, purchaseProfile: sb.profile });
    expect(verifyWireResponse(payload, { header: response, status: 200, body: Buffer.from("{}"), now: NOW, binding: bb, local: buyerLocal }).principal).toBe(seller.claim);
    expect(buyer.calls + seller.calls).toBe(2);
  });

  it("signs and verifies delegation and discovery under the approved identity", async () => {
    const buyer = party(), seller = party(), session = party();
    const bb = bindTp1Fixture({ record: RECORD, local: A });
    const sb = bindTp1Fixture({ record: RECORD, local: B });
    const delegation = await signSellerSessionDelegation({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.key, seller: seller.claim, listingPin: PIN, jobId: JOB, notBefore: NOW, expiresAt: NOW + 60_000, profile: bb.profile }, buyer, bb, A);
    verifySellerSessionDelegation(delegation, { buyer: buyer.claim, seller: seller.claim, listingPin: PIN, jobId: JOB, time: NOW, binding: sb, local: B });
    const publicEndpoint = "https://seller.identity.invalid";
    const discovery = await signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: sb.profile, seller: seller.claim, publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 60_000 }, seller, sb, B);
    verifyEndpointProof(discovery, { readListingEligibility: readFixtureListingEligibility, listing: { seller: seller.claim, publicEndpoint, listingPin: PIN }, binding: bb, local: A, now: NOW });
    expect(buyer.calls + seller.calls).toBe(2);
  });

  it.each([
    ["missing record", undefined, "tp1_identity_record_missing"],
    ["missing identity", changed({ chainIdentity: undefined }), "tp1_identity_pin_missing"],
    ["missing pin version", changed({ pinVersion: undefined }), "tp1_identity_pin_missing"],
    ["fixture identity", changed({ chainIdentity: TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0] }), "tp1_identity_fixture"],
    ["mocked mainnet labelled testnet", changed({ chainIdentity: hash("MOCKED-MAINNET/test-only") }), "tp1_identity_unapproved"],
    ["unknown identity", changed({ chainIdentity: hash("SYNTHETIC/unknown") }), "tp1_identity_unapproved"],
    ["the 2026-10-15 record, no longer approved", PREVIOUS_RECORD, "tp1_identity_unapproved"],
    ["the 2026-10-15 chain under the current record", changed({ chainIdentity: PREVIOUS_CHAIN }), "tp1_identity_unapproved"],
    ["wrong record identifier", changed({ recordId: "unknown-record" }), "tp1_identity_unapproved"],
    ["wrong pin version", changed({ pinVersion: "unknown-pin/1" }), "tp1_identity_unapproved"],
    ["changed provenance", changed({ provenance: { ...RECORD.provenance, source: "unknown source" } }), "tp1_identity_unapproved"],
    ["changed fallback text", changed({ provenance: { ...RECORD.provenance, documentation: "different fallback" } }), "tp1_identity_unapproved"],
    ["unknown source kind", changed({ provenance: { ...RECORD.provenance, sourceKind: "unknown" } }), "tp1_identity_record_invalid"],
    ["missing fallback text", changed({ provenance: { ...RECORD.provenance, documentation: undefined } }), "tp1_identity_record_invalid"],
    ["missing source kind", changed({ provenance: { approvedBy: "the owner", approvedAt: RECORD.provenance.approvedAt, source: RECORD.provenance.source, documentation: RECORD.provenance.documentation } }), "tp1_identity_record_invalid"],
    ["actor endpoint in record", changed({ endpoint: A.endpoint }), "tp1_identity_record_invalid"],
    ["actor authority in record", changed({ transportAuthority: A.transportAuthority }), "tp1_identity_record_invalid"],
  ])("refuses %s before signing or a test transport send", async (_, record, expected) => {
    const buyer = party(), seller = party();
    let sends = 0;
    expect(await refusal(async () => {
      const binding = bindTp1Fixture({ record, local: A });
      await request(buyer, seller, binding, A);
      sends += 1;
    })).toBe(expected);
    expect(buyer.calls + seller.calls).toBe(0);
    expect(sends).toBe(0);
  });

  for (const actor of ["buyer", "seller"] as const) {
    it.each([["endpoint", "https://rpc-c.identity.invalid/"], ["transportAuthority", "changed"], ["connectionId", "changed"]])(`refuses changed ${actor} %s before signing and verification`, async (field, value) => {
      const buyer = party(), seller = party();
      const bb = bindTp1Fixture({ record: RECORD, local: A });
      const sb = bindTp1Fixture({ record: RECORD, local: B });
      const original = await request(buyer, seller, bb, A);
      const response = await signWireResponse(original.payload, 200, "{}", { signer: seller, binding: sb, local: B, now: NOW, purchaseProfile: sb.profile });
      const before = buyer.calls + seller.calls;
      const local = { ...(actor === "buyer" ? A : B), [field]: value };
      let sends = 0;
      expect(await refusal(async () => {
        if (actor === "buyer") await request(buyer, seller, bb, local);
        else await signWireResponse(original.payload, 200, "{}", { signer: seller, binding: sb, local, now: NOW, purchaseProfile: sb.profile });
        sends += 1;
      })).toBe("tp1_local_binding_changed");
      expect(await refusal(() => actor === "buyer"
        ? verifyWireResponse(original.payload, { header: response, status: 200, body: Buffer.from("{}"), now: NOW, binding: bb, local })
        : openWireEnvelope(original.header, "request", { binding: sb, local, purchaseProfile: sb.profile }))).toBe("tp1_local_binding_changed");
      expect(buyer.calls + seller.calls).toBe(before);
      expect(sends).toBe(0);
    });
  }

  it("refuses a peer with a mismatched identity, including the 2026-10-15 chain, under an otherwise valid signature", async () => {
    const buyer = party(), seller = party();
    const bb = bindTp1Fixture({ record: RECORD, local: A });
    const sb = bindTp1Fixture({ record: RECORD, local: B });
    const { header } = await request(buyer, seller, bb, A);
    const envelope = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { payload: WireRequestPayload; signature: string };
    for (const other of [{ chainIdentity: hash("SYNTHETIC/peer-other-chain") }, { chainIdentity: PREVIOUS_CHAIN }, { chainIdentity: PREVIOUS_CHAIN, pinVersion: PREVIOUS_RECORD.pinVersion }]) {
      envelope.payload.profile = { ...bb.profile, ...other };
      envelope.signature = Buffer.from(buyer.sign(Buffer.from(`dacs-seller-http:v1:request:${canonicalize(envelope.payload)}`))).toString("base64url");
      expect(await refusal(() => openWireEnvelope(Buffer.from(canonicalize(envelope)).toString("base64url"), "request", { binding: sb, local: B, purchaseProfile: sb.profile })), JSON.stringify(other)).toBe("tp1_profile_mismatch");
    }
  });

  it("the seller opens no request and signs no answer unless the tuple it kept for the purchase is given and exactly its own", async () => {
    const buyer = party(), seller = party();
    const bb = bindTp1Fixture({ record: RECORD, local: A });
    const sb = bindTp1Fixture({ record: RECORD, local: B });
    const { payload, header } = await request(buyer, seller, bb, A);
    const answer = { ...payload, kind: "response" as const, bodyHash: hash("{}"), expiresAt: NOW + 60_000, requestHash: hash(canonicalize(payload)), status: 200 };
    const { revision: _r, ...preRevision } = sb.profile;
    const before = buyer.calls + seller.calls;
    let opened = 0, signed = 0;
    // A valid request under the approved binding; only the seller's kept tuple differs, or is not given.
    for (const kept of [{ purchaseProfile: { ...sb.profile, revision: "TP-1.1" } }, { purchaseProfile: preRevision }, { purchaseProfile: undefined }, {}]) {
      const name = JSON.stringify(kept);
      expect(await refusal(() => { openWireEnvelope(header, "request", { binding: sb, local: B, ...kept } as never); opened += 1; }), `open ${name}`).toBe("tp1_purchase_profile_mismatch");
      expect(await refusal(async () => { await signWireResponse(payload, 200, "{}", { signer: seller, binding: sb, local: B, now: NOW, ...kept } as never); signed += 1; }), `answer ${name}`).toBe("tp1_purchase_profile_mismatch");
      expect(await refusal(async () => { await signWireEnvelope(answer, { signer: seller, binding: sb, local: B, ...kept } as never); signed += 1; }), `envelope ${name}`).toBe("tp1_purchase_profile_mismatch");
    }
    expect(opened + signed).toBe(0);
    expect(buyer.calls + seller.calls).toBe(before);
    // The exact tuple, or none kept yet for a new purchase, opens and signs once each.
    for (const purchaseProfile of [sb.profile, null]) {
      const { payload: received } = openWireEnvelope(header, "request", { binding: sb, local: B, purchaseProfile });
      await signWireResponse(received, 200, "{}", { signer: seller, binding: sb, local: B, now: NOW, purchaseProfile });
    }
    expect(buyer.calls + seller.calls).toBe(before + 2);
  });

  it("binds the approved tuple (identifier, revision, base) and refuses a missing or other revision in every signed message, under a valid signature", async () => {
    const buyer = party(), seller = party(), session = party();
    const bb = bindTp1Fixture({ record: RECORD, local: A });
    const sb = bindTp1Fixture({ record: RECORD, local: B });
    expect(bb.profile).toEqual({ id: "dacs-testnet-tp1", revision: "TP-1", base: "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20", chainIdentity: RECORD.chainIdentity, pinVersion: RECORD.pinVersion });
    const { payload } = await request(buyer, seller, bb, A);
    const { revision: _r, ...preRevision } = bb.profile;
    const header = (p: object, domain: string, signer: ReturnType<typeof party>) =>
      Buffer.from(canonicalize({ payload: p, signature: Buffer.from(signer.sign(Buffer.from(`${domain}${canonicalize(p)}`))).toString("base64url") })).toString("base64url");
    const publicEndpoint = "https://seller.identity.invalid";
    const discovery = { format: "dacs-seller-discovery/v1", profile: sb.profile, seller: seller.claim, publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 60_000 };
    const delegationPayload = { version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.key, seller: seller.claim, listingPin: PIN, jobId: JOB, notBefore: NOW, expiresAt: NOW + 60_000, profile: bb.profile };
    for (const [profile, expected] of [[preRevision, "tp1_profile_revision_missing"], [{ ...bb.profile, revision: "TP-1.1" }, "tp1_profile_revision_unknown"], [{ ...bb.profile, revision: " TP-1" }, "tp1_profile_revision_unknown"]] as const) {
      const response = { ...payload, profile, kind: "response", bodyHash: hash("{}"), expiresAt: NOW + 60_000, requestHash: hash(canonicalize(payload)), status: 200 };
      const d = { ...delegationPayload, profile };
      const document = Buffer.from(canonicalize({ payload: { ...discovery, profile }, signature: Buffer.from(seller.sign(Buffer.from(`dacs-seller-http:v1:discovery:${canonicalize({ ...discovery, profile })}`))).toString("base64url") }));
      expect(await refusal(() => openWireEnvelope(header({ ...payload, profile }, "dacs-seller-http:v1:request:", buyer), "request", { binding: sb, local: B, purchaseProfile: sb.profile }))).toBe(expected);
      expect(await refusal(() => verifyWireResponse(payload, { header: header(response, "dacs-seller-http:v1:response:", seller), status: 200, body: Buffer.from("{}"), now: NOW, binding: bb, local: A }))).toBe(expected);
      expect(await refusal(() => verifySellerSessionDelegation({ payload: d, signature: Buffer.from(buyer.sign(Buffer.from(`dacs-seller-http:v1:delegation:${canonicalize(d)}`))).toString("base64url") }, { binding: sb, local: B }))).toBe(expected);
      expect(await refusal(() => verifyEndpointProof(document, { readListingEligibility: readFixtureListingEligibility, listing: { seller: seller.claim, publicEndpoint, listingPin: PIN }, binding: bb, local: A, now: NOW }))).toBe(expected);
      // Signers sign only the exact tuple.
      const before = buyer.calls + seller.calls;
      expect(await refusal(() => signSellerSessionDelegation(d as never, buyer, bb, A))).toBe(expected);
      expect(await refusal(() => signDiscoveryDocument({ ...discovery, profile } as never, seller, sb, B))).toBe(expected);
      expect(await refusal(() => signWireRequest({ signer: buyer, binding: bb, local: A, path: "/dacs/v1/commitments", jobId: JOB, text: BODY, seller: seller.claim, job: { ...job, profile: profile as never }, now: NOW }))).toBe("tp1_purchase_profile_mismatch");
      expect(buyer.calls + seller.calls).toBe(before);
    }
  });
});

const BUYER = `did:demos:agent:${"a".repeat(64)}`;
const SELLER = `did:demos:agent:${"b".repeat(64)}`;
const AUTHORITY_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";

function controlledAuthority() {
  let transform: (decision: fixtureWire.Tp1AuthorityDecision) => unknown = (decision) => decision;
  const scopes: Readonly<fixtureWire.Tp1AuthorityScope>[] = [];
  const binding = fixtureWire.bindTp1Profile({ record: RECORD, local: A, readAuthority(scope) {
    scopes.push(scope);
    return transform({ local: { ...scope.local }, chainIdentity: RECORD.chainIdentity, provenance: "test-generation-1",
      sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim,
        profile: { id: fixtureWire.TP1_PROFILE_ID, revision: fixtureWire.TP1_PROFILE_REVISION, base: fixtureWire.TP1_BASE_REVISION,
          chainIdentity: RECORD.chainIdentity, pinVersion: RECORD.pinVersion }, modules: { ...fixtureWire.TESTNET_PROFILE_TP1.tuple } })) });
  } });
  return { binding, scopes, change: (next: typeof transform) => { transform = next; } };
}

it("refuses a syntactically valid identity record outside the SDK approval list", () => {
  expect(() => bindTp1Fixture({ record: { ...RECORD, recordId: "unapproved-record" }, local: A }))
    .toThrow(expect.objectContaining({ code: "tp1_identity_unapproved", status: 500 }));
});

it("requires the original binding and the current bound local connection", () => {
  const { binding } = controlledAuthority();
  expect(() => fixtureWire.assertTp1Binding(binding, A)).not.toThrow();
  expect(() => fixtureWire.assertTp1Binding({ ...binding }, A)).toThrow(/tp1_binding_required/);
  expect(() => fixtureWire.assertTp1Authority({ ...binding }, A, [], null)).toThrow(/tp1_binding_required/);
  for (const field of ["endpoint", "connectionId", "transportAuthority"] as const) {
    const local = { ...A, [field]: field === "endpoint" ? "https://changed.identity.invalid/" : "changed" };
    expect(() => fixtureWire.assertTp1Binding(binding, local)).toThrow(/tp1_local_binding_changed/);
    expect(() => fixtureWire.assertTp1Authority(binding, local, [], null)).toThrow(/tp1_local_binding_changed/);
  }
});

it("rechecks revoked or changed authority through assertTp1Binding", () => {
  const authority = controlledAuthority();
  for (const transform of [
    () => null,
    (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, provenance: "test-generation-2" }),
    (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, chainIdentity: "0".repeat(64) }),
    (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, local: { ...A, connectionId: "revoked" } }),
  ]) {
    authority.change(transform);
    expect(() => fixtureWire.assertTp1Binding(authority.binding, A)).toThrow(/tp1_connection_unverified/);
  }
});

it("reads fresh frozen authority scope for each exact job and participant pair", () => {
  const { binding, scopes } = controlledAuthority();
  fixtureWire.assertTp1Authority(binding, A, [BUYER, SELLER], AUTHORITY_JOB);
  fixtureWire.assertTp1Authority(binding, A, [BUYER, SELLER], AUTHORITY_JOB);
  expect(scopes).toHaveLength(3);
  expect(scopes[1]).not.toBe(scopes[2]);
  expect(scopes[2]).toEqual({ local: A, sessionId: AUTHORITY_JOB, participants: [BUYER, SELLER] });
  for (const scope of scopes) {
    expect(Object.isFrozen(scope) && Object.isFrozen(scope.local) && Object.isFrozen(scope.participants)).toBe(true);
  }
});

it.each([
  (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, sessionId: "01J8ME0SXKQ4T9V2RC5HJ6WX7F" }),
  (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, participants: [...decision.participants].reverse() }),
  (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, participants: [] }),
  (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, participants: decision.participants.map((party) => ({ ...party, profile: { ...party.profile, base: "0".repeat(40) } })) }),
  (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, participants: decision.participants.map((party) => ({ ...party, modules: { ...party.modules, CORE: "0.2" } })) }),
])("refuses a wrong session, participant, profile or module tuple (%#)", (transform) => {
  const authority = controlledAuthority();
  authority.change(transform);
  expect(() => fixtureWire.assertTp1Authority(authority.binding, A, [BUYER, SELLER], AUTHORITY_JOB)).toThrow(/tp1_participant_profile_mismatch/);
});

it("rejects malformed sessions and duplicate or missing participants before consulting authority", () => {
  const { binding, scopes } = controlledAuthority();
  for (const [participants, session] of [[[BUYER, BUYER], AUTHORITY_JOB], [[BUYER], AUTHORITY_JOB], [[BUYER, SELLER], "invalid-job"]] as const) {
    expect(() => fixtureWire.assertTp1Authority(binding, A, participants, session)).toThrow(/tp1_participant_profile_mismatch/);
  }
  expect(scopes).toHaveLength(1);
});

it("preserves an authority reader's exact error", () => {
  const authority = controlledAuthority();
  const cause = new Error("authority lookup timed out");
  authority.change(() => { throw cause; });
  expect(() => fixtureWire.assertTp1Binding(authority.binding, A)).toThrow(cause);
});

it("enforces every peer and retained purchase profile field", () => {
  const { binding } = controlledAuthority();
  fixtureWire.assertPeerProfile(binding.profile, binding);
  fixtureWire.assertPurchaseProfile(binding.profile, binding);
  expect(() => fixtureWire.assertPeerProfile(undefined, binding)).toThrow(/tp1_profile_missing/);
  const { revision: omitted, ...missingRevision } = binding.profile;
  expect(omitted).toBe("TP-1");
  expect(() => fixtureWire.assertPeerProfile(missingRevision, binding)).toThrow(/tp1_profile_revision_missing/);
  expect(() => fixtureWire.assertPeerProfile({ ...binding.profile, revision: "TP-2" }, binding)).toThrow(/tp1_profile_revision_unknown/);
  for (const field of ["id", "base", "chainIdentity", "pinVersion"] as const) {
    const profile = { ...binding.profile, [field]: field === "base" ? "0".repeat(40) : field === "chainIdentity" ? "0".repeat(64) : "other" };
    expect(() => fixtureWire.assertPeerProfile(profile, binding, 502)).toThrow(expect.objectContaining({ code: "tp1_profile_mismatch", status: 502 }));
    expect(() => fixtureWire.assertPurchaseProfile(profile, binding)).toThrow(/tp1_purchase_profile_mismatch/);
  }
  for (const profile of [undefined, missingRevision]) {
    expect(() => fixtureWire.assertPurchaseProfile(profile, binding)).toThrow(/tp1_purchase_profile_mismatch/);
  }
});
