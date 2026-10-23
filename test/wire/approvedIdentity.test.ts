import { expect, it } from "vitest";
import { TP1_APPROVED_IDENTITY_RECORD, TP1_APPROVED_IDENTITY_RECORD_DIGESTS, signSellerSessionDelegation, verifySellerSessionDelegation, signDiscoveryDocument, verifyEndpointProof, TP1_CAPABILITIES } from "../../src/wire/index.js";
import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalize } from "../../src/canonical/index.js";
const bindTp1Fixture = fixtureBinder(fixtureWire);
const RECORD = TP1_APPROVED_IDENTITY_RECORD;
const DIGEST = "5c234f784b8fbbb77a53886594dbdf3689fbbc336f04c2c930edfd57f225e330";
const NOW = Date.UTC(2026, 9, 15, 17);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const PIN = { listingId: "approved-identity", version: 1, contentHash: "d".repeat(64) };
const A = { endpoint: "https://rpc-a.identity.invalid/", transportAuthority: "test-a", connectionId: "a-1" };
const B = { endpoint: "https://rpc-b.identity.invalid/", transportAuthority: "test-b", connectionId: "b-1" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function party() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { key, claim: `did:demos:agent:${key}`, calls: 0, sign(bytes: Uint8Array) {
    this.calls += 1;
    return new Uint8Array(sign(null, Buffer.from(bytes), privateKey));
  } };
}
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
