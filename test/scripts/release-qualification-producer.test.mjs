import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  QualificationEvidenceError, createEvidencePublisher, nodeEvidenceFs,
} from "../../scripts/produce-qualification-manifest.mjs";
import { createEvidenceFsModel } from "./fixtures/evidence-fs-model.mjs";

const run = promisify(execFile);
const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../scripts/produce-qualification-manifest.mjs")).href;

const PARENT = "/work";
const EVIDENCE = "/work/evidence";
const INDEX = "/work/evidence/index";
const MANIFESTS = "/work/evidence/manifests";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const contentA = sha256("content a");
const contentB = sha256("content b");
const indexName = (id) => `${sha256(id)}.json`;
const indexBytes = (id, contentSha256) => Buffer.from(JSON.stringify({ id, contentSha256 }));

const scratch = [];
after(() => { for (const directory of scratch) rmSync(directory, { recursive: true, force: true }); });
function realEvidenceDirectory() {
  const parent = mkdtempSync(join(tmpdir(), "dacs-evidence-"));
  scratch.push(parent);
  return join(parent, "evidence");
}

function modelWithParent() {
  const model = createEvidenceFsModel();
  model.seedDirectory(PARENT);
  return model;
}
const publisherOn = (model, invocation) => createEvidencePublisher(model.fs, invocation);

async function modelWithDirectories() {
  const model = modelWithParent();
  await publisherOn(model, "setup").ensureDirectories(EVIDENCE);
  model.operations.length = 0;
  return model;
}

// After power loss a staging name whose removal was never synchronized can come back; it is a
// harmless leftover, so the checks look at final names only.
const finalNames = (model, directory) => model.listVisible(directory).filter((name) => !name.startsWith(".staging-"));

async function refusal(promise) {
  try { await promise; } catch (error) { return error; }
  return assert.fail("expected the call to refuse");
}

function assertRefusal(error, code, cause) {
  assert.ok(error instanceof QualificationEvidenceError, `expected QualificationEvidenceError, got ${error}`);
  assert.equal(error.code, code);
  if (cause !== undefined) assert.equal(error.cause, cause);
}

test("an index association is stored as one file per id named by the sha256 of the id", async () => {
  const model = await modelWithDirectories();
  const result = await publisherOn(model, "one").publishIndexAssociation(EVIDENCE, "result-id", contentA);
  assert.equal(result.outcome, "created");
  assert.deepEqual(model.listVisible(INDEX), [indexName("result-id")]);
  assert.deepEqual(JSON.parse(model.read(`${INDEX}/${indexName("result-id")}`)), { id: "result-id", contentSha256: contentA });
});

test("an entry is written to a staging file, synchronized, linked, the directory synchronized, then the staging file removed", async () => {
  const model = await modelWithDirectories();
  const result = await publisherOn(model, "invocation-a").publishExclusive(INDEX, "entry.json", Buffer.from("entry bytes"));
  const staging = `${INDEX}/.staging-invocation-a-0`;
  assert.equal(result.outcome, "created");
  assert.deepEqual(model.operations.map(({ operation, path }) => `${operation} ${path}`), [
    `open ${staging}`, `write ${staging}`, `fsync ${staging}`, `link ${INDEX}/entry.json`,
    `open ${INDEX}`, `fsync ${INDEX}`, `unlink ${staging}`,
  ]);
  assert.equal(model.operations.find(({ operation }) => operation === "open").flags, "wx");
  assert.equal(model.operations.find(({ operation }) => operation === "link").existing, staging);
  assert.deepEqual(model.listVisible(INDEX), ["entry.json"]);
});

test("publishing the same association again is an idempotent repeat", async () => {
  const model = await modelWithDirectories();
  const first = await publisherOn(model, "one").publishIndexAssociation(EVIDENCE, "result-id", contentA);
  const second = await publisherOn(model, "two").publishIndexAssociation(EVIDENCE, "result-id", contentA);
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "identical");
  assert.deepEqual(model.listVisible(INDEX), [indexName("result-id")]);
});

test("a second content under an existing result id is refused, also by a fresh producer process", async () => {
  const evidence = realEvidenceDirectory();
  const first = createEvidencePublisher(nodeEvidenceFs, "first");
  await first.ensureDirectories(evidence);
  await first.publishIndexAssociation(evidence, "result-id", contentA);
  const entryPath = join(evidence, "index", indexName("result-id"));
  const before = readFileSync(entryPath);

  const childSource = [
    "const [moduleUrl, evidence, id, contentSha256] = process.argv.slice(1);",
    "const { createEvidencePublisher, nodeEvidenceFs } = await import(moduleUrl);",
    "const publisher = createEvidencePublisher(nodeEvidenceFs);",
    "await publisher.ensureDirectories(evidence);",
    "try { console.log((await publisher.publishIndexAssociation(evidence, id, contentSha256)).outcome); }",
    "catch (error) { console.log(error.code ?? error.message); }",
  ].join("\n");
  const child = (contentSha256) => run(process.execPath, ["--input-type=module", "-e", childSource, moduleUrl, evidence, "result-id", contentSha256]);

  assert.equal((await child(contentB)).stdout.trim(), "result_content_changed");
  assert.deepEqual(readFileSync(entryPath), before);
  assert.equal((await child(contentA)).stdout.trim(), "identical");
});

test("two producers racing with conflicting content for one id: exactly one association wins, the other refuses, and no manifest admits the replacement", async () => {
  const evidence = realEvidenceDirectory();
  const producers = [
    { publisher: createEvidencePublisher(nodeEvidenceFs, "racer-a"), contentSha256: contentA },
    { publisher: createEvidencePublisher(nodeEvidenceFs, "racer-b"), contentSha256: contentB },
  ];
  await Promise.all(producers.map(({ publisher }) => publisher.ensureDirectories(evidence)));

  const outcomes = await Promise.allSettled(producers.map(async ({ publisher, contentSha256 }) => {
    await publisher.publishIndexAssociation(evidence, "result-id", contentSha256);
    await publisher.publishExclusive(join(evidence, "manifests"), `${contentSha256}.json`, Buffer.from(contentSha256));
  }));

  const winners = outcomes.flatMap((outcome, position) => outcome.status === "fulfilled" ? [position] : []);
  const losers = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assertRefusal(losers[0], "result_content_changed");
  const winning = producers[winners[0]].contentSha256;
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, "index", indexName("result-id")))), { id: "result-id", contentSha256: winning });
  assert.deepEqual(readdirSync(join(evidence, "manifests")), [`${winning}.json`]);
});

test("different content under an existing name is reported and the existing entry is left as it was", async () => {
  const model = await modelWithDirectories();
  await publisherOn(model, "one").publishExclusive(MANIFESTS, "entry.json", Buffer.from("first bytes"));
  const result = await publisherOn(model, "two").publishExclusive(MANIFESTS, "entry.json", Buffer.from("other bytes"));
  assert.equal(result.outcome, "different");
  assert.equal(model.read(`${MANIFESTS}/entry.json`).toString(), "first bytes");
  assert.deepEqual(model.listVisible(MANIFESTS), ["entry.json"]);
});

test("an existing entry is read with a limit one byte above the new entry's size", async () => {
  const model = await modelWithDirectories();
  model.seedFile(`${MANIFESTS}/entry.json`, Buffer.alloc(1024 * 1024, 0x61));
  const bytes = Buffer.from("new bytes");
  const result = await publisherOn(model, "one").publishExclusive(MANIFESTS, "entry.json", bytes);
  assert.equal(result.outcome, "different");
  assert.equal(model.operations.find(({ operation }) => operation === "readFile").limit, bytes.length + 1);
});

test("an index entry that is not this producer's own shape refuses with evidence_write_failed and is left in place", async () => {
  const model = await modelWithDirectories();
  const entry = `${INDEX}/${indexName("result-id")}`;
  model.seedFile(entry, Buffer.from("not json at all"));
  const error = await refusal(publisherOn(model, "one").publishIndexAssociation(EVIDENCE, "result-id", contentA));
  assertRefusal(error, "evidence_write_failed");
  assert.equal(model.read(entry).toString(), "not json at all");
});

test("an identical entry that another producer linked and has not synchronized is synchronized by this producer before it returns", async () => {
  const model = await modelWithDirectories();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const atPause = new Promise((resolve) => { reached = resolve; });
  model.intercept = async (operation, path, details) => {
    if (operation === "open" && path === INDEX && details.flags === "r" && model.operations.some((entry) => entry.operation === "link")) {
      model.intercept = undefined;
      reached();
      await gate;
    }
  };
  const producerA = publisherOn(model, "producer-a").publishIndexAssociation(EVIDENCE, "result-id", contentA);
  await atPause;

  const second = await publisherOn(model, "producer-b").publishIndexAssociation(EVIDENCE, "result-id", contentA);
  assert.equal(second.outcome, "identical");
  model.powerLoss();
  assert.deepEqual(finalNames(model, INDEX), [indexName("result-id")]);
  assert.deepEqual(JSON.parse(model.read(`${INDEX}/${indexName("result-id")}`)), { id: "result-id", contentSha256: contentA });
  release();
  producerA.catch(() => {});
});

test("a second producer started while the first is staging leaves the first's temporary untouched, and each invocation removes only its own temporaries", async () => {
  const model = await modelWithDirectories();
  model.seedFile(`${INDEX}/.staging-crashed-run-0`, Buffer.from("left by a crashed run"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const atPause = new Promise((resolve) => { reached = resolve; });
  model.intercept = async (operation, path) => {
    if (operation === "fsync" && path.includes(".staging-first-")) { reached(); await gate; }
  };
  const first = publisherOn(model, "first").publishIndexAssociation(EVIDENCE, "first-id", contentA);
  await atPause;

  await publisherOn(model, "second").publishIndexAssociation(EVIDENCE, "second-id", contentB);
  assert.deepEqual(model.listVisible(INDEX), [".staging-crashed-run-0", ".staging-first-0", indexName("second-id")].sort());

  release();
  await first;
  assert.deepEqual(model.listVisible(INDEX), [".staging-crashed-run-0", indexName("first-id"), indexName("second-id")].sort());
  assert.equal(model.read(`${INDEX}/.staging-crashed-run-0`).toString(), "left by a crashed run");
  assert.ok(!model.operations.some(({ path, existing }) => path.includes("crashed-run") || existing?.includes("crashed-run")));
});

test("a failed publication removes its own temporary", async () => {
  const model = await modelWithDirectories();
  const injected = Object.assign(new Error("link refused"), { code: "EPERM" });
  model.intercept = (operation) => { if (operation === "link") throw injected; };
  await refusal(publisherOn(model, "one").publishExclusive(INDEX, "entry.json", Buffer.from("bytes")));
  assert.deepEqual(model.listVisible(INDEX), []);
});

test("an entry is refused with its cause when the staging file cannot be created, written, linked or the existing entry read", async () => {
  const injected = Object.assign(new Error("injected failure"), { code: "EIO" });
  const cases = [
    ["open", (operation, path, details) => operation === "open" && details.flags === "wx"],
    ["write", (operation) => operation === "write"],
    ["link", (operation) => operation === "link"],
  ];
  for (const [label, matches] of cases) {
    const model = await modelWithDirectories();
    model.intercept = (operation, path, details) => { if (matches(operation, path, details)) throw injected; };
    const error = await refusal(publisherOn(model, "one").publishExclusive(INDEX, "entry.json", Buffer.from("bytes")));
    assertRefusal(error, "evidence_write_failed", injected);
    assert.deepEqual(model.listVisible(INDEX), [], `nothing is published when ${label} fails`);
  }

  const model = await modelWithDirectories();
  model.seedFile(`${INDEX}/entry.json`, Buffer.from("bytes"));
  model.intercept = (operation) => { if (operation === "readFile") throw injected; };
  assertRefusal(await refusal(publisherOn(model, "one").publishExclusive(INDEX, "entry.json", Buffer.from("bytes"))), "evidence_write_failed", injected);
});

test("a directory that cannot be created refuses with evidence_write_failed and its cause", async () => {
  const model = modelWithParent();
  const injected = Object.assign(new Error("no space"), { code: "ENOSPC" });
  model.intercept = (operation) => { if (operation === "mkdir") throw injected; };
  assertRefusal(await refusal(publisherOn(model, "one").ensureDirectories(EVIDENCE)), "evidence_write_failed", injected);
});

test("a failed fsync on the staging file, the target directory or a parent refuses with evidence_sync_failed and its cause", async () => {
  const injected = Object.assign(new Error("fsync failed"), { code: "EIO" });
  const publishCases = [
    ["the staging file", (path) => path.includes(".staging-")],
    ["the target directory", (path) => path === INDEX],
  ];
  for (const [label, matches] of publishCases) {
    const model = await modelWithDirectories();
    model.intercept = (operation, path) => { if (operation === "fsync" && matches(path)) throw injected; };
    const error = await refusal(publisherOn(model, "one").publishIndexAssociation(EVIDENCE, "result-id", contentA));
    assertRefusal(error, "evidence_sync_failed", injected);
    assert.ok(!model.listVisible(INDEX).some((name) => name.startsWith(".staging-")), `own temporary removed when ${label} fails`);
  }

  const model = modelWithParent();
  model.intercept = (operation, path) => { if (operation === "fsync" && path === PARENT) throw injected; };
  assertRefusal(await refusal(publisherOn(model, "one").ensureDirectories(EVIDENCE)), "evidence_sync_failed", injected);
});

test("ensuring the evidence directories synchronizes each parent after creating the directory", async () => {
  const model = modelWithParent();
  await publisherOn(model, "one").ensureDirectories(EVIDENCE);
  const sequence = model.operations
    .filter(({ operation }) => operation === "mkdir" || operation === "fsync")
    .map(({ operation, path }) => `${operation} ${path}`);
  assert.deepEqual(sequence, [
    `mkdir ${EVIDENCE}`, `fsync ${PARENT}`,
    `mkdir ${INDEX}`, `fsync ${EVIDENCE}`,
    `mkdir ${MANIFESTS}`, `fsync ${EVIDENCE}`,
  ]);
});

test("power loss after creating a directory and before its parent sync never loses an entry published afterwards; a rerun synchronizes a directory an earlier run left unsynchronized", async () => {
  // The evidence, index and manifests directories each have a parent synchronization; die before each.
  for (const dyingSync of [1, 2, 3]) {
    const model = modelWithParent();
    let syncs = 0;
    model.intercept = (operation, path, details) => {
      if (operation === "open" && details.flags === "r" && ++syncs === dyingSync) throw model.kill();
    };
    await refusal(publisherOn(model, "earlier").ensureDirectories(EVIDENCE));
    model.restart();
    model.intercept = undefined;

    const rerun = publisherOn(model, "rerun");
    await rerun.ensureDirectories(EVIDENCE);
    await rerun.publishIndexAssociation(EVIDENCE, "result-id", contentA);
    model.powerLoss();
    assert.deepEqual(finalNames(model, INDEX), [indexName("result-id")], `died before parent sync ${dyingSync}`);
    assert.deepEqual(model.listVisible(EVIDENCE), ["index", "manifests"], `died before parent sync ${dyingSync}`);
  }
});

test("a restart after each publication cut leaves no partial entry and no replaced association, and the rerun completes", async () => {
  const expected = indexBytes("result-id", contentA);
  const entryPath = `${INDEX}/${indexName("result-id")}`;
  const counting = await modelWithDirectories();
  await publisherOn(counting, "count").publishIndexAssociation(EVIDENCE, "result-id", contentA);
  const operationCount = counting.operations.length;
  assert.ok(operationCount >= 7);

  for (let cut = 1; cut <= operationCount; cut += 1) {
    for (const lostPower of [false, true]) {
      const model = await modelWithDirectories();
      let seen = 0;
      model.intercept = () => { seen += 1; if (seen === cut) throw model.kill(); };
      // A kill during the last step (removing the temporary) does not fail the publication.
      await publisherOn(model, "crashed").publishIndexAssociation(EVIDENCE, "result-id", contentA).catch(() => {});
      if (lostPower) model.powerLoss(); else model.restart();
      model.intercept = undefined;
      const label = `cut ${cut}, ${lostPower ? "power loss" : "process death"}`;

      const names = model.listVisible(INDEX);
      if (names.includes(indexName("result-id"))) assert.deepEqual(model.read(entryPath), expected, `${label}: no partial entry`);

      const rerun = await publisherOn(model, "rerun").publishIndexAssociation(EVIDENCE, "result-id", contentA);
      assert.ok(["created", "identical"].includes(rerun.outcome), label);
      assert.deepEqual(model.read(entryPath), expected, label);
      const other = await refusal(publisherOn(model, "other").publishIndexAssociation(EVIDENCE, "result-id", contentB));
      assertRefusal(other, "result_content_changed");
      assert.deepEqual(model.read(entryPath), expected, `${label}: association not replaced`);
    }
  }
});

test("the production file operations publish, refuse an existing name and read at most the given limit", async () => {
  const evidence = realEvidenceDirectory();
  const publisher = createEvidencePublisher(nodeEvidenceFs, "production");
  await publisher.ensureDirectories(evidence);
  await publisher.ensureDirectories(evidence);
  const directory = join(evidence, "manifests");

  assert.equal((await publisher.publishExclusive(directory, "entry.json", Buffer.from("first bytes"))).outcome, "created");
  assert.equal((await publisher.publishExclusive(directory, "entry.json", Buffer.from("first bytes"))).outcome, "identical");
  assert.equal((await publisher.publishExclusive(directory, "entry.json", Buffer.from("other bytes"))).outcome, "different");
  assert.equal(readFileSync(join(directory, "entry.json"), "utf8"), "first bytes");
  assert.deepEqual(readdirSync(directory), ["entry.json"]);

  writeFileSync(join(evidence, "large.bin"), Buffer.alloc(4096, 0x62));
  assert.equal((await nodeEvidenceFs.readFile(join(evidence, "large.bin"), 10)).length, 10);
  mkdirSync(join(evidence, "folder"));
  await assert.rejects(nodeEvidenceFs.readFile(join(evidence, "folder"), 10));
});
