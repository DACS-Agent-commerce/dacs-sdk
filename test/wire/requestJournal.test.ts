import * as fixtureWire from "../../src/wire/index.js";
import { fixtureBinder } from "./authorityFixture.js";
import { journalDirectory, journalFixture } from "./requestJournalFixture.js";
import { ed25519KeyPair, received, signedAgreement, tp1Listing, validReceipt, wireCommitment } from "./commitmentFixture.js";
import { spawn } from "node:child_process";
import { randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize, sha256Hex } from "../../src/canonical/index.js";
import * as wire from "../../src/wire/index.js";

// Another worker's step, run once just before this process next links an operation entry (o-…) into the
// journal: the gap between a check and the publish that acts on it. Unset, link() is the real one.
const race = vi.hoisted(() => ({ beforeLink: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const linkSync: typeof fs.linkSync = (existing, target) => {
    const step = race.beforeLink;
    if (step !== undefined && /\/o-[^/]*$/.test(String(target))) { race.beforeLink = undefined; step(); }
    fs.linkSync(existing, target);
  };
  return { ...fs, default: { ...fs, linkSync }, linkSync };
});

const bindTp1Fixture = fixtureBinder(fixtureWire);
const { testJournals, openJournal } = journalFixture(fixtureWire);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const NOW = Date.UTC(2026, 9, 18);
const JOB = "01K7FZ8Q9W3V5T2R1N0M8K6J4H";
const LOCAL = { endpoint: "https://rpc.journal.invalid/", transportAuthority: "test", connectionId: "1" };
// The seller's key is fixed, so its signed Listing, and the pin every request names, is a constant.
const SELLER_SEED = 52;
const { listing: LISTING, pin: PIN } = tp1Listing({ seller: party(SELLER_SEED), listingId: "report" });
const P = wire.DACS_SELLER_HTTP_PATHS;
const EFFECT_ROUTES = wire.DACS_SELLER_HTTP_ROUTES.filter((r) => r.auth === "signed" && r.effect === "effect").map((r) => r.path);
const PAYMENT_AND_DELIVERY = [P.payments, P.bundleRequest] as const;
function party(seed?: number) {
  const { privateKey, publicKey } = ed25519KeyPair(seed);
  const key = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { claim: `did:demos:agent:${key}`, key, sign: (bytes: Uint8Array) => sign(null, Buffer.from(bytes), privateKey) };
}
const header = (value: unknown) => Buffer.from(canonicalize(value)).toString("base64url");
/** A fresh request nonce: the reservation key is shared across routes, so each request needs its own. */
const nonce = () => randomBytes(24).toString("base64url");
function world() {
  const buyer = party(), seller = party(SELLER_SEED), session = party();
  const binding = bindTp1Fixture({ record: wire.TP1_APPROVED_IDENTITY_RECORD, local: LOCAL });
  const context = { binding, local: LOCAL, purchaseProfile: binding.profile };
  const { agreement, agreementHash } = signedAgreement({ buyer, seller, jobId: JOB, listingPin: PIN });
  const request = (path: string, nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX", body = "{}"): wire.WireRequestPayload => ({
    version: "1", kind: "request", method: "POST", path, jobId: JOB, buyer: buyer.claim, seller: seller.claim, bodyHash: sha256Hex(body),
    listingPin: PIN, agreementHash, nonce, expiresAt: NOW + 30_000, profile: binding.profile,
  });
  const signed = (payload: unknown, signer: ReturnType<typeof party>, domain: string) => ({ payload, signature: signer.sign(Buffer.from(domain + canonicalize(payload))).toString("base64url") });
  /** The buyer-signed (undelegated) request header. */
  const direct = (payload: wire.WireRequestPayload) => header(signed(payload, buyer, wire.DACS_SELLER_HTTP_DOMAINS.request));
  const delegated = (payload: wire.WireRequestPayload) => {
    const delegation = signed({ version: "1", kind: "seller-session-delegation", buyer: buyer.claim, seller: seller.claim,
      sessionPublicKey: session.key, listingPin: PIN, jobId: JOB, notBefore: NOW - 1000, expiresAt: NOW + 60_000,
      profile: binding.profile }, buyer, wire.DACS_SELLER_HTTP_DOMAINS.delegation);
    return wire.openWireEnvelope(header({ ...signed(payload, session, wire.DACS_SELLER_HTTP_DOMAINS.request), delegation }), "request", { ...context, requireDelegation: true });
  };
  const artifact = { jobId: JOB, listingRef: PIN, parties: [{ role: "buyer", primaryClaim: buyer.claim }, { role: "seller", primaryClaim: seller.claim }], terms: { deadline: NOW + 60_000 } };
  /** What the seller host retained for the job: its own record, not read from the request. */
  const retained = { jobId: JOB, agreementHash, buyer: buyer.claim, seller: seller.claim };
  /** The job's finalized commitment and its signed Agreement, which the seller read itself: payment and delivery routes need them. */
  const commitment = wireCommitment({ seller, buyer: buyer.claim, jobId: JOB, agreementHash, listingPin: PIN, committedAt: NOW - 5000 });
  // The seller is ready, so a route that starts a purchase reaches its reservation.
  const check = (path: string) => ({ ...context, seller: seller.claim, listingPin: PIN, method: "POST", path, rawBody: Buffer.from("{}"), now: NOW, retained, ready: true,
    commitment: received(commitment), agreement: received(agreement), readCommitmentReceipt: validReceipt, signedListing: received(LISTING) });
  return { seller, context, agreement, request, direct, delegated, artifact, retained, commitment, check };
}

describe("an effect route without the SDK's journal", () => {
  // None came from openWireRequestJournal, a journal that declares itself durable included; none is ever called.
  const undeclared = (stub: () => boolean): Array<[string, object]> => [
    ["the earlier reserveRequest callback", { reserveRequest: stub }],
    ["a bare callback", { requestJournal: stub }],
    ["an in-memory set with no declaration", { requestJournal: { reserve: stub } }],
    ["durable: false", { requestJournal: { durable: false, reserve: stub } }],
    ['durable: "true"', { requestJournal: { durable: "true", reserve: stub } }],
    ["a declaration with no reserve", { requestJournal: { durable: true, reserveRequest: stub } }],
    ["a journal that declares itself durable", { requestJournal: { durable: true, reserve: stub } }],
    ["the earlier qualified handle's shape", { requestJournal: { qualified: true } }],
  ];
  it.each(EFFECT_ROUTES)("%s refuses any other journal, direct and delegated", (path) => {
    const x = world();
    const calls: string[] = [];
    const stub = () => { calls.push("reserved"); return true; };
    const opened = { direct: () => wire.openWireEnvelope(x.direct(x.request(path, nonce())), "request", x.context), delegated: () => x.delegated(x.request(path, nonce())) };
    for (const [mode, open] of Object.entries(opened)) {
      const check = { ...x.check(path), ...(mode === "delegated" ? { requireDelegation: true, artifacts: [x.artifact] } : {}) };
      for (const [name, given] of undeclared(stub)) {
        expect(() => wire.checkWireRequest(open(), { ...check, ...given } as wire.RequestCheck), `${mode}: ${name}`)
          .toThrowError(expect.objectContaining({ code: "seller_replay_guard_required", status: 500 }));
      }
    }
    expect(calls).toEqual([]);
    // Only the SDK's own journal reserves.
    const journals = testJournals();
    expect(wire.checkWireRequest(opened.direct(), { ...x.check(path), requestJournal: journals.open() })).toEqual({ body: {}, readbackOnly: false, effect: expect.objectContaining({ state: "new" }) });
    expect(wire.checkWireRequest(opened.delegated(), { ...x.check(path), requireDelegation: true, artifacts: [x.artifact], requestJournal: journals.open() }).readbackOnly).toBe(false);
    expect(journals.reservations()).toHaveLength(2);
  });

  it("read routes need no journal and have no effect", () => {
    const x = world();
    for (const path of [P.state, P.bundleBuyerCopy]) {
      expect(wire.checkWireRequest(wire.openWireEnvelope(x.direct(x.request(path)), "request", x.context), x.check(path))).toEqual({ body: {}, readbackOnly: false, effect: null });
    }
  });
});

describe("the durable journal across a restart and concurrent workers", () => {
  const scratch: string[] = [];
  afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** Each worker is its own Node process (a nested Vitest run of test/fixtures/wire-journal-child.test.ts). */
  function worker(input: string, result: string, env: Record<string, string> = {}) {
    const child = spawn(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "test/fixtures/wire-journal-child.test.ts", "--pool=forks", "--maxWorkers=1", "--reporter=dot"], {
      cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DACS_WIRE_JOURNAL_CHILD: "1", DACS_WIRE_JOURNAL_INPUT: input, DACS_WIRE_JOURNAL_RESULT: result, ...env },
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    const verdicts = () => JSON.parse(readFileSync(result, "utf8")) as string[];
    return { child, exited, verdicts, output: () => output };
  }
  async function appears(path: string, of: ReturnType<typeof worker>) {
    const deadline = Date.now() + 60_000;
    while (!existsSync(path)) {
      if (Date.now() > deadline || of.child.exitCode !== null) throw new Error(`worker did not write ${path}\n${of.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function killed(of: ReturnType<typeof worker>) {
    process.kill(-of.child.pid!, "SIGKILL");
    await of.exited;
  }
  /** A journal directory, its effects log, and the signed requests a worker checks, with the seller's own record. */
  function prepare(x: ReturnType<typeof world>, lists: Record<string, Array<{ payload: wire.WireRequestPayload; body: string }>>, leaseMs?: number) {
    const dir = mkdtempSync(join(tmpdir(), "dacs-wire-journal-"));
    scratch.push(dir);
    const journal = join(dir, "journal");
    mkdirSync(journal, { mode: 0o700 });
    const inputs = Object.fromEntries(Object.entries(lists).map(([name, requests]) => {
      const path = join(dir, `${name}.input.json`);
      writeFileSync(path, JSON.stringify({ journal, leaseMs, now: NOW, local: LOCAL, seller: x.seller.claim, listingPin: PIN, retained: x.retained, commitment: x.commitment, agreement: x.agreement, signedListing: LISTING,
        requests: requests.map(({ payload, body }) => ({ path: payload.path, header: x.direct(payload), body })) }));
      return [name, path];
    }));
    const effects = () => (existsSync(join(dir, "effects.log")) ? readFileSync(join(dir, "effects.log"), "utf8").split("\n").filter(Boolean) : []);
    return { dir, inputs, effects };
  }
  /** Payment and delivery for the job, each signed again with a fresh nonce and other incidental body fields. */
  const effectRequests = (x: ReturnType<typeof world>, note: string) => PAYMENT_AND_DELIVERY.map((path) => {
    const body = JSON.stringify({ note });
    return { payload: x.request(path, nonce(), body), body };
  });
  const operations = (x: ReturnType<typeof world>) => PAYMENT_AND_DELIVERY.map((path) => wire.wireOperationId(x.request(path))).sort();

  it.each(["after-reserve", "after-effect"] as const)("a worker killed %s: its replacement recovers, and payment and delivery each run exactly once", async (crash) => {
    const x = world();
    const leaseMs = 1000;
    const { dir, inputs, effects } = prepare(x, { first: effectRequests(x, "first"), retry: effectRequests(x, "retry"), again: effectRequests(x, "again") }, leaseMs);
    const first = worker(inputs.first!, join(dir, "first.json"), { DACS_WIRE_JOURNAL_CRASH: crash });
    await appears(join(dir, "first.json"), first);
    expect(first.verdicts()).toEqual(["new"]);
    await killed(first);
    expect(effects()).toHaveLength(crash === "after-effect" ? 1 : 0);
    // Restarted after the dead attempt's lease: each operation is recovered once, reconciled against the effects log.
    await new Promise((resolve) => setTimeout(resolve, leaseMs + 100));
    const restarted = worker(inputs.retry!, join(dir, "retry.json"));
    expect(await restarted.exited, restarted.output()).toBe(0);
    expect(restarted.verdicts()).toEqual(crash === "after-effect" ? ["reconciled", "new"] : ["recover", "new"]);
    // A later repeat, with yet another nonce and body, is answered with the kept outcome.
    const again = worker(inputs.again!, join(dir, "again.json"));
    expect(await again.exited, again.output()).toBe(0);
    expect(again.verdicts()).toEqual(PAYMENT_AND_DELIVERY.map((path) => `completed:${JSON.stringify({ effect: wire.wireOperationId(x.request(path)) })}`));
    expect([...effects()].sort()).toEqual(operations(x));
  }, 120_000);

  it("a worker killed while it holds the lease leaves the operation pending, never run twice, until the lease ends", async () => {
    const x = world();
    const { dir, inputs, effects } = prepare(x, { first: effectRequests(x, "first"), retry: effectRequests(x, "retry") }, 60_000);
    const first = worker(inputs.first!, join(dir, "first.json"), { DACS_WIRE_JOURNAL_CRASH: "after-reserve" });
    await appears(join(dir, "first.json"), first);
    await killed(first);
    const restarted = worker(inputs.retry!, join(dir, "retry.json"));
    expect(await restarted.exited, restarted.output()).toBe(0);
    expect(restarted.verdicts()).toEqual(["seller_effect_pending", "new"]);
    expect(effects()).toEqual([wire.wireOperationId(x.request(P.bundleRequest))]);
  }, 120_000);

  it("of two workers checking the same signed requests at once, exactly one accepts each", async () => {
    const x = world();
    // Each its own job route would share an operation, so each request is its own route-and-nonce pair: the race is on each one's key.
    const requests = Array.from({ length: 8 }, () => PAYMENT_AND_DELIVERY.map((path) => ({ payload: x.request(path, nonce()), body: "{}" }))).flat();
    // The two workers take the requests in opposite orders, so they meet partway.
    const { dir, inputs } = prepare(x, { forward: requests, backward: [...requests].reverse() });
    const go = join(dir, "go");
    const a = worker(inputs.forward!, join(dir, "a.json"), { DACS_WIRE_JOURNAL_GO: go });
    const b = worker(inputs.backward!, join(dir, "b.json"), { DACS_WIRE_JOURNAL_GO: go });
    await Promise.all([appears(join(dir, "a.json.ready"), a), appears(join(dir, "b.json.ready"), b)]);
    writeFileSync(go, "");
    expect(await a.exited, a.output()).toBe(0);
    expect(await b.exited, b.output()).toBe(0);
    const forward = a.verdicts(), backward = b.verdicts().reverse();
    expect(forward).toHaveLength(requests.length);
    for (const [i, verdict] of forward.entries()) expect([verdict, backward[i]], `request ${i}`).toContain("peer_request_replayed");
  }, 120_000);

  it("of two workers racing on the same payment and delivery with their own nonces, exactly one runs each effect", async () => {
    const x = world();
    const { dir, inputs, effects } = prepare(x, { a: effectRequests(x, "a"), b: effectRequests(x, "b").reverse() });
    const go = join(dir, "go");
    const a = worker(inputs.a!, join(dir, "a.json"), { DACS_WIRE_JOURNAL_GO: go });
    const b = worker(inputs.b!, join(dir, "b.json"), { DACS_WIRE_JOURNAL_GO: go });
    await Promise.all([appears(join(dir, "a.json.ready"), a), appears(join(dir, "b.json.ready"), b)]);
    writeFileSync(go, "");
    expect(await a.exited, a.output()).toBe(0);
    expect(await b.exited, b.output()).toBe(0);
    const verdicts = [...a.verdicts(), ...b.verdicts()];
    expect(verdicts.filter((v) => v === "new")).toHaveLength(2);
    expect(verdicts.every((v) => v === "new" || v === "seller_effect_pending" || v.startsWith("completed:"))).toBe(true);
    expect([...effects()].sort()).toEqual(operations(x));
  }, 120_000);
});

describe("the durable journal ends each attempt once: by its outcome, or by the request that recovers it", () => {
  afterEach(() => { race.beforeLink = undefined; });
  const settle = <T>(f: () => T): { value?: T; error?: string } => {
    try { return { value: f() }; } catch (error) { if (error instanceof wire.WireError) return { error: error.code }; throw error; }
  };
  /** Two workers on one directory and clock: the first holds a payment attempt whose lease has just ended. */
  function lapsed(crashes = 0) {
    const x = world();
    let clock = NOW;
    const directory = journalDirectory();
    const worker = () => wire.openWireRequestJournal(directory, { leaseMs: 1000, clock: () => clock });
    const a = worker(), b = worker();
    const at = (journal: wire.WireRequestJournal) => wire.checkWireRequest(wire.openWireEnvelope(x.direct(x.request(P.payments, nonce())), "request", x.context),
      { ...x.check(P.payments), requestJournal: journal }).effect!;
    let first = at(a);
    expect(first).toMatchObject({ state: "new", attempt: 0 });
    for (let n = 0; n < crashes; n++) {
      clock += 1000;
      first = at(a);
      expect(first).toMatchObject({ state: "recover", attempt: n + 1 });
    }
    clock += 1000;
    return { directory, a, b, at, first };
  }
  const paid = { status: 200, text: '{"paid":"first"}' };

  it("a recovery that runs before the lapsed attempt records its outcome supersedes it: that outcome is refused, and the recovery's own is kept", () => {
    const { a, b, at, first } = lapsed();
    let recovered: { value?: wire.WireEffect; error?: string } = {};
    race.beforeLink = () => { recovered = settle(() => at(b)); };
    const completed = settle(() => wire.completeWireEffect(a, first, paid));
    expect(recovered).toEqual({ value: expect.objectContaining({ state: "recover", attempt: 1 }) });
    expect(completed).toEqual({ error: "seller_effect_superseded" });
    const reconciled = { status: 200, text: '{"paid":"reconciled"}' };
    wire.completeWireEffect(b, recovered.value!, reconciled);
    expect(at(a)).toMatchObject({ state: "completed", outcome: reconciled });
  });

  it("an outcome the lapsed attempt records before the recovery publishes anything stands: the recovery is answered with it and starts no attempt", () => {
    const { a, b, at, first } = lapsed();
    let completed: { value?: void; error?: string } = {};
    race.beforeLink = () => { completed = settle(() => wire.completeWireEffect(a, first, paid)); };
    const recovered = settle(() => at(b));
    expect(completed).toEqual({ value: undefined });
    expect(recovered).toEqual({ value: expect.objectContaining({ state: "completed", outcome: paid }) });
    expect(at(b)).toMatchObject({ state: "completed", outcome: paid });
  });

  it.each([null, { status: 200, text: '{"paid":"first"}' }])("an end that wins the race at the crash limit is honored: %j", (outcome) => {
    const { a, b, at, first } = lapsed(wire.MAX_EFFECT_ATTEMPTS - 1);
    let completed: { value?: void; error?: string } = {};
    race.beforeLink = () => { completed = settle(() => wire.completeWireEffect(a, first, outcome)); };
    const recovered = settle(() => at(b));
    expect(completed).toEqual({ value: undefined });
    if (outcome === null) {
      expect(recovered).toEqual({ value: expect.objectContaining({ state: "recover", attempt: wire.MAX_EFFECT_ATTEMPTS }) });
      wire.completeWireEffect(b, recovered.value!, paid);
    } else {
      expect(recovered).toEqual({ value: expect.objectContaining({ state: "completed", outcome }) });
    }
    expect(at(b)).toMatchObject({ state: "completed", outcome: paid });
  });

  it("refuses an end entry the journal did not write as a corrupt store, never as an ended attempt", () => {
    const { directory, a, b, at, first } = lapsed();
    wire.completeWireEffect(a, first, null);
    const file = join(directory, `o-${first.operationId}-0.end`);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(kept).toEqual({ operationId: first.operationId, attempt: 0, superseded: false, outcome: null });
    const corrupt = expect.objectContaining({ code: "seller_replay_guard_invalid", status: 500, detail: "STORE-END-INVALID" });
    for (const contents of ["{}", "not json", JSON.stringify({ ...kept, attempt: 1 }), JSON.stringify({ ...kept, superseded: true, outcome: paid }), JSON.stringify({ ...kept, outcome: { status: 200 } })]) {
      writeFileSync(file, contents);
      expect(() => at(b), contents).toThrowError(corrupt);
      expect(() => wire.completeWireEffect(a, first, null), contents).toThrowError(corrupt);
    }
    writeFileSync(file, JSON.stringify(kept));
    expect(at(b)).toMatchObject({ state: "recover", attempt: 1 });
  });
});

describe("the durable journal keyed by operation across a reopen", () => {
  it("a fresh nonce for an effect another handle reserved is held; the effect completes only on its own handle, and a reopened journal answers with the outcome", () => {
    const x = world();
    const directory = mkdtempSync(join(tmpdir(), "dacs-wire-operation-"));
    try {
      const check = (path: string, journal: wire.WireRequestJournal) => wire.checkWireRequest(wire.openWireEnvelope(x.direct(x.request(path, nonce())), "request", x.context),
        { ...x.check(path), requestJournal: journal });
      const issuer = openJournal(directory);
      const effects = PAYMENT_AND_DELIVERY.map((path) => check(path, issuer).effect!);
      for (const effect of effects) expect(effect.state).toBe("new");
      // A second journal handle over the same directory stands for another or restarted worker.
      const other = openJournal(directory);
      for (const path of PAYMENT_AND_DELIVERY) expect(() => check(path, other)).toThrowError(expect.objectContaining({ code: "seller_effect_pending", status: 503 }));
      expect(() => wire.completeWireEffect(other, effects[0]!, { status: 200, text: "0" })).toThrowError(expect.objectContaining({ code: "wire_input_invalid", detail: "EFFECT-NOT-ISSUED" }));
      effects.forEach((effect, i) => wire.completeWireEffect(issuer, effect, { status: 200, text: `${i}` }));
      PAYMENT_AND_DELIVERY.forEach((path, i) => expect(check(path, openJournal(directory)).effect).toMatchObject({ state: "completed", outcome: { status: 200, text: `${i}` } }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
