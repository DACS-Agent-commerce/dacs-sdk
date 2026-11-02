// Under ready:false a seller still admits the later stages of a purchase it retains: proposals, commitments and the commitment signature, on the
// host's own retained.allocated flag or an operation already bound to the request's binding. Nothing is reserved until reserve() is called.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as wire from "../../src/wire/index.js";
import { journalDirectory } from "./requestJournalFixture.js";
import { NOW, P, STAGE_ROUTES, world, type World } from "./reservationFixture.js";

const TIMEOUT_MS = 60_000;
const NOT_READY = { code: "seller_not_ready", status: 503 };
const RETAINED_REQUIRED = { code: "seller_retained_agreement_required", status: 500 };
const NON_STAGE_ROUTES = [P.payments, P.bundleRequest, P.bundleCountersignature, P.state, P.bundleBuyerCopy, P.context];

function journalWithFiles(options?: wire.WireRequestJournalOptions) {
  const directory = journalDirectory();
  return { journal: wire.openWireRequestJournal(directory, options), files: () => readdirSync(directory).sort() };
}
type Overrides = Partial<wire.RequestCheck> & { retained?: unknown };
/** The check a drained seller makes for `path`, against `journal`. */
const drained = (x: World, path: string, journal: wire.WireRequestJournal, overrides: Overrides = {}) =>
  ({ ...x.check(path), ready: false, requestJournal: journal, ...overrides }) as wire.RequestCheck;
const admit = async (x: World, path: string, journal: wire.WireRequestJournal, overrides: Overrides = {}, body = "{}") =>
  wire.checkWireRequest(await x.open(path, body), drained(x, path, journal, { rawBody: Buffer.from(body), ...overrides }));

describe("retained-stage admission under ready:false", { timeout: TIMEOUT_MS }, () => {
  it("CAP K5-W7 proposals, commitments and commitment signature under ready:false: allocated true / false / absent or \"yes\"", async () => {
    const x = await world();
    for (const path of STAGE_ROUTES) {
      const j = journalWithFiles();
      const admitted = await admit(x, path, j.journal, { retained: x.retainedFor(path, true) });
      expect(admitted.reserve, path).toBeTypeOf("function");
      expect(j.files(), path).toEqual([]);
      await expect(admit(x, path, j.journal, { retained: x.retainedFor(path, false) }), path).rejects.toMatchObject(NOT_READY);
      for (const retained of [x.retained, { ...x.retained, allocated: "yes" }, { ...x.retained, allocated: 1 }, { ...x.retained, allocated: null }]) {
        await expect(admit(x, path, j.journal, { retained }), `${path} ${JSON.stringify(retained)}`).rejects.toMatchObject(RETAINED_REQUIRED);
      }
      expect(j.files(), path).toEqual([]);
    }
  });

  it("CAP K5-W8 allocated:true never admits another Agreement hash or buyer", async () => {
    const x = await world(), other = await world();
    for (const path of STAGE_ROUTES) {
      const j = journalWithFiles();
      const retained = x.retainedFor(path, true);
      await expect(admit(x, path, j.journal, { retained: { ...retained, agreementHash: other.agreementHash } }), path).rejects.toMatchObject({ code: "peer_agreement_mismatch" });
      await expect(admit(x, path, j.journal, { retained: { ...retained, buyer: other.buyer.claim } }), path).rejects.toMatchObject({ code: "peer_agreement_party_mismatch" });
      await expect(admit(other, path, j.journal, { retained }), path).rejects.toMatchObject({ code: "peer_agreement_mismatch" });
      expect(j.files(), path).toEqual([]);
    }
  });

  it("CAP K5-W9 ready:true admits as today whatever allocated says, but the member is required", async () => {
    const x = await world();
    for (const path of STAGE_ROUTES) {
      for (const allocated of [true, false]) {
        const checked = await wire.checkWireRequest(await x.open(path), { ...x.check(path), retained: x.retainedFor(path, allocated), requestJournal: journalWithFiles().journal });
        expect(checked.reserve, `${path} ${allocated}`).toBeTypeOf("function");
      }
      await expect(wire.checkWireRequest(await x.open(path), { ...x.check(path), retained: x.retained, requestJournal: journalWithFiles().journal }), path).rejects.toMatchObject(RETAINED_REQUIRED);
    }
  });

  it("CAP under ready:false, with required retained.allocated:false, an operation already bound to this request's binding is admitted; one bound to another binding is seller_not_ready", async () => {
    const x = await world(), other = await world();
    for (const path of STAGE_ROUTES) {
      for (const state of ["pending", "ended", "completed"]) {
        const j = journalWithFiles();
        const first = await reserveFirst(x, path, j.journal);
        if (state === "ended") wire.completeWireEffect(j.journal, first, null);
        if (state === "completed") wire.completeWireEffect(j.journal, first, { status: 200, text: "{}" });
        const files = j.files(), name = `${path} ${state}`;
        expect((await admit(x, path, j.journal, { retained: x.retainedFor(path, false) })).reserve, name).toBeTypeOf("function");
        await expect(admit(other, path, j.journal, { retained: other.retainedFor(path, false) }), `${name}, another binding`).rejects.toMatchObject(NOT_READY);
        for (const retained of [x.retained, { ...x.retained, allocated: "false" }]) {
          await expect(admit(x, path, j.journal, { retained }), `${name} ${JSON.stringify(retained)}`).rejects.toMatchObject(RETAINED_REQUIRED);
        }
        expect(j.files(), name).toEqual(files);
      }
      // No operation at all: the same request is refused.
      await expect(admit(x, path, journalWithFiles().journal, { retained: x.retainedFor(path, false) }), path).rejects.toMatchObject(NOT_READY);
    }
  });

  it("CAP retained.allocated is refused on routes that do not take it", async () => {
    const x = await world();
    for (const path of NON_STAGE_ROUTES) {
      for (const ready of [true, false]) {
        const check = { ...x.check(path), ready, retained: { ...x.retained, allocated: false }, requestJournal: journalWithFiles().journal } as wire.RequestCheck;
        await expect(wire.checkWireRequest(await x.open(path), check), `${path} ready=${ready}`).rejects.toMatchObject(RETAINED_REQUIRED);
      }
    }
  });

  it("CAP the context route keeps its ready rule and its four retained members until P03b", async () => {
    const x = await world();
    const j = journalWithFiles();
    await reserveFirst(x, P.context, j.journal);
    // Even with an operation already bound to this binding, a drained seller refuses the context route.
    await expect(admit(x, P.context, j.journal, { retained: x.retained })).rejects.toMatchObject(NOT_READY);
    expect((await wire.checkWireRequest(await x.open(P.context), { ...x.check(P.context), requestJournal: j.journal })).reserve).toBeTypeOf("function");
  });

  it("CAP K5-S8 wire slice: a proposals stage admitted under ready:false after 8 nonce-only cuts reserves new attempt 0 (files 8 to 10)", async () => {
    const x = await world();
    let faulty = true;
    const j = journalWithFiles({ clock: () => faulty ? Number.NaN : NOW });
    const retained = x.retainedFor(P.proposals, true);
    for (let cut = 0; cut < 8; cut++) {
      const checked = await admit(x, P.proposals, j.journal, { retained });
      await expect(checked.reserve!()).rejects.toMatchObject({ code: "seller_configuration_invalid" });
    }
    expect(j.files()).toHaveLength(8);
    faulty = false;
    const checked = await admit(x, P.proposals, j.journal, { retained });
    expect(await checked.reserve!()).toMatchObject({ state: "new", attempt: 0 });
    expect(j.files()).toHaveLength(10);
  });

  it("CAP a request body member named allocated or accepted changes nothing", async () => {
    const x = await world();
    const body = JSON.stringify({ allocated: true, accepted: true });
    for (const path of STAGE_ROUTES) {
      await expect(admit(x, path, journalWithFiles().journal, { retained: x.retainedFor(path, false) }, body), path).rejects.toMatchObject(NOT_READY);
    }
  });
});

/** The first reservation of a route's operation, made while the seller was ready. */
async function reserveFirst(x: World, path: string, journal: wire.WireRequestJournal): Promise<wire.WireEffect> {
  const checked = await wire.checkWireRequest(await x.open(path), { ...x.check(path), requestJournal: journal });
  return checked.reserve!();
}
