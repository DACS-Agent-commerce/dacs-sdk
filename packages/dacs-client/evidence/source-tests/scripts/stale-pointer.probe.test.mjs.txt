// Probe for the held purchase path (HOLD.json, "inherited-stale-pointer"):
// H-03's known race, the one D15 must close. A delayed read of hash A must not
// verify a purchase whose retained pointer is now B, nor overwrite B's
// observation.
//
//   DACS_FRONTEND_REPO=<frontend repo> [DACS_STALE_POINTER_COMMIT=<commit>] \
//     node --test --test-concurrency=1 packages/dacs-client/scripts/stale-pointer.probe.test.mjs
//
// - It FAILS at 82bf8c4 (frontend main, the step-1 source): both tests fail at
//   their safety assertions. That failure is the evidence of the held defect.
// - It runs against the source repository, not the copied package (whose
//   imports stay cut until D1): it exports http-mcp at the commit (default
//   82bf8c4) to a scratch directory, unpacks the vendored @kynesyslabs/dacs
//   there and takes the other dependencies read-only from the SDK root install.
//   In-memory SQLite and a stub chain: no listener, no network, no signing.
// - Without DACS_FRONTEND_REPO both tests are skipped (# skipped 2), never passed.
//   A run that does not report "# tests 2" did not run: a setup failure ends
//   the file before the tests are registered.
// - A pass is necessary, not sufficient. A settlement-only fence (refusing to
//   settle when the retained pointer differs from the captured hash) passes
//   both tests. They do not cover, and the hold's other regressions must:
//   - a non-included read of A rewriting B's observation through
//     wallet-transactions.mjs:114 (recordUnverified, purchases.mjs:789);
//   - the durable nonce-consumption record written with the stale hash
//     (purchases.mjs:905);
//   - another purchase's lane;
//   - restart.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceGit } from "./source-git.mjs";

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO = process.env.DACS_FRONTEND_REPO || null;
const COMMIT = process.env.DACS_STALE_POINTER_COMMIT || "82bf8c4dabb2332a72f618f6cc29950e48d6feb6";
const SKIP = REPO ? false : "DACS_FRONTEND_REPO is not set: probe not run";

// The source modules, loaded from a scratch export of http-mcp at COMMIT.
let source = null;
if (REPO) {
  const out = mkdtempSync(join(tmpdir(), "stale-pointer-"));
  after(() => rmSync(out, { recursive: true, force: true }));
  const archive = sourceGit(["-C", REPO, "archive", COMMIT, "http-mcp"], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", out], { input: archive });
  const dacs = join(out, "http-mcp", "node_modules", "@kynesyslabs", "dacs");
  mkdirSync(dacs, { recursive: true });
  execFileSync("tar", ["-xzf", join(out, "http-mcp", "vendor", "kynesyslabs-dacs-0.1.0-alpha.0.tgz"), "-C", dacs, "--strip-components=1"]);
  symlinkSync(join(SDK_ROOT, "node_modules"), join(out, "node_modules"));
  const load = (rel) => import(pathToFileURL(join(out, "http-mcp", rel)).href);
  source = {
    ...(await load("src/store/database.mjs")),
    ...(await load("src/operations.mjs")),
    ...(await load("src/dacs/wallet-transactions.mjs")),
    ...(await load("src/purchases.mjs")),
  };
}

const CHAIN = "f".repeat(64);
const WALLET = `0x${"a".repeat(64)}`;
const PAYEE = `0x${"7".repeat(64)}`;
const AMOUNT = "2500000000";
const A = "1".repeat(64);
const B = "2".repeat(64);

function world(t) {
  const { openDatabase, createOperationStore, createCoordinateStore, createPurchaseService } = source;
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  db.prepare("INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)").run("TEST-buyer", "TEST", "TEST-buyer", new Date().toISOString());
  const ops = createOperationStore({ db, handoffSecret: "TEST-only-stale-pointer-probe-secret-000000" });
  const coordinates = createCoordinateStore({ db });
  // A's transfer read waits until the test releases it.
  let releaseA;
  const gateA = new Promise((done) => { releaseA = done; });
  let enteredA;
  const readingA = new Promise((done) => { enteredA = done; });
  const included = (hash) => ({ status: "included", txHash: hash, payer: WALLET, payee: PAYEE, amountOs: AMOUNT, blockNumber: 10 });
  const chain = {
    network: "testnet", pinnedIdentity: CHAIN, rpcOrigin: "https://rpc.invalid", evidenceMode: "TEST-stub",
    networkIdentity: async () => ({ identity: CHAIN, mode: "public-chain-read" }),
    async observeTransfer(hash) {
      if (hash === A) { enteredA(); await gateA; return included(A); }
      return { status: "pending" };
    },
    getTransaction: async (hash) => ({ hash, status: "confirmed", blockNumber: 10, content: { from: WALLET, nonce: 7 } }),
  };
  const purchases = createPurchaseService({ db, config: {}, ops, coordinates, chain });
  const terms = {
    buyer: { wallet: WALLET }, seller: { payee: PAYEE, claim: "TEST-seller" }, price: { amountOs: AMOUNT, amount: "2.5" },
    listing: { listingId: "TEST-listing", version: 1, contentHash: CHAIN }, network: "testnet", rail: "demos-native:DEM",
    domain: { network: "testnet", rail: "demos-native:DEM", mode: "public-chain-read", chainIdentity: CHAIN },
  };
  const op = ops.createIdempotent({ accountId: "TEST-buyer", kind: "purchase", idempotencyKey: "TEST-stale", request: { name: "TEST-stale" }, status: "broadcast_reported",
    terms, termsHash: CHAIN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }).operation;
  coordinates.save({ operationId: op.id, kind: "native-dem-transfer", network: "testnet", from: WALLET, nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: AMOUNT, payload: { content: { nonce: 7 } } });
  assert.equal(coordinates.reportHash(op.id, A), true);
  return { op, ops, coordinates, purchases, releaseA, readingA,
    verify: (txHash) => purchases.verifyDeal({ accountId: "TEST-buyer", operationId: op.id, ...(txHash ? { txHash } : {}) }),
    state: () => ({ status: ops.get("TEST-buyer", op.id).status, ...coordinates.get(op.id) }) };
}

const safe = (s) => s.status !== "settled_verified" || s.reportedTxHash === s.observation?.txHash;
const describe = (s) => `status=${s.status} reportedTxHash=${s.reportedTxHash?.slice(0, 8)} observation.txHash=${s.observation?.txHash?.slice(0, 8)} verifiedAt=${Boolean(s.verifiedAt)}`;

test("the unobserved pointer moves to B while A is read; A completes last", { skip: SKIP }, async (t) => {
  const w = world(t);
  const pendingA = w.verify();
  await w.readingA;
  // The store step a concurrent verify_deal with B performs first.
  assert.equal(w.coordinates.replaceUnobservedHash(w.op.id, B), true);
  w.releaseA();
  await pendingA;
  const s = w.state();
  t.diagnostic(describe(s));
  assert.ok(safe(s), "UNSAFE: stale A verified the purchase while its pointer is B");
});

test("verify_deal(B) finishes first and records its pending read; A completes after", { skip: SKIP }, async (t) => {
  const w = world(t);
  const pendingA = w.verify();
  await w.readingA;
  const b = await w.verify(B);
  assert.equal(b.verification.outcome, "awaiting_inclusion");
  assert.equal(w.state().observation?.txHash, B);
  w.releaseA();
  await pendingA;
  const s = w.state();
  t.diagnostic(describe(s));
  assert.equal(s.observation?.txHash, B, "UNSAFE: stale A overwrote B's observation");
  assert.ok(safe(s), "UNSAFE: stale A verified the purchase while its pointer is B");
});
