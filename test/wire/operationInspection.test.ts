// Read-only inspection of the request journal (inspectWireOperation, listWireNonceKeys): it answers from the journal's own files, never publishes,
// never ends a lapsed attempt and reads no clock. Reservations here go through the journal's own reserveEffect with synthetic keys.
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical/hash.js";
import * as wireJournal from "../../src/wire/journal.js";
import * as wire from "../../src/wire/index.js";
import { journalDirectory } from "./requestJournalFixture.js";

const SELLER = `did:demos:agent:${"5a".repeat(32)}`;
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const OTHER_JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4J";
const PATH = wire.DACS_SELLER_HTTP_PATHS.proposals;
const BINDING = sha256Hex("binding-one");
const LEASE_MS = 1000;
const START = 1_780_000_000_000;
const OUTCOME = { status: 200, text: '{"proposal":"signed"}' };
const target = { seller: SELLER, jobId: JOB, path: PATH };
const operationId = sha256Hex(JSON.stringify({ jobId: JOB, path: PATH, seller: SELLER })); // JCS orders members by name

/** A journal over a fresh directory with a clock the test moves; `faulty` makes it answer a value the journal refuses, after the nonce key is published. */
function openJournal() {
  const state = { now: START, faulty: false, reads: 0 };
  const directory = journalDirectory();
  const open = () => wire.openWireRequestJournal(directory, { leaseMs: LEASE_MS, clock: () => { state.reads++; return state.faulty ? Number.NaN : state.now; } });
  const journal = open();
  const store = () => wireJournal.journalStore(journal);
  let counter = 0;
  const reserve = (overrides: Partial<wireJournal.EffectReservation> = {}) => {
    counter++;
    const reservation = { key: sha256Hex(`key-${counter}`), ...target, binding: BINDING, requestHash: sha256Hex(`request-${counter}`), ...overrides };
    return { reservation, effect: () => wireJournal.reserveEffect(store(), reservation) };
  };
  const files = () => readdirSync(directory).sort();
  return { state, directory, journal, open, reserve, files, lapse: () => { state.now += LEASE_MS; } };
}
const corrupt = (detail: string) => expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail });

describe("inspectWireOperation", () => {
  it("CAP inspection of an operation with no files answers none and changes no file", () => {
    const j = openJournal();
    const before = j.files();
    expect(wire.inspectWireOperation(j.journal, target)).toEqual({ state: "none" });
    expect(j.files()).toEqual(before);
  });

  it("CAP inspection answers pending with attempt 0's binding and the latest attempt's requestHash and leaseUntil, before and after the lease runs out, and never ends it", () => {
    const j = openJournal();
    const first = j.reserve();
    expect(first.effect()).toMatchObject({ state: "new", attempt: 0 });
    const files = j.files();
    const pending = { state: "pending", binding: BINDING, attempt: 0, requestHash: first.reservation.requestHash, leaseUntil: START + LEASE_MS };
    expect(wire.inspectWireOperation(j.journal, target)).toEqual(pending);
    j.lapse();
    expect(wire.inspectWireOperation(j.journal, target)).toEqual(pending);
    expect(j.files()).toEqual(files);
    expect(files.some((name) => name.endsWith(".end"))).toBe(false);
    // A later reservation recovers it: inspection had left the lapsed attempt for reserve() to end.
    const second = j.reserve();
    expect(second.effect()).toMatchObject({ state: "recover", attempt: 1 });
    expect(wire.inspectWireOperation(j.journal, target)).toEqual({ ...pending, attempt: 1, requestHash: second.reservation.requestHash, leaseUntil: START + 2 * LEASE_MS });
  });

  it("CAP inspection answers ended with the superseded count after a null end and after a superseded end", () => {
    const j = openJournal();
    const first = j.reserve();
    wireJournal.completeWireEffect(j.journal, first.effect(), null);
    const ended = { state: "ended", binding: BINDING, attempt: 0, requestHash: first.reservation.requestHash, superseded: 0 };
    expect(wire.inspectWireOperation(j.journal, target)).toEqual(ended);
    expect(wire.inspectWireOperation(j.journal, target)).toEqual(ended);
    // Spend the journal's whole budget of superseded attempts: the last end is a superseded one and no attempt follows it.
    let last = j.reserve();
    last.effect();
    for (let n = 0; n < wire.MAX_EFFECT_ATTEMPTS - 1; n++) { j.lapse(); last = j.reserve(); expect(last.effect()).toMatchObject({ state: "recover" }); }
    j.lapse();
    expect(() => j.reserve().effect()).toThrowError(expect.objectContaining({ code: "seller_effect_unresolved" }));
    expect(wire.inspectWireOperation(j.journal, target)).toMatchObject({ state: "ended", superseded: wire.MAX_EFFECT_ATTEMPTS });
  });

  it("CAP inspection answers completed from the outcome file, and from an end record carrying the outcome without publishing .done (K5-X4)", () => {
    const j = openJournal();
    const first = j.reserve();
    wireJournal.completeWireEffect(j.journal, first.effect(), OUTCOME);
    const completed = { state: "completed", binding: BINDING, outcome: OUTCOME };
    expect(wire.inspectWireOperation(j.journal, target)).toEqual(completed);
    // A crash inside completeWireEffect after the end record and before the outcome file.
    const done = `o-${operationId}.done`;
    unlinkSync(join(j.directory, done));
    const files = j.files();
    expect(files).toHaveLength(3);
    expect(wire.inspectWireOperation(j.journal, target)).toEqual(completed);
    expect(j.files()).toEqual(files);
    // A later reservation publishes it (a nonce key and the outcome file).
    expect(j.reserve().effect()).toMatchObject({ state: "completed", outcome: OUTCOME });
    expect(j.files()).toHaveLength(5);
  });

  it("CAP inspection after 17 nonce-only reservations answers none; a fresh request then gets new attempt 0 (K5-X6)", () => {
    const j = openJournal();
    j.state.faulty = true; // the journal's clock fails after the nonce key is published and before any attempt
    for (let n = 0; n < 17; n++) expect(() => j.reserve().effect()).toThrowError(expect.objectContaining({ code: "seller_configuration_invalid" }));
    expect(j.files()).toHaveLength(17);
    j.state.faulty = false;
    expect(wire.inspectWireOperation(j.journal, target)).toEqual({ state: "none" });
    expect(j.reserve().effect()).toMatchObject({ state: "new", attempt: 0 });
    expect(j.files()).toHaveLength(19);
  });

  it("CAP competitors that only inspect see pending and publish nothing; the journal stops after 16 superseded attempts with 17 k- files (K5-X7 b)", () => {
    const j = openJournal();
    expect(j.reserve().effect()).toMatchObject({ state: "new", attempt: 0 });
    for (let attempt = 1; attempt < wire.MAX_EFFECT_ATTEMPTS; attempt++) {
      const files = j.files();
      for (let competitor = 0; competitor < 3; competitor++) expect(wire.inspectWireOperation(j.journal, target)).toMatchObject({ state: "pending", attempt: attempt - 1 });
      expect(j.files()).toEqual(files);
      j.lapse();
      expect(j.reserve().effect()).toMatchObject({ state: "recover", attempt });
    }
    j.lapse();
    expect(() => j.reserve().effect()).toThrowError(expect.objectContaining({ code: "seller_effect_unresolved", status: 500 }));
    expect(j.files().filter((name) => name.startsWith("k-"))).toHaveLength(wire.MAX_EFFECT_ATTEMPTS + 1);
  });

  it("CAP inspection refuses a non-effect path, a malformed seller or job, and a foreign journal handle", () => {
    const j = openJournal();
    const { state, contextChallenge, bundleBuyerCopy } = wire.DACS_SELLER_HTTP_PATHS;
    for (const path of [state, contextChallenge, bundleBuyerCopy, "/dacs/v1/unknown", "/dacs/v1/payments/"]) {
      expect(() => wire.inspectWireOperation(j.journal, { ...target, path }), path).toThrowError(expect.objectContaining({ code: "wire_input_invalid", status: 500 }));
    }
    for (const bad of [{ seller: "seller" }, { seller: undefined }, { jobId: "job" }, { jobId: undefined }]) {
      expect(() => wire.inspectWireOperation(j.journal, { ...target, ...bad } as typeof target), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: "wire_input_invalid" }));
    }
    for (const foreign of [{ directory: j.directory }, Object.freeze({ directory: j.directory }), null, undefined, "journal"]) {
      expect(() => wire.inspectWireOperation(foreign as unknown as wire.WireRequestJournal, target)).toThrowError(expect.objectContaining({ code: "seller_replay_guard_required", status: 500 }));
    }
  });

  it("CAP inspection keeps the journal's corrupt-store and size refusals", () => {
    const j = openJournal();
    const attempt = `o-${operationId}-0`, end = `${attempt}.end`, done = `o-${operationId}.done`;
    const write = (name: string, contents: string) => writeFileSync(join(j.directory, name), contents);
    write(attempt, "x".repeat(5000));
    expect(() => wire.inspectWireOperation(j.journal, target)).toThrowError(corrupt("STORE-ENTRY-TOO-LARGE"));
    write(attempt, "{}");
    expect(() => wire.inspectWireOperation(j.journal, target)).toThrowError(corrupt("STORE-ATTEMPT-INVALID"));
    rmSync(join(j.directory, attempt));
    const first = j.reserve();
    first.effect();
    write(end, "{}");
    expect(() => wire.inspectWireOperation(j.journal, target)).toThrowError(corrupt("STORE-END-INVALID"));
    rmSync(join(j.directory, end));
    write(done, "{}");
    expect(() => wire.inspectWireOperation(j.journal, target)).toThrowError(corrupt("STORE-OUTCOME-INVALID"));
    // A well-formed outcome with no attempt 0 behind it.
    write(done, JSON.stringify({ attempt: 0, operationId, outcome: { status: OUTCOME.status, textBytes: Buffer.from(OUTCOME.text).toString("base64url") } }));
    rmSync(join(j.directory, attempt));
    expect(() => wire.inspectWireOperation(j.journal, target)).toThrowError(corrupt("STORE-ATTEMPT-MISSING"));
  });

  it("CAP inspection gives the same answer after the journal is reopened", () => {
    const j = openJournal();
    j.reserve().effect();
    j.lapse();
    const pending = wire.inspectWireOperation(j.journal, target);
    expect(wire.inspectWireOperation(j.open(), target)).toEqual(pending);
    const second = j.reserve();
    wireJournal.completeWireEffect(j.journal, second.effect(), OUTCOME);
    expect(wire.inspectWireOperation(j.open(), target)).toEqual(wire.inspectWireOperation(j.journal, target));
    expect(wire.inspectWireOperation(j.open(), target)).toMatchObject({ state: "completed", outcome: OUTCOME });
  });
});

describe("listWireNonceKeys", () => {
  it("CAP OP-2 enumerates every nonce key without a clock or journal write", () => {
    const j = openJournal();
    const kept: string[] = [];
    const reserve = (overrides: Partial<wireJournal.EffectReservation> = {}) => { const r = j.reserve(overrides); kept.push(r.reservation.key); return r; };
    reserve().effect();                                                          // an attempt
    wireJournal.completeWireEffect(j.journal, reserve({ jobId: OTHER_JOB }).effect(), OUTCOME); // another operation, completed
    reserve({ path: wire.DACS_SELLER_HTTP_PATHS.payments }).effect();            // another route
    j.state.faulty = true;
    for (let n = 0; n < 40; n++) expect(() => reserve().effect()).toThrow();    // nonce-only cuts, past any attempt search
    j.state.faulty = false;
    const files = j.files();
    const clockReads = j.state.reads;
    const listed = wire.listWireNonceKeys(j.journal);
    expect(listed.map((record) => record.key).sort()).toEqual([...kept].sort());
    expect(listed.find((record) => record.key === kept[0])).toEqual({ key: kept[0], operationId, binding: BINDING, requestHash: sha256Hex("request-1") });
    expect(j.state.reads).toBe(clockReads);
    expect(j.files()).toEqual(files);
    expect(wire.listWireNonceKeys(j.open())).toEqual(listed);
    expect(wire.inspectWireOperation(j.open(), target)).toEqual(wire.inspectWireOperation(j.journal, target));
  });

  it("CAP OP-2 refuses an incomplete or corrupt enumeration instead of truncating it", () => {
    const j = openJournal();
    for (const overrides of [{}, { jobId: OTHER_JOB }, { path: wire.DACS_SELLER_HTTP_PATHS.payments }]) j.reserve(overrides).effect();
    expect(() => wire.listWireNonceKeys(j.journal, 2)).toThrowError(corrupt("STORE-ENUMERATION-INCOMPLETE"));
    expect(wire.listWireNonceKeys(j.journal, 3)).toHaveLength(3);
    const name = j.files().find((file) => file.startsWith("k-"))!;
    const write = (file: string, contents: string) => writeFileSync(join(j.directory, file), contents);
    const kept = readFileSync(join(j.directory, name), "utf8");
    write(name, "x".repeat(5000));
    expect(() => wire.listWireNonceKeys(j.journal)).toThrowError(corrupt("STORE-ENTRY-TOO-LARGE"));
    for (const contents of ["{}", "not json", kept.replace(/"key":"[0-9a-f]{64}"/, `"key":"${"0".repeat(64)}"`)]) {
      write(name, contents);
      expect(() => wire.listWireNonceKeys(j.journal), contents).toThrowError(corrupt("STORE-NONCE-INVALID"));
    }
    write(name, kept);
    write("k-not-a-key", kept);
    expect(() => wire.listWireNonceKeys(j.journal)).toThrowError(corrupt("STORE-NONCE-INVALID"));
    rmSync(join(j.directory, "k-not-a-key"));
    mkdirSync(join(j.directory, `k-${"1".repeat(64)}`));
    expect(() => wire.listWireNonceKeys(j.journal)).toThrowError(corrupt("STORE-ENTRY-NOT-FILE"));
    expect(() => wire.listWireNonceKeys({ directory: j.directory } as wire.WireRequestJournal)).toThrowError(expect.objectContaining({ code: "seller_replay_guard_required" }));
  });
});
