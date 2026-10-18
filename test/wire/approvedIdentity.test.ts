// 2026-10-15 approval through the real approval module. No mock or replacement approval.
// The supplied decision record is used offline; generated keys and .invalid
// endpoints test wire admission only, not retained chain-effect adapters.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/canonical/index.js";
import {
  bindTp1Profile, checkWireRequest, openWireEnvelope, signWireEnvelope, signWireRequest, signWireResponse,
  signSellerSessionDelegation, verifySellerSessionDelegation, signDiscoveryDocument, verifyEndpointProof,
  verifyWireResponse, TP1_APPROVED_IDENTITY_RECORD_DIGESTS, TP1_APPROVED_IDENTITY_RECORD,
  TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES, TP1_CAPABILITIES, WireError,
  type LocalNetworkBinding, type Tp1Binding, type Tp1WireProfile, type WireRequestPayload,
} from "../../src/wire/index.js";

const RECORD = TP1_APPROVED_IDENTITY_RECORD;
const DIGEST = "c4e63ad6a75207c57c9342ed2c4fe38619c2b7cba17610753fbad2d5b4cc3cbd";
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
  return { key, claim: `did:demos:agent:${key}`, calls: 0, sign(bytes: Uint8Array) {
    this.calls += 1;
    return new Uint8Array(sign(null, Buffer.from(bytes), privateKey));
  } };
}
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

describe("identity approved on 2026-10-15 using shipped approval", () => {
  it("pins the complete canonical record, including provenance and fallback documentation", () => {
    expect(RECORD.recordId).toBe("dacs-demos-testnet-identity/2026-10-15");
    expect(RECORD.chainIdentity).toBe("83082fbb733d76475a33a9f52fe3700d667a976c2d46bef33a149f47057f7dd4");
    expect(RECORD.pinVersion).toBe(RECORD.recordId);
    expect(RECORD.provenance).toMatchObject({ approvedBy: "the owner", approvedAt: "2026-10-15T16:41:00Z", sourceKind: "confirmed-block-one-predecessor" });
    expect(RECORD.provenance.documentation).toBe("Demos testnet nodes do not serve block 0 (`getBlockByNumber` 0 returns 400). The chain identity is block 1's `content.previousHash`, checked against the approved record `dacs-demos-testnet-identity/2026-10-15`.");
    expect(hash(canonicalize(RECORD))).toBe(DIGEST);
    expect(TP1_APPROVED_IDENTITY_RECORD_DIGESTS).toEqual([DIGEST]);
    expect(Object.isFrozen(RECORD) && Object.isFrozen(RECORD.provenance)).toBe(true);
    expect(RECORD).not.toHaveProperty("endpoint");
    expect(RECORD).not.toHaveProperty("transportAuthority");
    expect(bindTp1Profile({ record: RECORD, local: A }).recordDigest).toBe(DIGEST);
  });

  it.each([[A, B], [B, A]])("signs and verifies requests and responses in both directions with different RPC bindings (%j)", async (buyerLocal, sellerLocal) => {
    const buyer = party(), seller = party();
    const bb = bindTp1Profile({ record: structuredClone(RECORD), local: buyerLocal });
    const sb = bindTp1Profile({ record: RECORD, local: sellerLocal });
    expect(bb.profile).toEqual(sb.profile);
    const { payload, header } = await request(buyer, seller, bb, buyerLocal);
    const opened = openWireEnvelope(header, "request", { binding: sb, local: sellerLocal, purchaseProfile: sb.profile });
    checkWireRequest(opened, { seller: seller.claim, listingPin: PIN, method: "POST", path: payload.path, rawBody: Buffer.from(BODY), now: NOW, binding: sb, local: sellerLocal, purchaseProfile: sb.profile });
    const response = await signWireResponse(opened.payload, 200, "{}", { signer: seller, binding: sb, local: sellerLocal, now: NOW, purchaseProfile: sb.profile });
    expect(verifyWireResponse(payload, { header: response, status: 200, body: Buffer.from("{}"), now: NOW, binding: bb, local: buyerLocal }).principal).toBe(seller.claim);
    expect(buyer.calls + seller.calls).toBe(2);
  });

  it("signs and verifies delegation and discovery under the approved identity", async () => {
    const buyer = party(), seller = party(), session = party();
    const bb = bindTp1Profile({ record: RECORD, local: A });
    const sb = bindTp1Profile({ record: RECORD, local: B });
    const delegation = await signSellerSessionDelegation({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.key, seller: seller.claim, listingPin: PIN, jobId: JOB, notBefore: NOW, expiresAt: NOW + 60_000, profile: bb.profile }, buyer, bb, A);
    verifySellerSessionDelegation(delegation, { buyer: buyer.claim, seller: seller.claim, listingPin: PIN, jobId: JOB, time: NOW, binding: sb, local: B });
    const publicEndpoint = "https://seller.identity.invalid";
    const discovery = await signDiscoveryDocument({ format: "dacs-seller-discovery/v1", profile: sb.profile, seller: seller.claim, publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [PIN], capabilities: TP1_CAPABILITIES, ready: true, issuedAt: NOW, expiresAt: NOW + 60_000 }, seller, sb, B);
    verifyEndpointProof(discovery, { listing: { seller: seller.claim, publicEndpoint, listingPin: PIN }, binding: bb, local: A, now: NOW });
    expect(buyer.calls + seller.calls).toBe(2);
  });

  const changed = (patch: Record<string, unknown>) => ({ ...RECORD, ...patch });
  it.each([
    ["missing record", undefined, "tp1_identity_record_missing"],
    ["missing identity", changed({ chainIdentity: undefined }), "tp1_identity_pin_missing"],
    ["missing pin version", changed({ pinVersion: undefined }), "tp1_identity_pin_missing"],
    ["fixture identity", changed({ chainIdentity: TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES[0] }), "tp1_identity_fixture"],
    ["mocked mainnet labelled testnet", changed({ chainIdentity: hash("MOCKED-MAINNET/test-only") }), "tp1_identity_unapproved"],
    ["unknown identity", changed({ chainIdentity: hash("SYNTHETIC/unknown") }), "tp1_identity_unapproved"],
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
      const binding = bindTp1Profile({ record, local: A });
      await request(buyer, seller, binding, A);
      sends += 1;
    })).toBe(expected);
    expect(buyer.calls + seller.calls).toBe(0);
    expect(sends).toBe(0);
  });

  for (const actor of ["buyer", "seller"] as const) {
    it.each([["endpoint", "https://rpc-c.identity.invalid/"], ["transportAuthority", "changed"], ["connectionId", "changed"]])(`refuses changed ${actor} %s before signing and verification`, async (field, value) => {
      const buyer = party(), seller = party();
      const bb = bindTp1Profile({ record: RECORD, local: A });
      const sb = bindTp1Profile({ record: RECORD, local: B });
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

  it("refuses a peer with a mismatched identity under an otherwise valid signature", async () => {
    const buyer = party(), seller = party();
    const bb = bindTp1Profile({ record: RECORD, local: A });
    const sb = bindTp1Profile({ record: RECORD, local: B });
    const { header } = await request(buyer, seller, bb, A);
    const envelope = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { payload: WireRequestPayload; signature: string };
    envelope.payload.profile = { ...bb.profile, chainIdentity: hash("SYNTHETIC/peer-other-chain") };
    envelope.signature = Buffer.from(buyer.sign(Buffer.from(`dacs-seller-http:v1:request:${canonicalize(envelope.payload)}`))).toString("base64url");
    expect(await refusal(() => openWireEnvelope(Buffer.from(canonicalize(envelope)).toString("base64url"), "request", { binding: sb, local: B, purchaseProfile: sb.profile }))).toBe("tp1_profile_mismatch");
  });

  it("the seller opens no request and signs no answer unless the tuple it kept for the purchase is given and exactly its own", async () => {
    const buyer = party(), seller = party();
    const bb = bindTp1Profile({ record: RECORD, local: A });
    const sb = bindTp1Profile({ record: RECORD, local: B });
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
    const bb = bindTp1Profile({ record: RECORD, local: A });
    const sb = bindTp1Profile({ record: RECORD, local: B });
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
      expect(await refusal(() => verifyEndpointProof(document, { listing: { seller: seller.claim, publicEndpoint, listingPin: PIN }, binding: bb, local: A, now: NOW }))).toBe(expected);
      // Signers sign only the exact tuple.
      const before = buyer.calls + seller.calls;
      expect(await refusal(() => signSellerSessionDelegation(d as never, buyer, bb, A))).toBe(expected);
      expect(await refusal(() => signDiscoveryDocument({ ...discovery, profile } as never, seller, sb, B))).toBe(expected);
      expect(await refusal(() => signWireRequest({ signer: buyer, binding: bb, local: A, path: "/dacs/v1/commitments", jobId: JOB, text: BODY, seller: seller.claim, job: { ...job, profile: profile as never }, now: NOW }))).toBe("tp1_purchase_profile_mismatch");
      expect(buyer.calls + seller.calls).toBe(before);
    }
  });
});
