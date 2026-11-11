import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);
const scriptsDirectory = new URL("../../scripts/", import.meta.url);
const workflow = parse(readFileSync(new URL("package-artifact.yml", workflowsDirectory), "utf8"));
const ci = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const release = workflow.jobs["release-packages"];
const step = run => {
  const matches = release?.steps.filter(step => step.run === run) ?? [];
  assert.equal(matches.length, 1, `expected one step running ${run}`);
  return matches[0];
};

test("required build CI runs the workflow contract regression", () => {
  // build-test-main holds every build-test step except the sharded seller and client suites (build-test).
  const contract = ci.jobs["build-test-main"].steps.find(step => step.run === "node --test test/scripts/release-workflow.test.mjs");
  assert.ok(contract);
  assert.equal(contract.if, undefined);
  assert.ok(!contract["continue-on-error"]);
});

test("build CI runs on pushes to main and phase0-completion only", () => {
  assert.deepEqual(ci.on.push.branches, ["main", "phase0-completion"]);
});

test("build CI builds the Node host kit before any step that runs the client tests", () => {
  const steps = ci.jobs["build-test"].steps;
  const hostBuild = steps.findIndex(step => step.run === "npm run host:build");
  assert.notEqual(hostBuild, -1);
  const clientTests = steps.flatMap((step, index) => /npm test --workspace @kynesyslabs\/dacs-client\b|node scripts\/run-client-tests\.mjs/.test(step.run ?? "") ? [index] : []);
  assert.ok(clientTests.length > 0);
  for (const index of clientTests) assert.ok(hostBuild < index, `"${steps[index].name}" runs before the Node host kit is built`);
});

test("required build CI builds the Node host kit before it prepares the seller consumer", () => {
  const runs = ci.jobs["build-test"].steps.map(step => step.run);
  const hostBuild = runs.indexOf("npm run host:build");
  assert.ok(hostBuild >= 0);
  assert.ok(hostBuild < runs.findIndex(run => run?.startsWith("npm run seller:prepare")));
  assert.ok(hostBuild < runs.indexOf("npm run seller:test"));
});

test("main, pull requests and merge queues prepare on both pinned Node versions", () => {
  for (const event of ["push", "pull_request", "merge_group", "workflow_dispatch"]) assert.ok(Object.hasOwn(workflow.on, event));
  assert.ok(workflow.on.push.branches.includes("main"));
  assert.ok(release);
  assert.equal(release.if, undefined);
  assert.ok(!release["continue-on-error"]);
  assert.equal(release.strategy["fail-fast"], false);
  assert.deepEqual(release.strategy.matrix["node-version"], ["22.22.2", "24.15.0"]);
  const setup = release.steps.find(step => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(setup.with["node-version"], "${{ matrix.node-version }}");
  assert.equal(release.steps.find(step => step.name === "Pin release npm client").if, undefined);
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

const workflows = readdirSync(workflowsDirectory).filter(name => name.endsWith(".yml"))
  .map(name => ({ name, jobs: parse(readFileSync(new URL(name, workflowsDirectory), "utf8")).jobs }));
const pinsNpm = line => /\bnpm (?:install|i)\b/.test(line) && /\s(?:-g|--global)\b/.test(line) && /\snpm@/.test(line);

// A global install of npm over the npm that is running it fails midway with
// the npm bundled in Node 22.22.2, so every pin must install to its own prefix.
test("no workflow or shell script installs npm over the running npm", () => {
  const sources = [
    ...workflows.flatMap(({ name, jobs }) => Object.values(jobs).flatMap(job => (job.steps ?? []).map(step => [name, step.run ?? ""]))),
    ...readdirSync(scriptsDirectory).filter(name => name.endsWith(".sh"))
      .map(name => [`scripts/${name}`, readFileSync(new URL(name, scriptsDirectory), "utf8")]),
  ];
  const pins = sources.flatMap(([name, text]) => text.split("\n").filter(pinsNpm).map(line => [name, line.trim()]));
  assert.ok(pins.length >= 4);
  for (const [name, line] of pins) assert.match(line, /\s--prefix\s/, `${name}: ${line}`);
});

test("every workflow job that pins npm checks the pinned version in the next step", () => {
  let checked = 0;
  for (const { name, jobs } of workflows) for (const [id, job] of Object.entries(jobs)) {
    const steps = job.steps ?? [];
    steps.forEach((step, index) => {
      if (!(step.run ?? "").split("\n").some(pinsNpm)) return;
      assert.match(steps[index + 1]?.run ?? "", /test "\$\(npm --version\)" = 11\.19\.0/, `${name} ${id}`);
      checked += 1;
    });
  }
  assert.equal(checked, 3);
});
