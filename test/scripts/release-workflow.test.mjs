import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../.github/workflows/package-artifact.yml", import.meta.url), "utf8"));
const ci = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const release = workflow.jobs["release-packages"];
const step = run => {
  const matches = release?.steps.filter(step => step.run === run) ?? [];
  assert.equal(matches.length, 1, `expected one step running ${run}`);
  return matches[0];
};

test("required build CI runs the workflow contract regression", () => {
  const contract = ci.jobs["build-test"].steps.find(step => step.run === "node --test test/scripts/release-workflow.test.mjs");
  assert.ok(contract);
  assert.equal(contract.if, undefined);
  assert.ok(!contract["continue-on-error"]);
});

test("main, pull requests and merge queues prepare on both pinned Node versions", () => {
  for (const event of ["push", "pull_request", "merge_group", "workflow_dispatch"]) assert.ok(Object.hasOwn(workflow.on, event));
  assert.ok(workflow.on.push.branches.includes("main"));
  assert.ok(release);
  assert.equal(release.if, undefined);
  assert.ok(!release["continue-on-error"]);
  assert.equal(release.strategy["fail-fast"], false);
  assert.deepEqual(release.strategy.matrix["node-version"], ["20.19.0", "22.21.1"]);
  const setup = release.steps.find(step => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(setup.with["node-version"], "${{ matrix.node-version }}");
  assert.equal(step("npm install --global --ignore-scripts npm@11.19.0").if, undefined);
  assert.equal(step("npm ci --ignore-scripts --no-audit --no-fund").id, "install");
  assert.equal(step("npm ci --ignore-scripts --no-audit --no-fund").if, undefined);
  assert.equal(step("npm run release:test").if, undefined);
  assert.ok(!step("npm run release:test")["continue-on-error"]);
});

test("strict admission is mandatory only during manual rehearsals", () => {
  const strict = step("npm run release:check");
  assert.equal(strict.if, "github.event_name == 'workflow_dispatch'");
  assert.ok(!strict["continue-on-error"]);
  assert.ok(release.steps.indexOf(step("npm run release:test")) < release.steps.indexOf(strict));
});

test("failed manual checks retain evidence and still prepare unless cancelled", () => {
  const strict = step("npm run release:check");
  const upload = release.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(upload);
  // An explicit status function overrides GitHub's implicit success() guard.
  assert.equal(upload.if, "${{ !cancelled() && github.event_name == 'workflow_dispatch' }}");
  assert.equal(upload.with.path, "package-artifacts/five-package/");
  assert.equal(upload.with.name, "five-package-consumers-node-${{ matrix.node-version }}");
  assert.equal(upload.with["if-no-files-found"], "warn");
  const preparation = step("npm run release:dry-run");
  assert.equal(preparation.if, "${{ !cancelled() && steps.install.outcome == 'success' }}");
  assert.ok(!preparation["continue-on-error"]);
  assert.ok(release.steps.indexOf(strict) < release.steps.indexOf(upload));
  assert.ok(release.steps.indexOf(upload) < release.steps.indexOf(preparation));
});
