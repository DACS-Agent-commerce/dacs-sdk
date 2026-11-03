import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runBash, stubBin, workflowStepScript } from "./helpers/workflow.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const workflowsDirectory = join(repoRoot, ".github/workflows");
const gatedPath = join(workflowsDirectory, "publish-prerelease-gated.yml");
const POLICY_PACKAGES = (JSON.parse(readFileSync(join(repoRoot, "scripts/release-policy.json"), "utf8")) as
  { packages: { name: string; directory: string }[] }).packages;
const VERSION = "0.1.0-alpha.1";

type Step = { name?: string; run?: string; if?: string };
type Job = { steps?: Step[]; strategy?: { matrix?: { "node-version"?: string[] } } };
type Workflow = { concurrency?: unknown; jobs: Record<string, Job> };
const readWorkflow = (path: string) => parse(readFileSync(path, "utf8")) as Workflow;
const gated = readWorkflow(gatedPath);
const publishSteps = gated.jobs.publish?.steps ?? [];

// Each non-comment line of every step's `run`, in step order.
const commandsOf = (steps: Step[]) => steps.flatMap((step) =>
  (step.run ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#")));
const isInOrder = (commands: string[], expected: string[]) => {
  let from = 0;
  for (const command of expected) {
    const at = commands.indexOf(command, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
};

const scratch: string[] = [];
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// A checkout holding the real policy and one manifest per policy directory.
function checkoutWithManifests(change: (name: string, manifest: Record<string, unknown>) => Record<string, unknown>) {
  const checkout = mkdtempSync(join(tmpdir(), "dacs-gated-admission-"));
  scratch.push(checkout);
  mkdirSync(join(checkout, "scripts"));
  copyFileSync(join(repoRoot, "scripts/release-policy.json"), join(checkout, "scripts/release-policy.json"));
  for (const { name, directory } of POLICY_PACKAGES) {
    mkdirSync(join(checkout, directory), { recursive: true });
    const manifest = { name, version: VERSION, publishConfig: { access: "public", provenance: true } };
    writeFileSync(join(checkout, directory, "package.json"), JSON.stringify(change(name, manifest)));
  }
  return checkout;
}

function runAdmission(checkout: string) {
  const script = workflowStepScript("Admit reviewed main-line prerelease tag", gatedPath);
  const PATH = stubBin(checkout, { git: "exit 0" });
  return runBash(["-e", "-c", script], { cwd: checkout, env: {
    PATH, CONFIRM_VERSION: VERSION, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${VERSION}`, GITHUB_SHA: "0".repeat(40) } });
}

describe("the gated publish workflow", () => {
  it("the gated workflow's admission step accepts five matching manifests", () => {
    expect(runAdmission(checkoutWithManifests((_, manifest) => manifest)).status).toBe(0);
  });

  it("the gated workflow's admission step refuses when any one of the five has another version or publish policy", () => {
    const mutations: Record<string, (manifest: Record<string, unknown>) => Record<string, unknown>> = {
      "another version": (manifest) => ({ ...manifest, version: "0.1.0-alpha.2" }),
      "no publish policy": ({ publishConfig: _removed, ...manifest }) => manifest,
      "no provenance": (manifest) => ({ ...manifest, publishConfig: { access: "public" } }),
    };
    expect(POLICY_PACKAGES).toHaveLength(5);
    for (const { name: damaged } of POLICY_PACKAGES) {
      for (const [label, mutate] of Object.entries(mutations)) {
        const result = runAdmission(checkoutWithManifests((name, manifest) => (name === damaged ? mutate(manifest) : manifest)));
        expect(result.status, `${damaged}: ${label}`).not.toBe(0);
      }
    }
  });

  it("the gated workflow requires a clean build tree after npm ci, builds core, dacs-node and the generator, runs all five packages' suites and then release:test, before building the release set", () => {
    const commands = commandsOf(publishSteps);
    expect(isInOrder(commands, [
      "npm ci",
      "test ! -e dist", "test ! -e packages/dacs-node/dist", "test ! -e packages/create-dacs-agent/dist",
      "npm run build", "npm run host:build", "npm run generator:build",
      "npm test", "npm run host:test", "npm run generator:test",
      "npm test --workspace @kynesyslabs/dacs-client",
      "npm run seller:prepare -- \"$DACS_SELLER_SMOKE_DIR\"", "npm run seller:test",
      "npm run release:test",
      "npm run release:set:verify -- --output-dir package-artifacts/release-set --strict",
    ])).toBe(true);
    expect(commands.indexOf("npm run release:test")).toBeLessThan(commands.indexOf("node scripts/publish-release-set.mjs --artifact-dir package-artifacts/release-set --tag next"));
  });

  it("the gated workflow keeps one publication at a time", () => {
    expect(gated.concurrency).toEqual({ group: "dacs-npm-prerelease", "cancel-in-progress": false });
  });
});

describe("code ownership", () => {
  it("CODEOWNERS covers release-checks, release-policy and release-identity", () => {
    const owners = readFileSync(join(repoRoot, ".github/CODEOWNERS"), "utf8").split("\n");
    for (const path of ["scripts/release-checks.mjs", "scripts/release-policy.json", "scripts/release-identity.mjs"]) {
      expect(owners, path).toContain(`/${path} @randomblocker`);
    }
  });
});

const RELEASE_SUITE =/npm run release:(?:qualification:)?test(?![:\w-])/u;
const CLEAN_TREE_AND_BUILDS = [
  "test ! -e dist", "test ! -e packages/dacs-node/dist", "test ! -e packages/create-dacs-agent/dist",
  "npm run build", "npm run host:build", "npm run generator:build",
];
const workflowFiles = () => readdirSync(workflowsDirectory).filter((name) => name.endsWith(".yml"));

describe("every workflow", () => {
  it("in every workflow job that runs release:test or release:qualification:test, a clean-tree check and the three builds run first in that job; package-artifact's release-packages job does so on both matrix legs", () => {
    const callers: string[] = [];
    for (const file of workflowFiles()) {
      for (const [id, job] of Object.entries(readWorkflow(join(workflowsDirectory, file)).jobs)) {
        const steps = job.steps ?? [];
        const suiteAt = steps.findIndex((step) => RELEASE_SUITE.test(step.run ?? ""));
        if (suiteAt < 0) continue;
        callers.push(`${file}:${id}`);
        const before = steps.slice(0, suiteAt);
        expect(isInOrder(commandsOf(before), CLEAN_TREE_AND_BUILDS), `${file}:${id}`).toBe(true);
        // A step with its own condition would skip the check on some run.
        const guards = before.filter((step) => CLEAN_TREE_AND_BUILDS.some((command) => (step.run ?? "").includes(command)));
        expect(guards.filter((step) => step.if !== undefined), `${file}:${id}`).toEqual([]);
      }
    }
    expect(callers).toContain("package-artifact.yml:release-packages");
    expect(callers).toContain("publish-prerelease-gated.yml:publish");
    const legs = readWorkflow(join(workflowsDirectory, "package-artifact.yml")).jobs["release-packages"]?.strategy?.matrix?.["node-version"];
    expect(legs).toEqual(["20.19.0", "22.21.1"]);
  });

  it("in every workflow, each step that runs the kit's tests is `npm run seller:test` and none runs an inline node command over `packages/dacs-seller/test/*`; `ci.yml` holds exactly one such step; no kit test asserts the removed inline command in a workflow text", () => {
    const kitTestLine = /seller:test|run-seller-tests|dacs-seller\/test/u;
    for (const file of workflowFiles()) {
      for (const job of Object.values(readWorkflow(join(workflowsDirectory, file)).jobs)) {
        for (const step of job.steps ?? []) {
          for (const line of commandsOf([step]).filter((command) => kitTestLine.test(command))) {
            expect(line, file).toBe("npm run seller:test");
          }
        }
      }
    }
    const ciSteps = Object.values(readWorkflow(join(workflowsDirectory, "ci.yml")).jobs).flatMap((job) => job.steps ?? []);
    expect(ciSteps.filter((step) => commandsOf([step]).includes("npm run seller:test"))).toHaveLength(1);
    const kitTests = join(repoRoot, "packages/dacs-seller/test");
    for (const name of readdirSync(kitTests).filter((file) => file.endsWith(".test.mjs"))) {
      const source = readFileSync(join(kitTests, name), "utf8");
      expect(source, name).not.toMatch(/assert\.(?:match|ok|equal)\([^\n]*run: node[^\n]*dacs-seller\/test/u);
    }
  });
});
