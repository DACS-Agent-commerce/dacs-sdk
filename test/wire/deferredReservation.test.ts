// checkWireRequest admits an effect request and returns reserve(): the journal is written only when the host calls it, after its own accounting.
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";
import { journalDirectory } from "./requestJournalFixture.js";
import { JOB, NOW, P, world } from "./reservationFixture.js";

const EFFECT_ROUTES = wire.DACS_SELLER_HTTP_ROUTES.filter((r) => r.auth === "signed" && r.effect === "effect").map((r) => r.path);
const READ_ROUTES = [P.state, P.bundleBuyerCopy];
const TIMEOUT_MS = 60_000;

/** A journal in a fresh directory, and the names of the files in it. */
function journalWithFiles(options?: wire.WireRequestJournalOptions) {
  const directory = journalDirectory();
  return { journal: wire.openWireRequestJournal(directory, options), files: () => readdirSync(directory).sort() };
}
/** Makes `performance.now` read `elapsedMs()` for the duration of `run`. */
async function withElapsed<T>(elapsedMs: () => number, run: () => Promise<T>): Promise<T> {
  const monotonic = vi.spyOn(performance, "now").mockImplementation(elapsedMs);
  try { return await run(); } finally { monotonic.mockRestore(); }
}

describe("deferred reservation", { timeout: TIMEOUT_MS }, () => {
  it("CAP checkWireRequest returns reserve() on every effect route and publishes no journal file until it is called; read routes return reserve: null", async () => {
    const x = await world();
    for (const path of EFFECT_ROUTES) {
      const j = journalWithFiles();
      const checked = await wire.checkWireRequest(await x.open(path), { ...x.check(path), requestJournal: j.journal });
      expect(checked, path).toEqual({ body: {}, readbackOnly: false, reserve: expect.any(Function) });
      expect(j.files(), path).toEqual([]);
      expect(await checked.reserve!(), path).toMatchObject({ state: "new", operationId: wire.wireOperationId(x.request(path)), attempt: 0 });
      expect(j.files(), path).toHaveLength(2);
    }
    for (const path of READ_ROUTES) {
      expect(await wire.checkWireRequest(await x.open(path), x.check(path))).toEqual({ body: {}, readbackOnly: false, reserve: null });
    }
  });

  it("CAP reserve() rechecks current authority, then request expiry, then delegation expiry, counting time from the check's start", async () => {
    const failure = new Error("authority withdrawn");
    let withdrawn = false;
    const x = await world({ readAuthority: (scope) => {
      if (withdrawn) throw failure;
      return { local: { ...scope.local }, chainIdentity: wire.TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: "test-only-independent-authority/v1",
        sessionId: scope.sessionId, participants: scope.participants.map((claim) => ({ claim, profile: x.binding.profile, modules: wire.TESTNET_PROFILE_TP1.tuple })) };
    } });
    const request = (delegated: boolean) => delegated ? x.delegated(x.request(P.payments, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX")) : x.open(P.payments);
    for (const delegated of [false, true]) {
      withdrawn = false;
      const j = journalWithFiles();
      const check = { ...x.check(P.payments), requestJournal: j.journal, ...(delegated ? { requireDelegation: true, artifacts: [x.artifact] } : {}) };
      // Authority first: the reader's own refusal, even when the request has also run out.
      let elapsed = 0;
      const checked = await withElapsed(() => elapsed, async () => wire.checkWireRequest(await request(delegated), check));
      withdrawn = true; elapsed = 30_000;
      await expect(withElapsed(() => elapsed, () => checked.reserve!()), `authority first, delegated=${delegated}`).rejects.toBe(failure);
      expect(j.files()).toEqual([]);
      // Then expiry, from the check's start: the host's own work between admission and reserve() counts.
      withdrawn = false;
      await expect(withElapsed(() => elapsed, () => checked.reserve!()), `expiry, delegated=${delegated}`).rejects.toMatchObject({ code: "peer_expired", status: 408 });
      expect(j.files()).toEqual([]);
      elapsed = 29_999;
      expect(await withElapsed(() => elapsed, () => checked.reserve!())).toMatchObject({ state: "new" });
    }
  });

  it("CAP every admission refusal happens before reserve() exists", async () => {
    const x = await world();
    const path = P.proposals;
    const refusals: Array<[string, Partial<wire.RequestCheck>, string]> = [
      ["audience", { seller: `did:demos:agent:${"7b".repeat(32)}` }, "peer_audience_wrong"],
      ["expiry", { now: NOW + 30_000 }, "peer_expired"],
      ["CF-5 body", { rawBody: Buffer.from("[]") }, "bad_request"],
      ["body hash", { rawBody: Buffer.from('{"a":1}') }, "peer_request_mismatch"],
      ["pin", { listingPin: { ...x.check(path).listingPin, version: 9 } }, "peer_listing_mismatch"],
      ["retained shape", { retained: x.retained as wire.RequestCheck["retained"] }, "seller_retained_agreement_required"],
      ["retained job", { retained: { ...x.retainedFor(path), jobId: "01K7FZ8Q9W3V5T2R1N0M8K6J4J" } }, "peer_job_mismatch"],
      ["delegation scope", { requireDelegation: true }, "peer_delegation_required"],
      ["readiness", { ready: false }, "seller_not_ready"],
      ["readiness missing", { ready: undefined }, "seller_readiness_required"],
    ];
    for (const [name, change, code] of refusals) {
      const j = journalWithFiles();
      const refused = wire.checkWireRequest(await x.open(path), { ...x.check(path), requestJournal: j.journal, ...change } as wire.RequestCheck);
      await expect(refused, name).rejects.toMatchObject({ code });
      expect(j.files(), name).toEqual([]);
    }
    // A delegated request with no Agreement artifact to bound its delegation is refused as well.
    const j = journalWithFiles();
    await expect(wire.checkWireRequest(await x.delegated(x.request(path)), { ...x.check(path), requireDelegation: true, requestJournal: j.journal }))
      .rejects.toMatchObject({ code: "peer_delegation_agreement_required" });
    expect(j.files()).toEqual([]);
  });

  it("CAP a second reserve() call is peer_request_replayed and publishes no second attempt", async () => {
    const x = await world();
    const j = journalWithFiles();
    const checked = await wire.checkWireRequest(await x.open(P.payments), { ...x.check(P.payments), requestJournal: j.journal });
    await checked.reserve!();
    const files = j.files();
    await expect(checked.reserve!()).rejects.toMatchObject({ code: "peer_request_replayed", status: 409 });
    expect(j.files()).toEqual(files);
  });

  it("CAP wireOperationBinding equals the binding the journal records (K5-KEY)", async () => {
    const x = await world();
    const j = journalWithFiles();
    const request = x.request(P.payments);
    const { profile, buyer, agreementHash } = request;
    const expected = sha256Hex(canonicalize({ profile, buyer, agreementHash }));
    expect(wire.wireOperationBinding(request)).toBe(expected);
    const checked = await wire.checkWireRequest(await x.open(P.payments), { ...x.check(P.payments), requestJournal: j.journal });
    await checked.reserve!();
    expect(wire.inspectWireOperation(j.journal, { seller: request.seller, jobId: JOB, path: P.payments })).toMatchObject({ state: "pending", binding: expected });
  });

  it("CAP K5-LS1 to K5-LS6 hold through checkWireRequest and reserve() with a 300 s lease", async () => {
    const x = await world();
    const LEASE_MS = 300_000;
    let clock = NOW;
    const j = journalWithFiles({ leaseMs: LEASE_MS, clock: () => clock });
    const reserve = async (n: string, path: string = P.payments) => (await wire.checkWireRequest(await x.open(path, "{}", n), { ...x.check(path), requestJournal: j.journal })).reserve!();
    const nonces = Array.from({ length: 6 }, (_, i) => Buffer.alloc(24, i + 1).toString("base64url"));
    // LS1: a first request runs; LS2: a live lease holds the operation; LS3: the same signed request again is a replay.
    const first = await reserve(nonces[0]!);
    expect(first).toMatchObject({ state: "new", attempt: 0, leaseUntil: NOW + LEASE_MS });
    await expect(reserve(nonces[1]!)).rejects.toMatchObject({ code: "seller_effect_pending", status: 503 });
    await expect(reserve(nonces[0]!)).rejects.toMatchObject({ code: "peer_request_replayed", status: 409 });
    // LS4: the lease runs out and the next request recovers; the lapsed attempt's own completion is refused.
    clock = NOW + LEASE_MS;
    const recovered = await reserve(nonces[2]!);
    expect(recovered).toMatchObject({ state: "recover", attempt: 1, leaseUntil: NOW + 2 * LEASE_MS });
    expect(() => wire.completeWireEffect(j.journal, first, { status: 200, text: "{}" })).toThrowError(expect.objectContaining({ code: "seller_effect_superseded" }));
    // LS5: the recovering attempt completes and every later request is answered with its outcome; LS6: another route is its own operation.
    wire.completeWireEffect(j.journal, recovered, { status: 200, text: '{"paid":true}' });
    expect(await reserve(nonces[3]!)).toMatchObject({ state: "completed", outcome: { status: 200, text: '{"paid":true}' } });
    expect(await reserve(nonces[4]!, P.bundleRequest)).toMatchObject({ state: "new", attempt: 0 });
  });
});
