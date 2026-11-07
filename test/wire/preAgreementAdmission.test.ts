// P03b: the real wire entries and durable context journal, before any Agreement exists.
import { readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { journalDirectory } from "./requestJournalFixture.js";
import { JOB, LOCAL, NOW, P, PIN, header, nonce, party, world, type World } from "./reservationFixture.js";

type Route = "context" | "contextChallenge";
const ROUTES: Route[] = ["contextChallenge", "context"];
const MODES = [{ direct: true }, { direct: true, requireDelegation: false }, { direct: false }, { direct: false, requireDelegation: true }];
const OUTCOME = { status: 200, text: '{ "context": "signed", "exact": true }\n' };
const refusal = (code: string, status = 409) => ({ code, status });
const authorityDecision = (scope: wire.Tp1AuthorityScope, participantProfile: () => wire.Tp1WireProfile, chainIdentity = wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity) => ({
  local: scope.local, chainIdentity, provenance: "test-only-independent-authority/v1", sessionId: scope.sessionId,
  participants: scope.participants.map(claim => ({ claim, profile: participantProfile(), modules: wire.TESTNET_PROFILE_TP1.tuple })),
});
const signed = (payload: unknown, signer: ReturnType<typeof party>, domain: string) => ({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString("base64url") });
interface Input {
  direct?: boolean;
  requireDelegation?: boolean;
  raw?: string;
  request?: Partial<wire.WireRequestPayload>;
  delegation?: Partial<wire.SellerSessionDelegationPayload>;
  session?: ReturnType<typeof party>;
  delegationSigner?: ReturnType<typeof party>;
}
function journal(options?: wire.WireRequestJournalOptions) {
  const directory = journalDirectory();
  const reopen = () => wire.openWireRequestJournal(directory, options);
  return { directory, handle: reopen(), reopen, files: () => readdirSync(directory).sort() };
}
/** Build signed bytes independently, then authenticate them through the public opener. */
async function exchange(x: World, route: Route, input: Input = {}) {
  const raw = input.raw ?? '{"scope":{"jobId":"' + JOB + '"}}';
  const request = { ...x.request(P[route], nonce(), raw), ...input.request };
  const session = input.session ?? party(3);
  const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: x.buyer.claim, seller: x.seller.claim,
    sessionPublicKey: session.key, listingPin: PIN, jobId: JOB, notBefore: NOW - 30_000, expiresAt: NOW + 60_000,
    profile: x.binding.profile, ...input.delegation }, input.delegationSigner ?? x.buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
  const encoded = header({ ...signed(request, input.direct ? x.buyer : session, wire.DACS_SELLER_HTTP_DOMAINS.request), ...(input.direct ? {} : { delegation }) });
  const check: wire.PreAgreementCheck = { ...x.context, seller: x.seller.claim, listingPin: PIN, route, method: "POST", path: P[route],
    rawBody: Buffer.from(raw), now: NOW, retained: { ...x.retained, ...(route === "context" ? { accepted: false } : {}) }, ready: true,
    ...(input.requireDelegation === undefined ? {} : { requireDelegation: input.requireDelegation }) };
  return { encoded, check, open: () => wire.openWireEnvelope(encoded, "request", x.context) };
}
/** Unsafe host values enter only at this test boundary. */
const checkWith = (e: Awaited<ReturnType<typeof exchange>>, overrides: Record<string, unknown>) => ({ ...e.check, ...overrides }) as wire.PreAgreementCheck;
async function admit(e: Awaited<ReturnType<typeof exchange>>, j: ReturnType<typeof journal>, overrides: Record<string, unknown> = {}) {
  return wire.admitPreAgreementRequest(await e.open(), checkWith(e, { requestJournal: j.handle, ...overrides }));
}
async function reserve(admitted: wire.AdmittedPreAgreementRequest) {
  if (!admitted.reserve) throw new Error("context reserve missing");
  return admitted.reserve();
}
beforeEach(() => { vi.spyOn(performance, "now").mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

describe("pre-Agreement admission", { timeout: 60_000 }, () => {
  it("A38 K2-T1 a delegated context request without an Agreement is admitted and touches the journal only at reserve()", async () => {
    const x = await world(), j = journal(), e = await exchange(x, "context");
    const a = await admit(e, j);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.body)).toBe(true);
    expect(a).toMatchObject({ route: "context", body: JSON.parse(Buffer.from(e.check.rawBody).toString()), delegationExpiresAt: NOW + 60_000 });
    expect(j.files()).toEqual([]);
    expect(await reserve(a)).toMatchObject({ state: "new", attempt: 0 });
    expect(j.files()).toHaveLength(2);
  });
  it("A38 K2-T9 a delegated challenge request is admitted with no reserve member", async () => {
    const a = await admit(await exchange(await world(), "contextChallenge"), journal());
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).not.toHaveProperty("reserve");
    expect(a.delegationExpiresAt).toBe(NOW + 60_000);
  });
  it("A39 K2-T2/T19/T20 ready:false refuses the challenge always and the context unless retained.accepted is true, direct and delegated", async () => {
    const x = await world();
    for (const mode of MODES) for (const route of ROUTES) {
      const j = journal(), e = await exchange(x, route, mode);
      await expect(admit(e, j, { ready: false })).rejects.toMatchObject(refusal("seller_not_ready", 503));
      if (route === "context") expect((await admit(e, j, { ready: false, retained: { ...x.retained, accepted: true } })).reserve).toBeTypeOf("function");
      for (const ready of [undefined, "yes", null]) await expect(admit(e, j, { ready })).rejects.toMatchObject(refusal("seller_readiness_required", 500));
      expect(j.files()).toEqual([]);
    }
  });
  it("A39 K2-T17 context under ready:false with retained.accepted:true and a live delegation is admitted; reserve() answers from the journal", async () => {
    const x = await world(), j = journal();
    const a = await admit(await exchange(x, "context"), j, { ready: false, retained: { ...x.retained, accepted: true } });
    expect(await reserve(a)).toMatchObject({ state: "new", attempt: 0 });
  });
  it("A39/A19 K2-T18 an expired delegation is refused on both routes, with no readback and no file", async () => {
    const x = await world();
    for (const route of ROUTES) {
      const j = journal(), e = await exchange(x, route, { delegation: { expiresAt: NOW - 1 } });
      await expect(admit(e, j, { ready: false, retained: { ...x.retained, ...(route === "context" ? { accepted: true } : {}) } })).rejects.toMatchObject(refusal("peer_delegation_expired", 408));
      expect(j.files()).toEqual([]);
    }
  });
  it("A19 K2-T3/T4/T15/T16 request expiry is checked before delegation expiry, and a request that outlives its delegation is refused", async () => {
    const x = await world();
    for (const route of ROUTES) for (const input of [
      { now: NOW + 30_000, expiry: NOW + 30_000, code: "peer_expired" },
      { now: NOW, expiry: NOW + 10_000, code: "peer_delegation_expired" },
      { now: NOW + 15_000, expiry: NOW + 10_000, code: "peer_delegation_expired" },
    ]) {
      const j = journal(), e = await exchange(x, route, { delegation: { expiresAt: input.expiry } });
      await expect(admit(e, j, { now: input.now })).rejects.toMatchObject(refusal(input.code, 408));
      expect(j.files()).toEqual([]);
    }
  });
  it("A19 K2-T5 a delegation for another job, buyer, seller or Listing is peer_delegation_mismatch", async () => {
    const x = await world();
    for (const route of ROUTES) for (const delegation of [{ jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4J" }, { buyer: party(4).claim }, { seller: party(4).claim }, { listingPin: { ...PIN, version: 2 } }]) {
      // The same real verifier also rejects scope mismatches at opening, before an opened capability can exist.
      const j = journal(), e = await exchange(x, route, { delegation, ...(delegation.buyer ? { delegationSigner: party(4) } : {}) });
      await expect(admit(e, j)).rejects.toMatchObject(refusal("peer_delegation_mismatch"));
      expect(j.files()).toEqual([]);
    }
  });
  it("A38 K2-T6 the context route refuses the challenge scope hash as its retained hash", async () => {
    const x = await world(), j = journal(), e = await exchange(x, "context");
    await expect(admit(e, j, { retained: { ...x.retained, agreementHash: sha256Hex("challenge-scope"), accepted: false } })).rejects.toMatchObject(refusal("peer_agreement_mismatch"));
    expect(j.files()).toEqual([]);
  });
  it("K2-T7 a route that is not the request's path, or not pre-Agreement, is wire_input_invalid", async () => {
    const x = await world(), j = journal();
    for (const route of ROUTES) {
      const e = await exchange(x, route);
      for (const declared of ["state", "unknown", route === "context" ? "contextChallenge" : "context"]) await expect(admit(e, j, { route: declared })).rejects.toMatchObject(refusal("wire_input_invalid", 500));
    }
    const e = await exchange(x, "context", { request: { path: P.proposals } });
    await expect(admit(e, j, { path: P.proposals })).rejects.toMatchObject(refusal("wire_input_invalid", 500));
    expect(j.files()).toEqual([]);
  });
  it("K2-T8 checkWireRequest refuses both pre-Agreement routes with wire_route_requires_preagreement", async () => {
    const x = await world(), j = journal();
    for (const route of ROUTES) {
      const e = await exchange(x, route);
      await expect(wire.checkWireRequest(await e.open(), { ...e.check, requestJournal: j.handle })).rejects.toMatchObject(refusal("wire_route_requires_preagreement", 500));
      expect(wire.isPreAgreementRoute(P[route])).toBe(true);
    }
    expect(wire.isPreAgreementRoute(P.proposals)).toBe(false);
    expect(j.files()).toEqual([]);
  });
  it("A38 K2-T11 a delegated proposal without artifacts still needs its Agreement (peer_delegation_agreement_required)", async () => {
    const x = await world(), e = await exchange(x, "context", { request: { path: P.proposals } }), j = journal();
    await expect(wire.checkWireRequest(await e.open(), { ...e.check, path: P.proposals, retained: { ...x.retained, allocated: false }, requestJournal: j.handle })).rejects.toMatchObject(refusal("peer_delegation_agreement_required"));
    expect(j.files()).toEqual([]);
  });
  it("K2-T12 requireDelegation refuses a direct request on both routes", async () => {
    const x = await world();
    for (const route of ROUTES) {
      const j = journal();
      await expect(admit(await exchange(x, route, { direct: true, requireDelegation: true }), j)).rejects.toMatchObject(refusal("peer_delegation_required", 401));
      expect(j.files()).toEqual([]);
    }
  });
  it("K2-T13 reserve() after both expiries is peer_expired with no file", async () => {
    const x = await world(), j = journal();
    const a = await admit(await exchange(x, "context", { delegation: { expiresAt: NOW + 30_000 } }), j);
    vi.mocked(performance.now).mockReturnValue(30_000);
    await expect(reserve(a)).rejects.toMatchObject(refusal("peer_expired", 408));
    expect(j.files()).toEqual([]);
  });
  it("K2-T14 a header of 4,097 characters is refused at opening", async () => {
    const x = await world();
    await expect(wire.openWireEnvelope("A".repeat(4097), "request", x.context)).rejects.toMatchObject(refusal("peer_envelope_invalid", 401));
  });
  it("K2-T21 retained.accepted absent or \"yes\" on context, or present on the challenge route, is seller_retained_agreement_required", async () => {
    const x = await world(), j = journal();
    for (const route of ROUTES) for (const accepted of [undefined, "yes", true]) {
      if (route === "context" && accepted === true) continue;
      const retained = { ...x.retained, ...(accepted === undefined ? {} : { accepted }) };
      if (route === "context" || accepted !== undefined) await expect(admit(await exchange(x, route), j, { retained })).rejects.toMatchObject(refusal("seller_retained_agreement_required", 500));
    }
    expect(j.files()).toEqual([]);
  });
  it("K2-T22 a settled admission flagged accepted is admitted under ready:false; admission writes no file and the completed outcome comes from inspection", async () => {
    const x = await world(), j = journal(), e = await exchange(x, "context");
    wire.completeWireEffect(j.handle, await reserve(await admit(e, j)), OUTCOME);
    const files = j.files();
    await admit(await exchange(x, "context"), j, { ready: false, retained: { ...x.retained, accepted: true } });
    expect(wire.inspectWireOperation(j.handle, (await e.open()).payload)).toEqual({ state: "completed", binding: wire.wireOperationBinding((await e.open()).payload), outcome: OUTCOME });
    expect(j.files()).toEqual(files);
  });
  it("K2 order: each refusal is the first failing step's code, and no refusal before step 15 writes anything", async () => {
    let withdrawn = false;
    const sentinel = new Error("prefix authority refused");
    const x = await world({ readAuthority: scope => {
      if (withdrawn && scope.participants.length > 0) throw sentinel;
      return authorityDecision(scope, () => x.binding.profile);
    } });
    const j = journal(), e = await exchange(x, "context"), opened = await e.open();
    const cases: [Record<string, unknown>, string, number][] = [
      [{ binding: null, seller: "wrong" }, "tp1_binding_required", 500],
      [{ local: { ...LOCAL, connectionId: "changed" }, now: NOW + 60_000 }, "tp1_local_binding_changed", 500],
      [{ purchaseProfile: undefined, maxLifetimeMs: 0 }, "tp1_purchase_profile_mismatch", 500],
      [{ maxLifetimeMs: 0, route: "unknown" }, "seller_configuration_invalid", 500],
      [{ route: "unknown", seller: "wrong" }, "wire_input_invalid", 500],
      [{ seller: "wrong", now: NOW + 60_000 }, "peer_audience_wrong", 401],
      [{ now: NOW + 60_000, rawBody: Buffer.from("{") }, "peer_expired", 408],
      [{ rawBody: Buffer.from("{"), listingPin: { ...PIN, version: 2 } }, "bad_json", 400],
      [{ method: "GET", listingPin: { ...PIN, version: 2 } }, "peer_request_mismatch", 401],
      [{ listingPin: { ...PIN, version: 2 }, retained: null }, "peer_listing_mismatch", 409],
      [{ retained: { ...x.retained, accepted: false, jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4J" }, ready: false }, "peer_job_mismatch", 409],
      [{ retained: { ...x.retained, accepted: false, buyer: party(4).claim }, ready: false }, "peer_agreement_party_mismatch", 409],
      [{ requestJournal: undefined, ready: false }, "seller_replay_guard_required", 500],
      [{ ready: "yes", retained: { ...x.retained, accepted: "yes" } }, "seller_readiness_required", 500],
      [{ ready: false }, "seller_not_ready", 503],
    ];
    for (const [overrides, code, status] of cases) {
      await expect(wire.admitPreAgreementRequest(opened, checkWith(e, { requestJournal: j.handle, ...overrides })), code).rejects.toMatchObject(refusal(code, status));
      expect(j.files(), code).toEqual([]);
    }
    await expect(wire.admitPreAgreementRequest({} as wire.OpenedEnvelope<wire.WireRequestPayload>, checkWith(e, { purchaseProfile: undefined }))).rejects.toMatchObject(refusal("peer_request_unverified", 500));
    withdrawn = true;
    await expect(wire.admitPreAgreementRequest(opened, checkWith(e, { maxLifetimeMs: 0 }))).rejects.toBe(sentinel);
    withdrawn = false;
    const direct = await exchange(x, "context", { direct: true, requireDelegation: true });
    await expect(admit(direct, j, { requestJournal: undefined, ready: false })).rejects.toMatchObject(refusal("peer_delegation_required", 401));
    const expired = await exchange(x, "context", { delegation: { expiresAt: NOW - 1 } });
    await expect(admit(expired, j, { requestJournal: undefined, ready: false })).rejects.toMatchObject(refusal("peer_delegation_expired", 408));
    expect(j.files()).toEqual([]);
  });
  it("K2 body admission: a body over 64 KiB or failing CF-5 is refused before the hash compare on both routes", async () => {
    const x = await world();
    for (const route of ROUTES) for (const raw of [" ".repeat(65537), '{"a":1,"a":2}', "{", '{"n":9007199254740993}']) {
      const j = journal(), e = await exchange(x, route);
      await expect(admit(e, j, { rawBody: Buffer.from(raw) })).rejects.toMatchObject(refusal("bad_json", 400));
      expect(j.files()).toEqual([]);
    }
  });
  it("K2 a request body member named accepted or ready changes nothing", async () => {
    const x = await world();
    for (const route of ROUTES) {
      const j = journal(), e = await exchange(x, route, { raw: '{"accepted":true,"ready":true}' });
      await expect(admit(e, j, { ready: false })).rejects.toMatchObject(refusal("seller_not_ready", 503));
      expect(j.files()).toEqual([]);
    }
  });
  it("K2 a second reserve() of the same context request is peer_request_replayed; a fresh nonce is pending, then recover after the lease", async () => {
    const x = await world(), clock = { now: NOW }, j = journal({ clock: () => clock.now, leaseMs: 1000 }), e = await exchange(x, "context");
    const a = await admit(e, j);
    expect(await reserve(a)).toMatchObject({ state: "new", attempt: 0 });
    await expect(reserve(a)).rejects.toMatchObject(refusal("peer_request_replayed"));
    await expect(reserve(await admit(await exchange(x, "context"), j))).rejects.toMatchObject(refusal("seller_effect_pending", 503));
    clock.now += 1000;
    const competitors = await Promise.all([exchange(x, "context"), exchange(x, "context")].map(async e => admit(await e, j)));
    const answers = await Promise.allSettled(competitors.map(reserve));
    expect(answers.filter(a => a.status === "fulfilled")).toHaveLength(1);
    expect(answers).toContainEqual({ status: "fulfilled", value: expect.objectContaining({ state: "recover", attempt: 1 }) });
    expect(answers).toContainEqual({ status: "rejected", reason: expect.objectContaining(refusal("seller_effect_pending", 503)) });
  });
  it("K2 an envelope opened under another binding is peer_request_unverified", async () => {
    const x = await world(), other = await world(), j = journal(), e = await exchange(x, "context");
    await expect(admit(e, j, { binding: other.binding })).rejects.toMatchObject(refusal("peer_request_unverified", 500));
    expect(j.files()).toEqual([]);
  });
  it("K2 a missing or foreign journal on the context route is seller_replay_guard_required before readiness, direct and delegated; the challenge route ignores it", async () => {
    const x = await world();
    for (const mode of MODES) for (const route of ROUTES) for (const requestJournal of [undefined, {}]) for (const ready of [true, false]) {
      const j = journal(), e = await exchange(x, route, mode);
      if (route === "context") await expect(admit(e, j, { requestJournal, ready })).rejects.toMatchObject(refusal("seller_replay_guard_required", 500));
      else if (!ready) await expect(admit(e, j, { requestJournal, ready })).rejects.toMatchObject(refusal("seller_not_ready", 503));
      else expect(await admit(e, j, { requestJournal, ready })).not.toHaveProperty("reserve");
      expect(j.files()).toEqual([]);
    }
  });
  it("K2 direct challenge and context admission preserves the optional-delegation contract", async () => {
    const x = await world();
    for (const route of ROUTES) for (const mode of MODES.filter(m => m.direct)) {
      const j = journal(), e = await exchange(x, route, mode), a = await admit(e, j);
      expect(a.delegationExpiresAt).toBeNull();
      expect(j.files()).toEqual([]);
      if (route === "context") expect(await reserve(a)).toMatchObject({ state: "new", attempt: 0 });
      else expect(a).not.toHaveProperty("reserve");
    }
  });
  it("K2 preserves an authority failure arising inside delegation verification", async () => {
    let reads = 0, failAt = Infinity, changed = false;
    const sentinel = new Error("authority reader timed out");
    const x = await world({ readAuthority: scope => {
      reads++;
      if (reads >= failAt && !changed) throw sentinel;
      return authorityDecision(scope, () => x.binding.profile, reads >= failAt ? sha256Hex("changed-chain") : wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity);
    } });
    for (const route of ROUTES) for (changed of [false, true]) {
      failAt = Infinity;
      const j = journal(), e = await exchange(x, route), opened = await e.open();
      // Prefix: binding, kept-profile binding, participant authority. The fourth read is inside the delegation verifier.
      failAt = reads + 4;
      const result = wire.admitPreAgreementRequest(opened, { ...e.check, requestJournal: j.handle });
      if (changed) await expect(result).rejects.toMatchObject(refusal("tp1_connection_unverified", 500));
      else await expect(result).rejects.toBe(sentinel);
      expect(j.files()).toEqual([]);
    }
    failAt = Infinity;
    changed = false;
    for (const route of ROUTES) {
      const j = journal();
      await expect(admit(await exchange(x, route, { delegation: { jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4J" } }), j)).rejects.toMatchObject(refusal("peer_delegation_mismatch"));
      await expect(admit(await exchange(x, route, { delegation: { expiresAt: NOW - 1 } }), j)).rejects.toMatchObject(refusal("peer_delegation_expired", 408));
      expect(j.files()).toEqual([]);
    }
  });
  it("K2-DEL-14 and K2-DEL-17 a delegation whose session key equals its buyer or its seller is peer_delegation_invalid 401 on both routes", async () => {
    const x = await world();
    for (const route of ROUTES) {
      for (const key of [x.buyer.key, x.seller.key]) {
        const j = journal(), e = await exchange(x, route, { delegation: { sessionPublicKey: key } });
        await expect(admit(e, j)).rejects.toMatchObject(refusal("peer_delegation_invalid", 401));
        expect(j.files()).toEqual([]);
      }
      expect(await admit(await exchange(x, route), journal())).toMatchObject({ route });
    }
  });

  it("P03b-CR1 interrupted admission and delayed reserve recheck authority and expiry", async () => {
    let withdrawn = false;
    const sentinel = new Error("authority withdrawn after admission");
    const x = await world({ readAuthority: scope => {
      if (withdrawn) throw sentinel;
      return authorityDecision(scope, () => x.binding.profile);
    } });
    for (const direct of [true, false]) {
      const j = journal(), e = await exchange(x, "context", { direct });
      const a = await admit(e, j);
      expect(wire.inspectWireOperation(j.reopen(), (await e.open()).payload)).toEqual({ state: "none" });
      const restarted = await admit(e, j, { requestJournal: j.reopen() });
      withdrawn = true;
      vi.mocked(performance.now).mockReturnValue(60_000);
      await expect(reserve(a)).rejects.toBe(sentinel);
      withdrawn = false;
      await expect(reserve(restarted)).rejects.toMatchObject(refusal("peer_expired", 408));
      await expect(admit(e, j, { now: NOW + 60_000, requestJournal: j.reopen() })).rejects.toMatchObject(refusal("peer_expired", 408));
      expect(j.files()).toEqual([]);
      vi.mocked(performance.now).mockReturnValue(0);
    }
  });
  it("P03b-CR2 nonce-only context cut survives reopen without stranding the operation", async () => {
    const x = await world();
    let faulty = true;
    const j = journal({ clock: () => faulty ? Number.NaN : NOW }), e = await exchange(x, "context");
    await expect(reserve(await admit(e, j))).rejects.toMatchObject(refusal("seller_configuration_invalid", 500));
    expect(j.files()).toHaveLength(1);
    expect(j.files()[0]).toMatch(/^k-/);
    faulty = false;
    const reopened = j.reopen();
    expect(wire.inspectWireOperation(reopened, (await e.open()).payload)).toEqual({ state: "none" });
    await expect(reserve(await admit(e, j, { requestJournal: reopened }))).rejects.toMatchObject(refusal("peer_request_replayed"));
    expect(await reserve(await admit(await exchange(x, "context"), j, { requestJournal: reopened }))).toMatchObject({ state: "new", attempt: 0 });
  });
  it("P03b-CR3 lost context reservation recovers after restart and fences competing completions", async () => {
    const x = await world(), time = { now: NOW }, j = journal({ clock: () => time.now, leaseMs: 1000 });
    const e = await exchange(x, "context"), first = await reserve(await admit(e, j)), reopened = j.reopen();
    const retry = async (input: Input = {}) => reserve(await admit(await exchange(x, "context", input), j, { requestJournal: reopened }));
    await expect(retry()).rejects.toMatchObject(refusal("seller_effect_pending", 503));
    const changed = await exchange(x, "context", { request: { agreementHash: sha256Hex("other-scope") } });
    await expect(reserve(await admit(changed, j, { requestJournal: reopened, retained: { ...x.retained, agreementHash: sha256Hex("other-scope"), accepted: true } }))).rejects.toMatchObject(refusal("peer_operation_mismatch"));
    time.now += 1000;
    const results = await Promise.allSettled([retry(), retry()]);
    const successful = results.filter((r): r is PromiseFulfilledResult<wire.WireEffect> => r.status === "fulfilled");
    expect(successful).toHaveLength(1);
    expect(successful[0]?.value).toMatchObject({ state: "recover", attempt: 1 });
    expect(results).toContainEqual({ status: "rejected", reason: expect.objectContaining(refusal("seller_effect_pending", 503)) });
    expect(() => wire.completeWireEffect(j.handle, first, OUTCOME)).toThrowError(expect.objectContaining(refusal("seller_effect_superseded", 500)));
    const recovered = successful[0]?.value;
    if (!recovered) throw new Error("recovery missing");
    wire.completeWireEffect(reopened, recovered, OUTCOME);
    expect(wire.inspectWireOperation(j.reopen(), (await e.open()).payload)).toMatchObject({ state: "completed", outcome: OUTCOME });
  });
  for (const endOnly of [true, false]) it(endOnly ? "P03b-CR4 reopened end-only context outcome supports settled inspection" : "P03b-CR5 lost context response replays after restart during drain", async () => {
    const x = await world(), j = journal(), e = await exchange(x, "context"), opened = await e.open();
    wire.completeWireEffect(j.handle, await reserve(await admit(e, j)), OUTCOME);
    if (endOnly) unlinkSync(join(j.directory, `o-${wire.wireOperationId(opened.payload)}.done`));
    const files = j.files(), reopened = j.reopen();
    const a = await admit(e, j, { requestJournal: reopened, ready: false, retained: { ...x.retained, accepted: true } });
    expect(a.route).toBe("context"); // Host replay deliberately never invokes the returned reserve closure.
    expect(wire.inspectWireOperation(reopened, opened.payload)).toEqual({ state: "completed", binding: wire.wireOperationBinding(opened.payload), outcome: OUTCOME });
    for (const patch of [{ agreementHash: sha256Hex("changed-scope") }, { buyer: party(4).claim }]) await expect(admit(e, j, { requestJournal: reopened, ready: false, retained: { ...x.retained, accepted: true, ...patch } })).rejects.toMatchObject({ code: patch.buyer ? "peer_agreement_party_mismatch" : "peer_agreement_mismatch" });
    expect(j.files()).toEqual(files);
  });
});
