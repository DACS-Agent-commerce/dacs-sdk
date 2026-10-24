import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { assertEndpointProof } from "../../src/wire/discovery.js";
import { canonicalize } from "../../src/canonical/index.js";
import { readFixtureListingEligibility } from "./listingEligibilityFixture.js";
import { journalFixture } from "./requestJournalFixture.js";

const local = { endpoint: "https://unverified.example/", transportAuthority: "test", connectionId: "generation-1" };
const { testJournals } = journalFixture(wire);
const jobId = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const now = Date.UTC(2026, 9, 18);
const modules = wire.TESTNET_PROFILE_TP1.tuple;
function firstParticipant(d: wire.Tp1AuthorityDecision) {
  const p = d.participants[0];
  if (!p) throw new Error("fixture requires a participant");
  return p;
}
function party() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { claim: `did:demos:agent:${publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`, calls: 0,
    sign(bytes: Uint8Array) { this.calls++; return sign(null, bytes, privateKey); } };
}
async function world() {
  const buyer = party(), seller = party();
  const profile: wire.Tp1WireProfile = { id: wire.TP1_PROFILE_ID, revision: wire.TP1_PROFILE_REVISION, base: wire.TP1_BASE_REVISION,
    chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: wire.TP1_APPROVED_IDENTITY_RECORD.pinVersion };
  const connections = new Map([[local.endpoint, { local: { ...local }, chainIdentity: profile.chainIdentity,
    provenance: "independent-test-attestation/generation-1" }]]);
  const participants = new Map([buyer, seller].map(({ claim }) => [claim, { claim, profile, modules: { ...modules } }]));
  let change: (decision: wire.Tp1AuthorityDecision) => unknown = (decision) => decision;
  const readAuthority = (scope: wire.Tp1AuthorityScope) => {
    const connection = connections.get(scope.local.endpoint);
    if (!connection || (scope.sessionId !== null && scope.sessionId !== jobId && scope.sessionId !== "dacs-seller-discovery/v1")) return null;
    const selected = scope.participants.map((claim) => participants.get(claim));
    if (selected.some(p => p === undefined)) return null;
    return change({ ...connection, sessionId: scope.sessionId, participants: selected.filter((p): p is NonNullable<typeof p> => p !== undefined) });
  };
  const options = { record: wire.TP1_APPROVED_IDENTITY_RECORD, local, readAuthority };
  const binding = (await wire.bindTp1Profile(options));
  const request: wire.WireRequestPayload = { version: "1", kind: "request", method: "POST", path: "/dacs/v1/commitments",
    bodyHash: createHash("sha256").update("{}").digest("hex"), jobId, buyer: buyer.claim, seller: seller.claim,
    listingPin: { listingId: "authority", version: 1, contentHash: "c".repeat(64) }, agreementHash: "a".repeat(64),
    nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", expiresAt: now + 30_000, profile: binding.profile };
  const response = () => wire.signWireResponse(request, 200, "{}", { signer: seller, binding, local, now, purchaseProfile: binding.profile });
  return { buyer, seller, binding, request, options, response, setChange(fn: typeof change) { change = fn; },
    attestConnection(connection: typeof local) { connections.set(connection.endpoint, { local: { ...connection },
      chainIdentity: profile.chainIdentity, provenance: `independent-test-attestation/${connection.connectionId}` }); } };
}

async function boundaries(x: Awaited<ReturnType<typeof world>>) {
  const context = { binding: x.binding, local, purchaseProfile: x.binding.profile };
  const requestHeader = Buffer.from(canonicalize({ payload: x.request,
    signature: x.buyer.sign(wire.wireEnvelopeSigningBytes(x.request)).toString("base64url") })).toString("base64url");
  const opened = (await wire.openWireEnvelope(requestHeader, "request", context));
  const response = await x.response();
  const session = party();
  const delegationPayload: wire.SellerSessionDelegationPayload = { version: "1", kind: "seller-session-delegation",
    buyer: x.buyer.claim, seller: x.seller.claim, sessionPublicKey: session.claim.slice(-64),
    listingPin: x.request.listingPin, jobId, notBefore: now - 1000, expiresAt: now + 60_000, profile: x.binding.profile };
  const delegation = await wire.signSellerSessionDelegation(delegationPayload, x.buyer, x.binding, local);
  const publicEndpoint = "https://seller.authority.invalid";
  const discoveryPayload: wire.DiscoveryPayload = { format: "dacs-seller-discovery/v1", profile: x.binding.profile,
    seller: x.seller.claim, publicEndpoint, transport: ["dacs-seller-http/v1"], listings: [x.request.listingPin],
    capabilities: wire.TP1_CAPABILITIES, ready: true, issuedAt: now, expiresAt: now + 60_000 };
  const discovery = await wire.signDiscoveryDocument(discoveryPayload, x.seller, x.binding, local);
  const proofOptions = { ...context, listing: { seller: x.seller.claim, publicEndpoint, listingPin: x.request.listingPin }, now, readListingEligibility: readFixtureListingEligibility };
  const endpointProof = (await wire.verifyEndpointProof(discovery, proofOptions));
  const signing = { ...context, signer: x.buyer, endpointProof, publicEndpoint, now };
  const requestInput = { ...signing, seller: x.seller.claim, path: x.request.path, jobId, text: "{}",
    job: { listingPin: x.request.listingPin, agreementHash: x.request.agreementHash, profile: x.binding.profile } };
  const journals = testJournals();
  const calls: Array<[string, () => unknown]> = [
    ["request signer", () => wire.signWireRequest(requestInput)],
    ["envelope signer", () => wire.signWireEnvelope(x.request, signing)],
    ["response signer", x.response],
    ["delegation bytes", async () => (await wire.sellerSessionDelegationSigningBytes(delegationPayload, x.binding, local))],
    ["delegation signer", () => wire.signSellerSessionDelegation(delegationPayload, x.buyer, x.binding, local)],
    ["discovery signer", () => wire.signDiscoveryDocument(discoveryPayload, x.seller, x.binding, local)],
    ["request open", async () => (await wire.openWireEnvelope(requestHeader, "request", context))],
    ["retained request admission", async () => (await wire.checkWireRequest(opened, { ...context, seller: x.seller.claim,
      retained: { jobId: x.request.jobId, agreementHash: x.request.agreementHash, buyer: x.request.buyer, seller: x.request.seller }, listingPin: x.request.listingPin, method: "POST", path: x.request.path, rawBody: Buffer.from("{}"), now,
      ready: true, requestJournal: journals.open() }))],
    ["delegation verifier", async () => (await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), { ...context, seller: x.seller.claim, listingPin: x.request.listingPin, jobId, time: now }))],
    ["response verifier", async () => (await wire.verifyWireResponse(x.request, { ...context, header: response, status: 200, body: Buffer.from("{}"), now }))],
    ["discovery verifier", async () => (await wire.verifyEndpointProof(discovery, proofOptions))],
    ["retained endpoint proof", async () => (await assertEndpointProof(endpointProof, { binding: x.binding,
      seller: x.seller.claim, listingPin: x.request.listingPin, publicEndpoint, now, request: x.request }))],
  ];
  x.buyer.calls = x.seller.calls = 0;
  return { calls, reservations: () => journals.reservations().length, discoveryPayload, signing, requestInput, delegationPayload };
}

async function rejectsEveryBoundary(x: Awaited<ReturnType<typeof world>>, entries: Awaited<ReturnType<typeof boundaries>>, code: string) {
  for (const [name, invoke] of entries.calls) {
    await expect(Promise.resolve().then(invoke), name).rejects.toMatchObject({ code });
  }
  expect(x.buyer.calls + x.seller.calls + entries.reservations()).toBe(0);
}

describe("independent TP-1 authorization context", () => {
  it("does not turn an approved record and an unverified endpoint into authority", async () => {
    await expect(Promise.resolve().then(async () => (await wire.bindTp1Profile({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local } as unknown as wire.BindTp1Options)))).rejects.toThrowError(expect.objectContaining({ code: "tp1_authority_required" }));
  });
  it("refuses a connection attested on another chain at binding", async () => {
    const x = (await world());
    x.setChange((d) => ({ ...d, chainIdentity: "b".repeat(64) }));
    await expect(Promise.resolve().then(async () => (await wire.bindTp1Profile(x.options)))).rejects.toThrowError(expect.objectContaining({ code: "tp1_connection_unverified" }));
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it("refuses an endpoint or connection generation absent from the independent authority", async () => {
    const x = (await world());
    for (const connection of [{ ...local, endpoint: "https://absent.authority.invalid/" }, { ...local, connectionId: "unattested-generation" }]) {
      await expect(Promise.resolve().then(async () => (await wire.bindTp1Profile({ ...x.options, local: connection })))).rejects.toThrowError(expect.objectContaining({ code: "tp1_connection_unverified" }));
    }
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it.each(Object.keys(modules).flatMap((module) => (["buyer", "seller"] as const).map((role) => [module, role] as const)))(
    "refuses authenticated %s mismatch for the %s before signing", async (module, role) => {
    const x = (await world());
    const entries = await boundaries(x);
    x.setChange((d) => ({ ...d, participants: d.participants.map((p) => p.claim === x[role].claim ?
      { ...p, modules: { ...p.modules, [module]: "0.0" } } : p) }));
    const relevant = role === "buyer" ? { ...entries, calls: entries.calls.filter(([name]) =>
      !name.startsWith("discovery") && name !== "retained endpoint proof") } : entries;
    await rejectsEveryBoundary(x, relevant, "tp1_participant_profile_mismatch");
  });
  it.each([
    ["wrong chain", (d: wire.Tp1AuthorityDecision) => ({ ...d, chainIdentity: "b".repeat(64) })],
    ["changed endpoint", (d: wire.Tp1AuthorityDecision) => ({ ...d, local: { ...d.local, endpoint: "https://other.authority.invalid/" } })],
    ["changed transport", (d: wire.Tp1AuthorityDecision) => ({ ...d, local: { ...d.local, transportAuthority: "other" } })],
    ["new connection generation", (d: wire.Tp1AuthorityDecision) => ({ ...d, local: { ...d.local, connectionId: "generation-2" } })],
    ["replaced attestation", (d: wire.Tp1AuthorityDecision) => ({ ...d, provenance: "other-attestation" })],
    ["revoked evidence", () => null],
  ])("rechecks %s at every boundary, including retained proofs and envelopes", async (_name, change) => {
    const x = (await world()), entries = await boundaries(x);
    x.setChange(change);
    await rejectsEveryBoundary(x, entries, "tp1_connection_unverified");
    await expect(Promise.resolve().then(async () => (await wire.assertPeerProfile(x.binding.profile, x.binding)))).rejects.toThrow();
    await expect(Promise.resolve().then(async () => (await wire.assertPurchaseProfile(x.binding.profile, x.binding)))).rejects.toThrow();
  });
  it.each([
    ["wrong session", (d: wire.Tp1AuthorityDecision) => ({ ...d, sessionId: "another-job" })],
    ["missing participant", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: [] })],
    ["duplicate participant", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: d.participants.map(() => firstParticipant(d)) })],
    // Appended entries keep every expected participant: only the count refuses them.
    ["extra participant", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: [...d.participants, firstParticipant(d)] })],
    ["extra conflicting participant", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: [...d.participants, { ...firstParticipant(d), profile: { ...firstParticipant(d).profile, base: "b".repeat(40) } }] })],
    ["wrong identity", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: d.participants.map((p) => ({ ...p, claim: "did:demos:agent:" + "b".repeat(64) })) })],
    ["wrong specification pin", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: d.participants.map((p) => ({ ...p, profile: { ...p.profile, base: "b".repeat(40) } })) })],
    ["missing module", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: d.participants.map((p) => { const { CORE, ...modules } = p.modules; return { ...p, modules }; }) })],
    ["extra module", (d: wire.Tp1AuthorityDecision) => ({ ...d, participants: d.participants.map((p) => ({ ...p, modules: { ...p.modules, other: "0.3" } })) })],
  ])("refuses %s from the authenticated participant source", async (name, change) => {
    const x = (await world());
    // Leave connection-only reads intact; inject faulty participant evidence.
    x.setChange((d) => d.participants.length ? change(d) : d);
    await expect(x.response(), name).rejects.toMatchObject({ code: "tp1_participant_profile_mismatch" });
    expect(x.seller.calls).toBe(0);
  });
  it.each(["timeout", "not found", "refused"])("preserves the authority reader's %s cause", async (message) => {
    const x = (await world()), entries = await boundaries(x), cause = new Error(message);
    x.setChange(() => { throw cause; });
    for (const [name, invoke] of entries.calls) await expect(Promise.resolve().then(invoke), name).rejects.toBe(cause);
    expect(x.buyer.calls + x.seller.calls + entries.reservations()).toBe(0);
  });
  it("rechecks discovery-specific authority when reusing an endpoint proof", async () => {
    const x = (await world()), entries = await boundaries(x);
    x.setChange((d) => d.sessionId === "dacs-seller-discovery/v1" ? { ...d, participants: [] } : d);
    for (const [name, invoke] of entries.calls.filter(([name]) =>
      ["request signer", "envelope signer", "discovery signer", "discovery verifier", "retained endpoint proof"].includes(name))) {
      await expect(Promise.resolve().then(invoke), name).rejects.toMatchObject({ code: "tp1_participant_profile_mismatch" });
    }
    expect(x.buyer.calls + x.seller.calls + entries.reservations()).toBe(0);
  });
  it("accepts independently attested endpoints for the same chain", async () => {
    const x = (await world());
    const other = { ...local, endpoint: "https://second.authority.invalid/", connectionId: "other-generation" };
    x.attestConnection(other);
    const binding = (await wire.bindTp1Profile({ ...x.options, local: other }));
    expect(binding.profile).toEqual(x.binding.profile);
    expect(binding.authorityDigest).not.toBe(x.binding.authorityDigest);
    await expect(wire.assertTp1Binding(binding, other)).resolves.toBeUndefined();
  });
  // The actor's own connection, before any authority read or signature: an https-only endpoint with no
  // credentials, query or fragment, given exactly as its normalized href, and identifier-shaped transport and connection.
  it.each([
    ["an http endpoint", { endpoint: "http://unverified.example/" }],
    ["user and password", { endpoint: "https://u:p@unverified.example/" }],
    ["a user only", { endpoint: "https://u@unverified.example/" }],
    ["a password only", { endpoint: "https://:p@unverified.example/" }],
    ["a query", { endpoint: "https://unverified.example/?q" }],
    ["a fragment", { endpoint: "https://unverified.example/#f" }],
    ["a non-normalized href", { endpoint: "https://UNVERIFIED.example" }],
    ["an endpoint that is not a URL", { endpoint: "unverified.example" }],
    ["an endpoint that is not a string", { endpoint: 443 }],
    ["an empty transport authority", { transportAuthority: "" }],
    ["a transport authority that is not an identifier", { transportAuthority: " test" }],
    ["an empty connection id", { connectionId: "" }],
    ["a connection id that is not an identifier", { connectionId: " x" }],
    ["an extra member", { region: "eu" }],
  ])("refuses an own connection with %s before reading authority or signing", async (_name, change) => {
    const x = (await world()), entries = await boundaries(x);
    const invalid = { ...local, ...change };
    let reads = 0;
    const readAuthority = (scope: wire.Tp1AuthorityScope) => { reads++; return x.options.readAuthority(scope); };
    await expect(Promise.resolve().then(async () => (await wire.bindTp1Profile({ ...x.options, local: invalid, readAuthority })))).rejects.toThrowError(expect.objectContaining({ code: "tp1_local_binding_invalid" }));
    expect(reads).toBe(0);
    await expect(Promise.resolve().then(async () => (await wire.assertTp1Binding(x.binding, invalid)))).rejects.toThrowError(expect.objectContaining({ code: "tp1_local_binding_invalid" }));
    await expect(Promise.resolve().then(() => wire.signSellerSessionDelegation(entries.delegationPayload, x.buyer, x.binding, invalid))).rejects.toMatchObject({ code: "tp1_local_binding_invalid" });
    await expect(Promise.resolve().then(() => wire.signWireEnvelope(x.request, { ...entries.signing, local: invalid }))).rejects.toMatchObject({ code: "tp1_local_binding_invalid" });
    expect(x.buyer.calls + x.seller.calls).toBe(0);
  });
  it.each((["request", "response", "delegation", "discovery"] as const).flatMap(kind =>
    (["connection", "participant"] as const).map(revocation => ({ kind, revocation }))))(
    "does not return a $kind after $revocation authority is revoked while awaiting its signature", async ({ kind, revocation }) => {
      const x = (await world()), entries = await boundaries(x);
      const signer = kind === "request" || kind === "delegation" ? x.buyer : x.seller;
      const sign = signer.sign.bind(signer);
      signer.sign = (bytes) => {
        const signature = sign(bytes);
        queueMicrotask(() => x.setChange(d => revocation === "connection" ? null :
          d.sessionId === null ? d : { ...d, participants: [] }));
        return signature;
      };
      const entry = entries.calls.find(([name]) => name === `${kind} signer`);
      if (!entry) throw new Error(`missing fixture signer: ${kind}`);
      await expect(Promise.resolve().then(entry[1])).rejects.toMatchObject({
        code: revocation === "connection" ? "tp1_connection_unverified" : "tp1_participant_profile_mismatch" });
      expect(x.buyer.calls + x.seller.calls).toBe(1);
    });
});

describe("the trusted reader is asked about participants only after a signature authenticates them", () => {
  // A reader that throws for every participant/session read, as a reader for an unknown session may.
  async function guarded() {
    const x = (await world()), participantReads: wire.Tp1AuthorityScope[] = [];
    let allow = false;
    const readAuthority = (scope: wire.Tp1AuthorityScope) => {
      if (scope.sessionId !== null) {
        participantReads.push(scope);
        if (!allow) throw new Error(`reader: no session ${scope.sessionId}`);
      }
      return x.options.readAuthority(scope);
    };
    const binding = (await wire.bindTp1Profile({ ...x.options, readAuthority }));
    const context = { binding, local, purchaseProfile: binding.profile };
    return { x, binding, context, participantReads, allow() { allow = true; } };
  }
  const forged = "A".repeat(86);
  const header = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");

  it("a request header with a bad signature and made-up participants makes zero participant reads", async () => {
    const g = (await guarded()), stranger = party(), other = party();
    const payload = { ...g.x.request, buyer: stranger.claim, seller: other.claim };
    await expect(Promise.resolve().then(async () => (await wire.openWireEnvelope(header({ payload, signature: forged }), "request", g.context)))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_signature_invalid" }));
    expect(g.participantReads).toEqual([]);
    // Control: the genuine request is checked against the reader once its signature verifies.
    g.allow();
    const genuine = header({ payload: g.x.request, signature: g.x.buyer.sign(wire.wireEnvelopeSigningBytes(g.x.request)).toString("base64url") });
    expect((await wire.openWireEnvelope(genuine, "request", g.context)).payload.jobId).toBe(jobId);
    expect(g.participantReads.map((s) => [s.sessionId, s.participants])).toEqual([[jobId, [g.x.buyer.claim, g.x.seller.claim]]]);
  });

  it("a delegation with a bad wallet signature makes zero participant reads, alone and inside a request header", async () => {
    const g = (await guarded()), session = party();
    const delegation = { payload: { version: "1", kind: "seller-session-delegation", buyer: g.x.buyer.claim, seller: g.x.seller.claim,
      sessionPublicKey: session.claim.slice(-64), listingPin: g.x.request.listingPin, jobId, notBefore: now - 1000, expiresAt: now + 60_000,
      profile: g.binding.profile }, signature: forged };
    await expect(Promise.resolve().then(async () => (await wire.verifySellerSessionDelegation(Buffer.from(JSON.stringify(delegation)), { binding: g.binding, local, seller: g.x.seller.claim, listingPin: g.x.request.listingPin, jobId, time: now })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_delegation_signature_invalid" }));
    const signed = { payload: g.x.request, signature: session.sign(wire.wireEnvelopeSigningBytes(g.x.request)).toString("base64url"), delegation };
    await expect(Promise.resolve().then(async () => (await wire.openWireEnvelope(header(signed), "request", { ...g.context, requireDelegation: true })))).rejects
      .toThrowError(expect.objectContaining({ code: "peer_delegation_signature_invalid" }));
    expect(g.participantReads).toEqual([]);
  });

  it("a discovery document with a bad signature makes zero participant and eligibility reads", async () => {
    const g = (await guarded());
    const publicEndpoint = "https://seller.authority.invalid";
    const payload = { format: "dacs-seller-discovery/v1", profile: g.binding.profile, seller: g.x.seller.claim, publicEndpoint,
      transport: ["dacs-seller-http/v1"], listings: [g.x.request.listingPin], capabilities: wire.TP1_CAPABILITIES, ready: true, issuedAt: now, expiresAt: now + 60_000 };
    let eligibilityReads = 0;
    await expect(Promise.resolve().then(async () => (await wire.verifyEndpointProof(Buffer.from(canonicalize({ payload, signature: forged })), { ...g.context, now,
      listing: { seller: g.x.seller.claim, publicEndpoint, listingPin: g.x.request.listingPin },
      readListingEligibility: (scope) => { eligibilityReads++; return readFixtureListingEligibility(scope); } })))).rejects
      .toThrowError(expect.objectContaining({ code: "discovery_signature_invalid" }));
    expect([g.participantReads.length, eligibilityReads]).toEqual([0, 0]);
  });
});
