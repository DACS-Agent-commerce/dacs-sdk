import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REGISTRY_ORIGIN } from "../../scripts/registry-release-reader.mjs";
import {
  CLIENT, CLOCK_START_MS, CORE, FIVE, GENERATOR, HOST, PLANNED, SELLER, publish, publisherFixture, updateRegistry,
} from "./fixtures/publisher-harness.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PUBLISH_JOB_TIMEOUT_MS = 45 * MINUTE;
const PUBLISH_JOB_RESERVE_MS = 2 * MINUTE;
const COMMAND_AND_WINDOW_MS = 300 * SECOND + MINUTE;
const STALE_TAG_REGISTRY = { tags: { [CORE]: "0.0.9" } };
// The budget a run has used when `leftMs` of it remain before the publisher's own deadline.
const budgetUsedLeaving = (leftMs) => PUBLISH_JOB_TIMEOUT_MS - PUBLISH_JOB_RESERVE_MS - leftMs;

test("interruption after each of the five packages resumes by skipping exact versions and publishing the rest once", () => {
  for (let published = 1; published <= FIVE.length; published += 1) {
    const existing = Object.fromEntries(FIVE.slice(0, published).map((name) => [name, "same"]));
    const result = publish(publisherFixture({ existing }));
    assert.equal(result.status, 0, `after ${published}: ${result.output}`);
    assert.deepEqual(result.publishedNames, FIVE.slice(published), `after ${published}`);
    assert.match(result.output, new RegExp(`all five packages are at ${PLANNED} with next`));
  }
});

test("a lost publish acknowledgement is reconciled by readback and not published again", () => {
  const result = publish(publisherFixture({ modes: { [HOST]: "ack-lost" } }));
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.publishedNames, FIVE);
  assert.match(result.output, /@kynesyslabs\/dacs-node@0\.1\.0-alpha\.1 published and verified after npm publish failed/);
});

test("a hung publish subprocess is killed at its deadline, and the run stops with publish_outcome_unknown while readback stays absent", () => {
  const fixture = publisherFixture({ modes: { [CORE]: "hang" } });
  const result = publish(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /publish_outcome_unknown/);
  assert.match(result.output, /@kynesyslabs\/dacs\b/);
  assert.match(result.output, /timed out/);
  assert.deepEqual(result.publishedNames, [CORE]);
  const hungPid = Number(readFileSync(join(fixture.directory, "hung.pid"), "utf8"));
  assert.throws(() => process.kill(hungPid, 0), { code: "ESRCH" });
});

test("after publish_outcome_unknown, the rerun finds the version and continues without a second publish", () => {
  const fixture = publisherFixture({ modes: { [CORE]: "hang" } });
  const first = publish(fixture);
  assert.match(first.output, /publish_outcome_unknown/);
  // The hung publish did land after the run stopped: the registry now shows it.
  updateRegistry(fixture, (registry) => { registry.releases[CORE] = fixture.receipts[CORE].integrity; });
  const second = publish(fixture);
  assert.equal(second.status, 0, second.output);
  // The stub's log keeps both runs: the first run's one call, then the other four packages.
  assert.deepEqual(second.publishedNames, [CORE, ...FIVE.slice(1)]);
});

test("a conflicting existing integrity on any package refuses before the first publish", () => {
  for (const name of FIVE) {
    const result = publish(publisherFixture({ existing: { [name]: "other" } }));
    assert.notEqual(result.status, 0, name);
    assert.match(result.output, new RegExp(`existing_release_conflict for ${name.replaceAll("/", "\\/")}:`));
    assert.deepEqual(result.npmCalls, [], name);
  }
});

test("a version visible only after several polls is accepted", () => {
  const result = publish(publisherFixture({ registry: { hiddenReads: { [HOST]: 4 } } }));
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.publishedNames, FIVE);
  assert.equal(result.fetchCalls.filter((url) => url.endsWith(`/%40kynesyslabs%2Fdacs-node/${PLANNED}`)).length >= 5, true);
});

test("next must resolve to the version for all five before exit 0", () => {
  const result = publish(publisherFixture({ existing: { [CORE]: "same" } }));
  assert.equal(result.status, 0, result.output);
  // The last reads before exit 0 re-read all five, resumed one included: the version document and next.
  const sweep = result.fetchCalls.slice(-2 * FIVE.length);
  for (const name of FIVE) {
    assert.ok(sweep.includes(`${REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${PLANNED}`), `final read of ${name}`);
    assert.ok(sweep.includes(`${REGISTRY_ORIGIN}/${encodeURIComponent(name)}`), `final tag read of ${name}`);
  }
  const stuck = publish(publisherFixture({ registry: { tags: { [SELLER]: "0.0.9" } } }));
  assert.notEqual(stuck.status, 0);
  assert.match(stuck.output, /dist_tag_conflict/);
  assert.deepEqual(stuck.publishedNames, FIVE.slice(0, 4), "nothing is published after a package whose next did not resolve");
});

test("next pointing at another version refuses with dist_tag_conflict and moves no tag", () => {
  const result = publish(publisherFixture({ existing: { [CORE]: "same" }, registry: STALE_TAG_REGISTRY }));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /dist_tag_conflict/);
  assert.match(result.output, /@kynesyslabs\/dacs\b/);
  assert.match(result.output, /0\.0\.9/);
  assert.deepEqual(result.npmCalls, []);
});

test("the aggregate deadline stops the run with its own cause before the job limit", () => {
  const result = publish(publisherFixture({ existing: { [CORE]: "same" }, registry: STALE_TAG_REGISTRY }), {}, { budgetUsedMs: budgetUsedLeaving(30 * SECOND) });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /publish_budget_exhausted/);
  assert.ok(result.clockEndMs <= CLOCK_START_MS + 30 * SECOND, `stopped at +${result.clockEndMs - CLOCK_START_MS} ms`);
  assert.deepEqual(result.npmCalls, []);
});

test("every refusal names the package and keeps the registry cause", () => {
  const refusals = [
    [{ readStatus: { [CLIENT]: 403 } }, /registry_refused/, /403/],
    [{ readStatus: { [CLIENT]: 503 } }, /registry_unavailable/, /503/],
    [{ readStatus: { [CLIENT]: 302 } }, /registry_redirect_refused/, /302/],
  ];
  for (const [registry, code, cause] of refusals) {
    const result = publish(publisherFixture({ registry }));
    assert.notEqual(result.status, 0);
    assert.match(result.output, code);
    assert.match(result.output, /@kynesyslabs\/dacs-client/);
    assert.match(result.output, cause);
    assert.deepEqual(result.npmCalls, [], "preflight stops before any publish");
  }
});

test("a registry read that fails after a failed publish is reported as publish_outcome_unknown with the read error as cause", () => {
  const fixture = publisherFixture({ modes: { [HOST]: "auth" }, registry: { readStatusAfterPublish: { [HOST]: 503 } } });
  const result = publish(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /publish_outcome_unknown for @kynesyslabs\/dacs-node/);
  assert.match(result.output, /\[cause\]: ReleaseError: registry_unavailable/);
  assert.equal(result.publishedNames.filter((name) => name === HOST).length, 1);
});

test("a conflicting next on the last already-existing package refuses with zero publish calls, while earlier packages are still missing", () => {
  const result = publish(publisherFixture({ existing: { [GENERATOR]: "same" }, registry: { tags: { [GENERATOR]: "0.0.9" } } }));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /dist_tag_conflict/);
  assert.match(result.output, /create-dacs-agent/);
  assert.deepEqual(result.npmCalls, []);
});

test("a next tag that is stale for several polls is accepted once it resolves, and no tag command is ever run", () => {
  const result = publish(publisherFixture({ existing: { [CORE]: "same" }, registry: { staleTagReads: { [CORE]: 3 } } }));
  assert.equal(result.status, 0, result.output);
  assert.equal(result.fetchCalls.filter((url) => url === `https://registry.npmjs.org/${encodeURIComponent(CORE)}`).length >= 4, true);
  assert.equal(result.npmCalls.some((call) => /dist-tag/.test(call)), false);
  assert.ok(result.npmCalls.every((call) => call.startsWith("publish ")));
});

test("with most of the job budget used before entry, the publisher stops with publish_budget_exhausted before the outer timeout", () => {
  // Each publish takes 29 hidden polls, 58 s of virtual time. Starting a publish needs 360 s: three fit in 500 s.
  const registry = { hiddenReads: Object.fromEntries(FIVE.map((name) => [name, 29])) };
  const result = publish(publisherFixture({ registry }), {}, { budgetUsedMs: budgetUsedLeaving(500 * SECOND) });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /publish_budget_exhausted/);
  assert.deepEqual(result.publishedNames, FIVE.slice(0, 3));
  assert.ok(result.clockEndMs <= CLOCK_START_MS + 500 * SECOND);
});

test("a publish is not started when the time left cannot hold its command and reconciliation windows; with too little at entry, zero publish calls", () => {
  const tooLittle = publish(publisherFixture(), {}, { budgetUsedMs: budgetUsedLeaving(COMMAND_AND_WINDOW_MS - 1) });
  assert.notEqual(tooLittle.status, 0);
  assert.match(tooLittle.output, /publish_budget_exhausted/);
  assert.deepEqual(tooLittle.npmCalls, []);
  const enough = publish(publisherFixture(), {}, { budgetUsedMs: budgetUsedLeaving(COMMAND_AND_WINDOW_MS) });
  assert.equal(enough.status, 0, enough.output);
  assert.deepEqual(enough.publishedNames, FIVE);
});

test("a missing, malformed or future --job-started-at refuses before any registry read", () => {
  for (const jobStartedAt of [null, "", "yesterday", "-5", "1.5", String(CLOCK_START_MS + 1)]) {
    const result = publish(publisherFixture(), {}, { jobStartedAt });
    assert.notEqual(result.status, 0, String(jobStartedAt));
    assert.match(result.output, /job start|usage/i);
    assert.deepEqual(result.fetchCalls, []);
    assert.deepEqual(result.npmCalls, []);
  }
});

test("every subprocess timeout, poll window and retry is clamped to the time left; PUBLISH_JOB_TIMEOUT_MS equals the workflow's timeout-minutes", () => {
  const left = 45 * SECOND;
  const clamped = publish(publisherFixture({ existing: { [CORE]: "same" }, registry: STALE_TAG_REGISTRY }), {}, { budgetUsedMs: budgetUsedLeaving(left) });
  assert.ok(clamped.timers.length > 0);
  assert.ok(clamped.timers.every((delay) => delay <= left), `timers ${clamped.timers}`);
  assert.equal(clamped.timers.reduce((total, delay) => total + delay, 0) <= left, true);
  const hung = publish(publisherFixture({ modes: { [CORE]: "hang" } }));
  assert.ok(hung.timers.includes(300 * SECOND), `timers ${hung.timers}`);

  const source = readFileSync(join(repoRoot, "scripts/publish-release-set.mjs"), "utf8");
  const workflow = readFileSync(join(repoRoot, ".github/workflows/publish-prerelease-gated.yml"), "utf8");
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));
  const constant = /const PUBLISH_JOB_TIMEOUT_MS = (\d+) \* 60 \* 1000;/.exec(source);
  assert.equal(Number(constant[1]), Number(/timeout-minutes: (\d+)/.exec(publishJob)[1]));
  assert.match(publishJob, /steps:\n {6}- name: Record the publish job start\n/);
  assert.match(publishJob, /--job-started-at "\$DACS_PUBLISH_JOB_STARTED_AT"/);
});

test("an npm publish that fails authentication keeps npm's error as the cause; readback stays absent, the run stops with publish_outcome_unknown, and npm publish is called once", () => {
  const result = publish(publisherFixture({ modes: { [CORE]: "auth" } }));
  assert.notEqual(result.status, 0);
  assert.match(result.output, /publish_outcome_unknown/);
  assert.match(result.output, /ENEEDAUTH/);
  assert.equal(result.npmCalls.length, 1);
});
