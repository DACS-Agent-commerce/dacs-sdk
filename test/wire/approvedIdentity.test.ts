import { expect, expectTypeOf, it, vi } from "vitest";
import { TP1_APPROVED_IDENTITY_RECORD, TP1_APPROVED_IDENTITY_RECORD_DIGESTS, signSellerSessionDelegation, verifySellerSessionDelegation } from "../../src/wire/index.js";
import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
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
  it("signs and verifies delegation under the approved identity", async () => {
    const buyer = party(), seller = party(), session = party();
    const bb = await bindTp1Fixture({ record: RECORD, local: A });
    const sb = await bindTp1Fixture({ record: RECORD, local: B });
    const delegation = await signSellerSessionDelegation({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, sessionPublicKey: session.key, seller: seller.claim, listingPin: PIN, jobId: JOB, notBefore: NOW, expiresAt: NOW + 60_000, profile: bb.profile }, buyer, bb, A);
    await verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), { buyer: buyer.claim, seller: seller.claim, listingPin: PIN, jobId: JOB, time: NOW, binding: sb, local: B });
    expect(buyer.calls + seller.calls).toBe(1);
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
