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

type Step = { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> };
type Job = {
  steps?: Step[]; uses?: string; needs?: string[]; environment?: string; permissions?: Record<string, string>;
  "timeout-minutes"?: number; strategy?: { matrix?: { "node-version"?: string[] } }; env?: Record<string, string>;
};
type Workflow = { concurrency?: unknown; jobs: Record<string, Job> };
const readWorkflow = (path: string) => parse(readFileSync(path, "utf8")) as Workflow;
const gated = readWorkflow(gatedPath);
const publishSteps = gated.jobs.publish?.steps ?? [];
const verifySteps = gated.jobs.verify?.steps ?? [];
const SUITE_COMMANDS = [
  "npm test", "npm run host:test", "npm run generator:test", "npm test --workspace @kynesyslabs/dacs-client",
  "npm run seller:prepare -- \"$DACS_SELLER_SMOKE_DIR\"", "npm run seller:test", "npm run release:test",
];
// The job is scanned as JSON, so a double quote inside an expression arrives escaped as `\"`.
const PUBLICATION_CREDENTIAL = new RegExp(
  String.raw`secrets\s*[.[]|github\s*(?:\.\s*token\b|\[\s*\\?["']token\\?["']\s*\])|registry-url|NODE_AUTH_TOKEN|GH_TOKEN`,
  "u",
);
// The whole job is scanned, so job-level `env` counts as well as step fields.
const mentionsPublicationCredential = (job: Job | undefined) => PUBLICATION_CREDENTIAL.test(JSON.stringify(job));
const PUBLICATION_CREDENTIAL_FORMS: Record<string, (verify: Job) => void> = {
  "a job-level secret in env": (verify) => { verify.env = { NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" }; },
  "a secret read by index": (verify) => { verify.env = { NPM_TOKEN: "${{ secrets['NPM_TOKEN'] }}" }; },
  "the workflow token in a job-level env": (verify) => { verify.env = { TOKEN: "${{ github.token }}" }; },
  "the workflow token in a step": (verify) => { verify.steps?.push({ run: "echo ${{ github.token }}" }); },
  "the workflow token by single-quoted index": (verify) => { verify.env = { TOKEN: "${{ github['token'] }}" }; },
  "the workflow token by double-quoted index": (verify) => { verify.env = { TOKEN: "${{ github[\"token\"] }}" }; },
  "the workflow token by index in a step": (verify) => { verify.steps?.push({ run: "echo ${{ github['token'] }}" }); },
  "the workflow token by index with spaces": (verify) => { verify.env = { TOKEN: "${{ github [ 'token' ] }}" }; },
  "the workflow token with spaces around the dot": (verify) => { verify.env = { TOKEN: "${{ github . token }}" }; },
  "a registry-url on setup-node": (verify) => { verify.steps?.push({ uses: "actions/setup-node@v4", with: { "registry-url": "https://registry.npmjs.org" } }); },
};
const PUBLISH_COMMAND ="node scripts/publish-release-set.mjs --artifact-dir package-artifacts/release-set --tag next --job-started-at \"$DACS_PUBLISH_JOB_STARTED_AT\"";

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

  it("the gated workflow's verify job requires a clean build tree after npm ci, builds core, dacs-node and the generator, and runs all five packages' suites and then release:test", () => {
    expect(isInOrder(commandsOf(verifySteps), [
      "npm ci",
      "test ! -e dist", "test ! -e packages/dacs-node/dist", "test ! -e packages/create-dacs-agent/dist",
      "npm run build", "npm run host:build", "npm run generator:build",
      ...SUITE_COMMANDS,
    ])).toBe(true);
  });

  it("the gated workflow's publish job requires a clean build tree, builds, and builds the release set before it publishes", () => {
    expect(isInOrder(commandsOf(publishSteps), [
      "npm ci",
      "test ! -e dist", "test ! -e packages/dacs-node/dist", "test ! -e packages/create-dacs-agent/dist",
      "npm run build", "npm run host:build", "npm run generator:build",
      "npm run release:set:verify -- --output-dir package-artifacts/release-set --strict",
      PUBLISH_COMMAND,
    ])).toBe(true);
  });

  it("the gated workflow's publish job runs none of the suites, so its 45-minute clock holds only the release set and the publish", () => {
    const commands = commandsOf(publishSteps);
    for (const suite of SUITE_COMMANDS) expect(commands, suite).not.toContain(suite);
    expect(commands.filter((command) => /\b(?:test|seller:prepare)\b/u.test(command))
      .filter((command) => command.startsWith("npm "))).toEqual([]);
  });

  it("the gated workflow's publish job waits for the verify job, which has its own longer time limit", () => {
    expect(gated.jobs.publish?.needs).toEqual(expect.arrayContaining(["verify"]));
    const verifyLimit = gated.jobs.verify?.["timeout-minutes"];
    expect(verifyLimit).toBeGreaterThan(gated.jobs.publish?.["timeout-minutes"] ?? Infinity);
  });

  it("the gated workflow's verify job gets no publication credential: no environment, no OIDC token, no secret", () => {
    const verify = gated.jobs.verify;
    expect(verify?.environment).toBeUndefined();
    expect(verify?.permissions).toEqual({ contents: "read" });
    expect(mentionsPublicationCredential(verify)).toBe(false);
    expect(gated.jobs.verify?.needs).toEqual(expect.arrayContaining(["registry-container-acceptance", "publish-environment"]));
  });

  it("a publication credential anywhere in the verify job is reported, whether in job-level env, by index, or as the workflow token", () => {
    for (const [label, addCredential] of Object.entries(PUBLICATION_CREDENTIAL_FORMS)) {
      const changed = structuredClone(gated);
      const verify = changed.jobs.verify;
      if (verify === undefined) throw new Error("the gated workflow has no verify job");
      addCredential(verify);
      expect(mentionsPublicationCredential(verify), label).toBe(true);
    }
  });

  it("the gated workflow's verify job checks out without keeping the workflow token in the repository config", () => {
    const checkouts = verifySteps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(checkout.with?.["persist-credentials"]).toBe(false);
  });

  it("every artifact upload in a re-runnable job of the gated workflow carries the run attempt in its name, so \"Re-run failed jobs\" does not upload an existing name", () => {
    const uploads = Object.values(gated.jobs).flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      expect(String(upload.with?.name), upload.name).toContain("${{ github.run_attempt }}");
    }
    expect(gated.jobs.publish?.steps?.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(true);
  });

  it("the gated workflow keeps one publication at a time", () => {
    expect(gated.concurrency).toEqual({ group: "dacs-npm-prerelease", "cancel-in-progress": false });
  });
});

describe("the publication runbook", () => {
  it("tells the operator to re-run only the failed publish job after publish_budget_exhausted, so the verified suites are not repeated", () => {
    const runbook = readFileSync(join(repoRoot, "docs/npm-prerelease-release.md"), "utf8");
    const line = runbook.split("\n").find((text) => text.includes("`publish_budget_exhausted`"));
    expect(line).toMatch(/Re-run failed jobs/u);
    expect(runbook).toMatch(/`verify` job/u);
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

// The release suite is run either through its npm script or by `node --test` over the release test glob. Words may be
// separated by any run of spaces, tabs or backslash-continued line breaks, and Node options may come before `--test`.
const GAP = String.raw`(?:[ \t]|\\\n)+`;
const RELEASE_SUITE = new RegExp(
  String.raw`npm${GAP}run${GAP}release:(?:qualification:)?test(?![:\w-])` +
    String.raw`|node${GAP}(?:-\S+${GAP})*--test\b(?:[^\n]|\\\n)*test\/scripts\/release-\*\.test\.mjs`,
  "u",
);
const CLEAN_TREE_AND_BUILDS = [
  "test ! -e dist", "test ! -e packages/dacs-node/dist", "test ! -e packages/create-dacs-agent/dist",
  "npm run build", "npm run host:build", "npm run generator:build",
];
const workflowFiles = () => readdirSync(workflowsDirectory).filter((name) => name.endsWith(".yml"));
const readWorkflows = () => Object.fromEntries(workflowFiles().map((file) => [file, readWorkflow(join(workflowsDirectory, file))]));

// Every job, in any workflow file (reusable ones included), that runs the release suite, with the steps before that run.
function releaseSuiteCallers(workflows: Record<string, Workflow>) {
  return Object.entries(workflows).flatMap(([file, workflow]) => Object.entries(workflow.jobs).flatMap(([id, job]) => {
    const steps = job.steps ?? [];
    const suiteAt = steps.findIndex((step) => RELEASE_SUITE.test(step.run ?? ""));
    return suiteAt < 0 ? [] : [{ name: `${file}:${id}`, before: steps.slice(0, suiteAt) }];
  }));
}

// A step with its own condition would skip the check on some run.
const hasCleanTreeAndBuilds = (before: Step[]) => isInOrder(commandsOf(before), CLEAN_TREE_AND_BUILDS)
  && before.filter((step) => CLEAN_TREE_AND_BUILDS.some((command) => (step.run ?? "").includes(command)))
    .every((step) => step.if === undefined);

const checkedSteps = CLEAN_TREE_AND_BUILDS.map((run): Step => ({ run }));
const jobRunning = (run: string, before: Step[] = []): Workflow => ({ jobs: { check: { steps: [...before, { run }] } } });
const RELEASE_GLOB_RUN = "node --test --test-concurrency=1 test/scripts/release-*.test.mjs";

describe("every workflow", () => {
  it("a job that runs the release test glob with node --test is a release-suite caller", () => {
    const callers = releaseSuiteCallers({ "direct.yml": jobRunning(RELEASE_GLOB_RUN) });
    expect(callers.map((caller) => caller.name)).toEqual(["direct.yml:check"]);
  });

  it("a release test glob run written across backslash-continued lines is a release-suite caller", () => {
    const continued = "node --test --test-concurrency=1 \\\n  test/scripts/release-*.test.mjs";
    const callers = releaseSuiteCallers({ "continued.yml": jobRunning(continued) });
    expect(callers.map((caller) => caller.name)).toEqual(["continued.yml:check"]);
  });

  it("a release test glob run with Node options before --test, or extra spaces, is a release-suite caller", () => {
    const callers = releaseSuiteCallers({
      "options.yml": jobRunning("node --no-warnings --test test/scripts/release-*.test.mjs"),
      "spaces.yml": jobRunning("node  --test   test/scripts/release-*.test.mjs"),
      "npm.yml": jobRunning("npm  run release:test"),
    });
    expect(callers.map((caller) => caller.name)).toEqual(["options.yml:check", "spaces.yml:check", "npm.yml:check"]);
  });

  it("release:test:native and a single named release test file are not release-suite callers", () => {
    expect(releaseSuiteCallers({
      "native.yml": jobRunning("npm run release:test:native"),
      "single.yml": jobRunning("node --test test/scripts/release-workflow.test.mjs"),
    })).toEqual([]);
  });

  it("a release-suite caller without the clean-tree check and builds is reported, and one with them is accepted", () => {
    const [unchecked] = releaseSuiteCallers({ "direct.yml": jobRunning(RELEASE_GLOB_RUN) });
    expect(hasCleanTreeAndBuilds(unchecked?.before ?? [])).toBe(false);
    const [checked] = releaseSuiteCallers({ "direct.yml": jobRunning(RELEASE_GLOB_RUN, checkedSteps) });
    expect(hasCleanTreeAndBuilds(checked?.before ?? [])).toBe(true);
  });

  it("a job in a reusable workflow that runs the release test glob is checked like any other job", () => {
    const callers = releaseSuiteCallers({
      "caller.yml": { jobs: { suites: { uses: "./.github/workflows/reusable.yml" } } },
      "reusable.yml": jobRunning(RELEASE_GLOB_RUN),
    });
    expect(callers.map((caller) => caller.name)).toEqual(["reusable.yml:check"]);
    expect(hasCleanTreeAndBuilds(callers[0]?.before ?? [])).toBe(false);
  });

  it("in every workflow job that runs release:test or release:qualification:test, or the release test glob with node --test, a clean-tree check and the three builds run first in that job; package-artifact's release-packages job does so on both matrix legs", () => {
    const callers = releaseSuiteCallers(readWorkflows());
    for (const caller of callers) expect(hasCleanTreeAndBuilds(caller.before), caller.name).toBe(true);
    expect(callers.map((caller) => caller.name)).toContain("package-artifact.yml:release-packages");
    expect(callers.map((caller) => caller.name)).toContain("publish-prerelease-gated.yml:verify");
    const legs = readWorkflow(join(workflowsDirectory, "package-artifact.yml")).jobs["release-packages"]?.strategy?.matrix?.["node-version"];
    expect(legs).toEqual(["22.22.2", "24.15.0"]);
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
