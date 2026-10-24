import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { journalFixture } from "./requestJournalFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { registerDiscoverySigner, signRequestWithProof as signWireRequest } from "./requestFixture.js";
// 2026-10-20 approval through the real approval module. No mock or replacement approval.
// The supplied decision record is used offline; generated keys and .invalid
// endpoints test wire admission only, not retained chain-effect adapters.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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
  it("pins the complete canonical record, including provenance and fallback documentation", async () => {
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
    expect((await bindTp1Fixture({ record: RECORD, local: A })).recordDigest).toBe(DIGEST);
  });

  it("binds the 2026-10-20 chain and refuses the 2026-10-15 record and its chain before signing", async () => {
    expect(hash(canonicalize(PREVIOUS_RECORD))).toBe(PREVIOUS_DIGEST);
    expect(TP1_APPROVED_IDENTITY_RECORD_DIGESTS).not.toContain(PREVIOUS_DIGEST);
    const bound = (await bindTp1Fixture({ record: structuredClone(RECORD), local: A }));
    expect(bound.profile).toMatchObject({ chainIdentity: "d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc", pinVersion: "dacs-demos-testnet-identity/2026-10-20" });
    expect(bound.recordDigest).toBe(DIGEST);
    const buyer = party(), seller = party();
    const transport = { send: vi.fn<(header: string) => void>() };
    const sent = await request(buyer, seller, bound, A);
    transport.send(sent.header);
    expect(transport.send).toHaveBeenCalledExactlyOnceWith(sent.header);
    transport.send.mockClear();
    expect(buyer.calls).toBe(1);
    // The previous record exactly as approved, and the previous chain under the current record's other fields.
    for (const record of [PREVIOUS_RECORD, changed({ chainIdentity: PREVIOUS_CHAIN }), changed({ recordId: PREVIOUS_RECORD.recordId, pinVersion: PREVIOUS_RECORD.pinVersion, chainIdentity: PREVIOUS_CHAIN })]) {

      expect(await refusal(async () => {
        transport.send((await request(buyer, seller, (await bindTp1Fixture({ record, local: A })), A)).header);
      }), record.recordId).toBe("tp1_identity_unapproved");
      expect(transport.send).not.toHaveBeenCalled();
    }
    expect(buyer.calls + seller.calls).toBe(1);
  });

  it.each([[A, B], [B, A]])("signs and verifies requests and responses in both directions with different RPC bindings (%j)", async (buyerLocal, sellerLocal) => {
    const buyer = party(), seller = party();
    const bb = await bindTp1Fixture({ record: structuredClone(RECORD), local: buyerLocal });
    const sb = await bindTp1Fixture({ record: RECORD, local: sellerLocal });
    expect(bb.profile).toEqual(sb.profile);
    const { payload, header } = await request(buyer, seller, bb, buyerLocal);
    const opened = (await openWireEnvelope(header, "request", { binding: sb, local: sellerLocal, purchaseProfile: sb.profile }));
    (await checkWireRequest(opened, { requestJournal: testJournal(), ready: true, retained: { jobId: JOB, agreementHash: job.agreementHash, buyer: buyer.claim, seller: seller.claim }, seller: seller.claim, listingPin: PIN, method: "POST", path: payload.path, rawBody: Buffer.from(BODY), now: NOW, binding: sb, local: sellerLocal, purchaseProfile: sb.profile }));
    const response = await signWireResponse(opened.payload, 200, "{}", { signer: seller, binding: sb, local: sellerLocal, now: NOW, purchaseProfile: sb.profile });
    expect((await verifyWireResponse(payload, { header: response, status: 200, body: Buffer.from("{}"), now: NOW, binding: bb, local: buyerLocal })).principal).toBe(seller.claim);
    expect(buyer.calls + seller.calls).toBe(2);
  });

  it("signs and verifies delegation and discovery under the approved identity", async () => {
    const buyer = party(), seller = party(), session = party();
    const bb = await bindTp1Fixture({ record: RECORD, local: A });
    const sb = await bindTp1Fixture({ record: RECORD, local: B });
    const delegation = await signSellerSessionDelegation({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.key, seller: seller.claim, listingPin: PIN, jobId: JOB, notBefore: NOW, expiresAt: NOW + 60_000, profile: bb.profile }, buyer, bb, A);
    await verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), { buyer: buyer.claim, seller: seller.claim, listingPin: PIN, jobId: JOB, time: NOW, binding: sb, local: B });
    const publicEndpoint = "https://seller.identity.invalid";
    const discovery = await signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: sb.profile, seller: seller.claim, publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 60_000 }, seller, sb, B);
    await verifyEndpointProof(discovery, { readListingEligibility: readFixtureListingEligibility, listing: { seller: seller.claim, publicEndpoint, listingPin: PIN }, binding: bb, local: A, now: NOW });
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
    const transport = { send: vi.fn<(header: string) => void>() };
    expect(await refusal(async () => {
      const binding = (await bindTp1Fixture({ record, local: A }));
      transport.send((await request(buyer, seller, binding, A)).header);
    })).toBe(expected);
    expect(buyer.calls + seller.calls).toBe(0);
    expect(transport.send).not.toHaveBeenCalled();
  });

  for (const actor of ["buyer", "seller"] as const) {
    it.each([["endpoint", "https://rpc-c.identity.invalid/"], ["transportAuthority", "changed"], ["connectionId", "changed"]])(`refuses changed ${actor} %s before signing and verification`, async (field, value) => {
      const buyer = party(), seller = party();
      const bb = await bindTp1Fixture({ record: RECORD, local: A });
      const sb = await bindTp1Fixture({ record: RECORD, local: B });
      const transport = { send: vi.fn<(header: string) => void>() };
      const original = await request(buyer, seller, bb, A);
      transport.send(original.header);
      const response = await signWireResponse(original.payload, 200, "{}", { signer: seller, binding: sb, local: B, now: NOW, purchaseProfile: sb.profile });
      transport.send(response);
      expect(transport.send.mock.calls).toEqual([[original.header], [response]]);
      transport.send.mockClear();
      const before = buyer.calls + seller.calls;
      const local = { ...(actor === "buyer" ? A : B), [field]: value };

      expect(await refusal(async () => {
        if (actor === "buyer") transport.send((await request(buyer, seller, bb, local)).header);
        else transport.send(await signWireResponse(original.payload, 200, "{}", { signer: seller, binding: sb, local, now: NOW, purchaseProfile: sb.profile }));
      })).toBe("tp1_local_binding_changed");
      expect(await refusal(async () => actor === "buyer"
        ? (await verifyWireResponse(original.payload, { header: response, status: 200, body: Buffer.from("{}"), now: NOW, binding: bb, local }))
        : (await openWireEnvelope(original.header, "request", { binding: sb, local, purchaseProfile: sb.profile })))).toBe("tp1_local_binding_changed");
      expect(buyer.calls + seller.calls).toBe(before);
      expect(transport.send).not.toHaveBeenCalled();
    });
  }

  it("refuses a peer with a mismatched identity, including the 2026-10-15 chain, under an otherwise valid signature", async () => {
    const buyer = party(), seller = party();
    const bb = await bindTp1Fixture({ record: RECORD, local: A });
    const sb = await bindTp1Fixture({ record: RECORD, local: B });
    const { header } = await request(buyer, seller, bb, A);
    const envelope = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { payload: WireRequestPayload; signature: string };
    for (const other of [{ chainIdentity: hash("SYNTHETIC/peer-other-chain") }, { chainIdentity: PREVIOUS_CHAIN }, { chainIdentity: PREVIOUS_CHAIN, pinVersion: PREVIOUS_RECORD.pinVersion }]) {
      envelope.payload.profile = { ...bb.profile, ...other };
      envelope.signature = Buffer.from(buyer.sign(Buffer.from(`dacs-seller-http:v1:request:${canonicalize(envelope.payload)}`))).toString("base64url");
      expect(await refusal(async () => (await openWireEnvelope(Buffer.from(canonicalize(envelope)).toString("base64url"), "request", { binding: sb, local: B, purchaseProfile: sb.profile }))), JSON.stringify(other)).toBe("tp1_profile_mismatch");
    }
  });

  it("the seller opens no request and signs no answer unless the tuple it kept for the purchase is given and exactly its own", async () => {
    const buyer = party(), seller = party();
    const bb = await bindTp1Fixture({ record: RECORD, local: A });
    const sb = await bindTp1Fixture({ record: RECORD, local: B });
    const { payload, header } = await request(buyer, seller, bb, A);
    const answer = { ...payload, kind: "response" as const, bodyHash: hash("{}"), expiresAt: NOW + 60_000, requestHash: hash(canonicalize(payload)), status: 200 };
    const { revision: _r, ...preRevision } = sb.profile;
    const before = buyer.calls + seller.calls;
    let opened = 0, signed = 0;
    // A valid request under the approved binding; only the seller's kept tuple differs, or is not given.
    for (const kept of [{ purchaseProfile: { ...sb.profile, revision: "TP-1.1" } }, { purchaseProfile: preRevision }, { purchaseProfile: undefined }, {}]) {
      const name = JSON.stringify(kept);
      expect(await refusal(async () => { (await openWireEnvelope(header, "request", { binding: sb, local: B, ...kept } as never)); opened += 1; }), `open ${name}`).toBe("tp1_purchase_profile_mismatch");
      expect(await refusal(async () => { await signWireResponse(payload, 200, "{}", { signer: seller, binding: sb, local: B, now: NOW, ...kept } as never); signed += 1; }), `answer ${name}`).toBe("tp1_purchase_profile_mismatch");
      expect(await refusal(async () => { await signWireEnvelope(answer, { signer: seller, binding: sb, local: B, ...kept } as never); signed += 1; }), `envelope ${name}`).toBe("tp1_purchase_profile_mismatch");
    }
    expect(opened + signed).toBe(0);
    expect(buyer.calls + seller.calls).toBe(before);
    // The exact tuple, or none kept yet for a new purchase, opens and signs once each.
    for (const purchaseProfile of [sb.profile, null]) {
      const { payload: received } = (await openWireEnvelope(header, "request", { binding: sb, local: B, purchaseProfile }));
      await signWireResponse(received, 200, "{}", { signer: seller, binding: sb, local: B, now: NOW, purchaseProfile });
    }
    expect(buyer.calls + seller.calls).toBe(before + 2);
  });

  it("binds the approved tuple (identifier, revision, base) and refuses a missing or other revision in every signed message, under a valid signature", async () => {
    const buyer = party(), seller = party(), session = party();
    const bb = await bindTp1Fixture({ record: RECORD, local: A });
    const sb = await bindTp1Fixture({ record: RECORD, local: B });
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
      expect(await refusal(async () => (await openWireEnvelope(header({ ...payload, profile }, "dacs-seller-http:v1:request:", buyer), "request", { binding: sb, local: B, purchaseProfile: sb.profile })))).toBe(expected);
      expect(await refusal(async () => (await verifyWireResponse(payload, { header: header(response, "dacs-seller-http:v1:response:", seller), status: 200, body: Buffer.from("{}"), now: NOW, binding: bb, local: A })))).toBe(expected);
      expect(await refusal(async () => (await verifySellerSessionDelegation(Buffer.from(JSON.stringify({ payload: d, signature: Buffer.from(buyer.sign(Buffer.from(`dacs-seller-http:v1:delegation:${canonicalize(d)}`))).toString("base64url") })), { binding: sb, local: B, seller: seller.claim, listingPin: PIN, jobId: JOB, time: NOW })))).toBe(expected);
      expect(await refusal(async () => (await verifyEndpointProof(document, { readListingEligibility: readFixtureListingEligibility, listing: { seller: seller.claim, publicEndpoint, listingPin: PIN }, binding: bb, local: A, now: NOW })))).toBe(expected);
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

async function controlledAuthority(asynchronous = false) {
  let transform: (decision: fixtureWire.Tp1AuthorityDecision) => unknown = (decision) => decision;
  const scopes: Readonly<fixtureWire.Tp1AuthorityScope>[] = [];
  const binding = await fixtureWire.bindTp1Profile({ record: RECORD, local: A, readAuthority(scope) {
    scopes.push(scope);
    const decision: fixtureWire.Tp1AuthorityDecision = { local: { ...scope.local }, chainIdentity: RECORD.chainIdentity, provenance: "test-generation-1",
      sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim,
        profile: { id: fixtureWire.TP1_PROFILE_ID, revision: fixtureWire.TP1_PROFILE_REVISION, base: fixtureWire.TP1_BASE_REVISION,
          chainIdentity: RECORD.chainIdentity, pinVersion: RECORD.pinVersion }, modules: { ...fixtureWire.TESTNET_PROFILE_TP1.tuple } })) };
    return asynchronous ? Promise.resolve().then(() => transform(decision)) : transform(decision);
  } });
  return { binding, scopes, change: (next: typeof transform) => { transform = next; } };
}

it("refuses a syntactically valid identity record outside the SDK approval list", async () => {
  await expect(Promise.resolve().then(async () => await bindTp1Fixture({ record: { ...RECORD, recordId: "unapproved-record" }, local: A }))).rejects.toThrow(expect.objectContaining({ code: "tp1_identity_unapproved", status: 500 }));
});

it("requires the original binding and the current bound local connection", async () => {
  const { binding } = await controlledAuthority();
  await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Binding(binding, A))).resolves.toBeUndefined();
  await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Binding({ ...binding }, A))).rejects.toThrow(/tp1_binding_required/);
  await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Authority({ ...binding }, A, [], null))).rejects.toThrow(/tp1_binding_required/);
  for (const field of ["endpoint", "connectionId", "transportAuthority"] as const) {
    const local = { ...A, [field]: field === "endpoint" ? "https://changed.identity.invalid/" : "changed" };
    await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Binding(binding, local))).rejects.toThrow(/tp1_local_binding_changed/);
    await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Authority(binding, local, [], null))).rejects.toThrow(/tp1_local_binding_changed/);
  }
});

it("rechecks revoked or changed authority through assertTp1Binding", async () => {
  const authority = await controlledAuthority();
  for (const transform of [
    () => null,
    (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, provenance: "test-generation-2" }),
    (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, chainIdentity: "0".repeat(64) }),
    (decision: fixtureWire.Tp1AuthorityDecision) => ({ ...decision, local: { ...A, connectionId: "revoked" } }),
  ]) {
    authority.change(transform);
    await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Binding(authority.binding, A))).rejects.toThrow(/tp1_connection_unverified/);
  }
});

it("reads fresh frozen authority scope for each exact job and participant pair", async () => {
  const { binding, scopes } = await controlledAuthority();
  await fixtureWire.assertTp1Authority(binding, A, [BUYER, SELLER], AUTHORITY_JOB);
  await fixtureWire.assertTp1Authority(binding, A, [BUYER, SELLER], AUTHORITY_JOB);
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
])("refuses a wrong session, participant, profile or module tuple (%#)", async (transform) => {
  const authority = await controlledAuthority();
  authority.change(transform);
  await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Authority(authority.binding, A, [BUYER, SELLER], AUTHORITY_JOB))).rejects.toThrow(/tp1_participant_profile_mismatch/);
});

it("rejects malformed sessions and duplicate or missing participants before consulting authority", async () => {
  const { binding, scopes } = await controlledAuthority();
  for (const [participants, session] of [[[BUYER, BUYER], AUTHORITY_JOB], [[BUYER], AUTHORITY_JOB], [[BUYER, SELLER], "invalid-job"]] as const) {
    await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Authority(binding, A, participants, session))).rejects.toThrow(/tp1_participant_profile_mismatch/);
  }
  expect(scopes).toHaveLength(1);
});

it("preserves an authority reader's exact error", async () => {
  const authority = await controlledAuthority();
  const cause = new Error("authority lookup timed out");
  authority.change(() => { throw cause; });
  await expect(Promise.resolve().then(async () => await fixtureWire.assertTp1Binding(authority.binding, A))).rejects.toThrow(cause);
});

it("enforces every peer and retained purchase profile field", async () => {
  const { binding } = await controlledAuthority();
  await fixtureWire.assertPeerProfile(binding.profile, binding);
  await fixtureWire.assertPurchaseProfile(binding.profile, binding);
  await expect(Promise.resolve().then(async () => await fixtureWire.assertPeerProfile(undefined, binding))).rejects.toThrow(/tp1_profile_missing/);
  const { revision: omitted, ...missingRevision } = binding.profile;
  expect(omitted).toBe("TP-1");
  await expect(Promise.resolve().then(async () => await fixtureWire.assertPeerProfile(missingRevision, binding))).rejects.toThrow(/tp1_profile_revision_missing/);
  await expect(Promise.resolve().then(async () => await fixtureWire.assertPeerProfile({ ...binding.profile, revision: "TP-2" }, binding))).rejects.toThrow(/tp1_profile_revision_unknown/);
  for (const field of ["id", "base", "chainIdentity", "pinVersion"] as const) {
    const profile = { ...binding.profile, [field]: field === "base" ? "0".repeat(40) : field === "chainIdentity" ? "0".repeat(64) : "other" };
    await expect(Promise.resolve().then(async () => await fixtureWire.assertPeerProfile(profile, binding, 502))).rejects.toThrow(expect.objectContaining({ code: "tp1_profile_mismatch", status: 502 }));
    await expect(Promise.resolve().then(async () => await fixtureWire.assertPurchaseProfile(profile, binding))).rejects.toThrow(/tp1_purchase_profile_mismatch/);
  }
  for (const profile of [undefined, missingRevision]) {
    await expect(Promise.resolve().then(async () => await fixtureWire.assertPurchaseProfile(profile, binding))).rejects.toThrow(/tp1_purchase_profile_mismatch/);
  }
});


it("a profile shape does not imply the approved identity literals", async () => {
  const { binding } = await controlledAuthority();
  const candidate: unknown = { ...binding.profile, id: "other-profile", revision: "TP-2", base: "0".repeat(40) };
  if (!fixtureWire.isTp1WireProfile(candidate)) throw new Error("expected a valid profile shape");
  expectTypeOf(candidate.id).toEqualTypeOf<string>();
  expectTypeOf(candidate.revision).toEqualTypeOf<string>();
  expectTypeOf(candidate.base).toEqualTypeOf<string>();
  expect(candidate.revision).toBe("TP-2");
  expectTypeOf(binding.profile.revision).toEqualTypeOf<"TP-1">();
  await expect(fixtureWire.assertPeerProfile(candidate, binding)).rejects.toMatchObject({ code: "tp1_profile_revision_unknown" });
});

it("refuses a configured chain even when its complete record is approved", async () => {
  await expect(Promise.resolve().then(async () => await bindTp1Fixture({ record: RECORD, local: A, refusedChainIdentities: [RECORD.chainIdentity] })))
    .rejects.toMatchObject({ code: "tp1_identity_refused", status: 500 });
});

it("refuses the simulated fixture chain before approval", async () => {
  const chainIdentity = hash("dacs-chatgpt-plugin/demos-sr2-sdk-wire-fixture/v1");
  await expect(Promise.resolve().then(async () => await bindTp1Fixture({ record: { ...RECORD, chainIdentity }, local: A })))
    .rejects.toMatchObject({ code: "tp1_identity_fixture", status: 500 });
});

it("SDK chain refusals cannot be removed by the caller", async () => {
  vi.resetModules();
  vi.doMock("../../src/wire/approval.js", () => ({
    TP1_APPROVED_IDENTITY_RECORD_DIGESTS: Object.freeze([DIGEST]),
    TP1_REFUSED_CHAIN_IDENTITIES: Object.freeze([RECORD.chainIdentity]),
  }));
  try {
    const wire = await import("../../src/wire/index.js");
    await expect(Promise.resolve().then(() => fixtureBinder(wire)({ record: RECORD, local: A, refusedChainIdentities: [] })))
      .rejects.toMatchObject({ code: "tp1_identity_refused", status: 500 });
  } finally {
    vi.doUnmock("../../src/wire/approval.js");
    vi.resetModules();
  }
});

it("awaits successful async authority for binding and every assertion", async () => {
  const { binding, scopes } = await controlledAuthority(true);
  await fixtureWire.assertTp1Binding(binding, A);
  await fixtureWire.assertTp1Authority(binding, A, [BUYER, SELLER], AUTHORITY_JOB);
  await fixtureWire.assertPeerProfile(binding.profile, binding);
  await fixtureWire.assertPurchaseProfile(binding.profile, binding);
  expect(scopes).toHaveLength(5);
});

it("preserves a rejected async authority lookup during binding", async () => {
  const cause = new Error("authority lookup timed out");
  await expect(Promise.resolve().then(async () => await fixtureWire.bindTp1Profile({ record: RECORD, local: A, readAuthority: async () => { throw cause; } })))
    .rejects.toBe(cause);
});

it("awaits and preserves rejected async lookups through every assertion", async () => {
  const authority = await controlledAuthority();
  const cause = new Error("authority lookup timed out");
  authority.change(async () => { throw cause; });
  for (const action of [
    async () => await fixtureWire.assertTp1Binding(authority.binding, A),
    async () => await fixtureWire.assertTp1Authority(authority.binding, A, [BUYER, SELLER], AUTHORITY_JOB),
    async () => await fixtureWire.assertPeerProfile(authority.binding.profile, authority.binding),
    async () => await fixtureWire.assertPurchaseProfile(authority.binding.profile, authority.binding),
  ]) await expect(Promise.resolve().then(action)).rejects.toBe(cause);
});


it.each([null, 42, {}, "", RECORD.chainIdentity.toUpperCase(), `${RECORD.chainIdentity} `])("refuses malformed refusal policy entries (%#)", async (entry) => {
  const options = { record: RECORD, local: A };
  Object.defineProperty(options, "refusedChainIdentities", { value: [entry] });
  await expect(bindTp1Fixture(options)).rejects.toMatchObject({ code: "wire_input_invalid", status: 500 });
});

it("keeps the exported profile key policy immutable", async () => {
  const { binding } = await controlledAuthority();
  expect(Object.isFrozen(fixtureWire.TP1_WIRE_PROFILE_KEYS)).toBe(true);
  expect(() => Reflect.set(fixtureWire.TP1_WIRE_PROFILE_KEYS, "0", "unexpected")).not.toThrow();
  expect(fixtureWire.isTp1WireProfile(binding.profile)).toBe(true);
});

it("authenticates exactly one seller for the discovery scope", async () => {
  const authority = await controlledAuthority();
  await fixtureWire.assertTp1Authority(authority.binding, A, [SELLER], "dacs-seller-discovery/v1");
  expect(authority.scopes.at(-1)).toEqual({ local: A, sessionId: "dacs-seller-discovery/v1", participants: [SELLER] });
  const reads = authority.scopes.length;
  for (const participants of [[], [BUYER, SELLER]]) {
    await expect(fixtureWire.assertTp1Authority(authority.binding, A, participants, "dacs-seller-discovery/v1"))
      .rejects.toMatchObject({ code: "tp1_participant_profile_mismatch" });
  }
  expect(authority.scopes).toHaveLength(reads);
  authority.change((decision) => ({ ...decision, participants: decision.participants.map((party) => ({ ...party, claim: BUYER })) }));
  await expect(fixtureWire.assertTp1Authority(authority.binding, A, [SELLER], "dacs-seller-discovery/v1"))
    .rejects.toMatchObject({ code: "tp1_participant_profile_mismatch" });
});
