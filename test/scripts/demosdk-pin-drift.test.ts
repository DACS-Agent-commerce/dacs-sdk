import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runBash, stubBin, workflowStepScript } from "./helpers/workflow.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const ciPath = join(repoRoot, ".github/workflows/ci.yml");
const compatPath = join(repoRoot, ".github/workflows/demosdk-compat.yml");
const driftScript = join(repoRoot, "scripts/demosdk-pin-drift.mjs");
const PIN_STEP = "Typecheck and test against demosdk 4.0.18";
const PINNED = "4.0.18";
const RANGE = "^4.0.16";
const TIMEOUT_OVERRIDE_MS = "200";

type Step = { name?: string; run?: string; if?: string };
type Workflow = { jobs: Record<string, { if?: string; steps?: Step[] }> };

const directories: string[] = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), "demosdk-pin-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A registry that answers `npm view` with `reply` verbatim.
const registryReplying = (reply: object | string) =>
  `[ "$1" = view ] && { printf '%s' '${typeof reply === "string" ? reply : JSON.stringify(reply)}'; exit 0; }`;
const REGISTRY_REFUSED = `[ "$1" = view ] && { echo "npm error code ECONNREFUSED" >&2; exit 1; }`;

function runDrift(npmBody: string, env: Record<string, string> = {}) {
  const directory = scratch();
  const path = stubBin(directory, { npm: npmBody });
  return spawnSync(process.execPath, [driftScript, PINNED, RANGE], {
    cwd: directory, encoding: "utf8", env: { PATH: path, ...env },
  });
}

describe("scheduled demosdk pin drift check", () => {
  it("passes when the pinned version is the newest in range", () => {
    const result = runDrift(registryReplying(["4.0.16", "4.0.17", PINNED]));
    expect(result.status).toBe(0);
  });

  it("accepts the single-string reply npm gives when one version matches", () => {
    const result = runDrift(registryReplying(`"${PINNED}"`));
    expect(result.status).toBe(0);
  });

  it("fails with exit 1 naming both versions when a newer 4.x is published", () => {
    const result = runDrift(registryReplying(["4.0.19", PINNED]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("4.0.19");
    expect(result.stderr).toContain(PINNED);
  });

  it("picks the newest by version number, not by reply order or text order", () => {
    const result = runDrift(registryReplying(["4.0.9", "4.0.100", PINNED, "4.0.19"]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("4.0.100");
  });

  it("fails with exit 2 and the refusal when the registry is unreachable", () => {
    const result = runDrift(REGISTRY_REFUSED);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ECONNREFUSED");
  });

  it("fails with exit 2 saying timed out when the registry does not answer in time", () => {
    const result = runDrift(`[ "$1" = view ] && exec sleep 30`, { DEMOSDK_DRIFT_TIMEOUT_MS: TIMEOUT_OVERRIDE_MS });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("timed out");
  });

  it("fails with exit 2 saying too large when the reply exceeds the byte limit", () => {
    const result = runDrift(`[ "$1" = view ] && { head -c 2097152 /dev/zero; exit 0; }`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("too large");
  });

  it.each([
    ["not JSON", "<html>bad gateway</html>"],
    ["an empty list", "[]"],
    ["a non-version entry", `["latest"]`],
    ["a non-array object", `{"version":"4.0.19"}`],
  ])("fails with exit 2 on %s", (_label, reply) => {
    const result = runDrift(registryReplying(reply));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unreadable");
  });
});

// Runs the real ci.yml step script with a stub npm/npx and returns the calls it made.
// `node --test` is recorded and not run, because the scratch folder holds no test files;
// every other node call (the installed-version check) runs on the real binary.
function runPinnedStep(registryBody: string, installedVersion = PINNED) {
  const directory = scratch();
  const calls = join(directory, "npm-calls.log");
  const npm = `echo "$*" >> '${calls}'
${registryBody}
if [ "$1" = install ]; then
  mkdir -p node_modules/@kynesyslabs/demosdk
  printf '{"version":"${installedVersion}"}' > node_modules/@kynesyslabs/demosdk/package.json
fi
exit 0`;
  const node = `if [ "$1" = --test ]; then echo "node $*" >> '${calls}'; exit 0; fi
exec '${process.execPath}' "$@"`;
  const path = stubBin(directory, { node, npm, npx: "exit 0" });
  const script = join(directory, "step.sh");
  writeFileSync(script, workflowStepScript(PIN_STEP, ciPath));
  const result = runBash(["-e", script], { cwd: directory, env: { PATH: path } });
  return { result, calls: readFileSync(calls, "utf8").trim().split("\n") };
}

describe("pull-request demosdk step", () => {
  it("passes when a newer 4.x is published and never looks up the newest version", () => {
    const { result, calls } = runPinnedStep(registryReplying(["4.0.17", PINNED, "4.0.19"]));
    expect(result.status).toBe(0);
    expect(calls.some((call) => call.startsWith("view"))).toBe(false);
  });

  it("passes when the registry lookup is refused", () => {
    const { result } = runPinnedStep(REGISTRY_REFUSED);
    expect(result.status).toBe(0);
  });

  it("installs the pinned version", () => {
    const { calls } = runPinnedStep(registryReplying([PINNED]));
    expect(calls.some((call) => call.startsWith("install") && call.includes(`@kynesyslabs/demosdk@${PINNED}`))).toBe(true);
  });

  it("runs the client loading suite by its own file name after the pinned install", () => {
    const { result, calls } = runPinnedStep(registryReplying([PINNED]));
    expect(result.status).toBe(0);
    expect(calls.some((call) => call.startsWith("node --test") && call.endsWith("packages/dacs-client/test/node-demos-loading.test.mjs"))).toBe(true);
  });

  it("still fails when the installed demosdk is not the pinned version", () => {
    const { result } = runPinnedStep(registryReplying([PINNED]), "4.0.19");
    expect(result.status).not.toBe(0);
  });
});

describe("where the drift check runs", () => {
  const ci = parse(readFileSync(ciPath, "utf8")) as Workflow;
  const compat = parse(readFileSync(compatPath, "utf8")) as Workflow;

  it("is not run by any ci.yml job", () => {
    const runs = Object.values(ci.jobs).flatMap((job) => job.steps ?? []).map((step) => step.run ?? "");
    expect(runs.some((run) => run.includes("demosdk-pin-drift"))).toBe(false);
  });

  it("runs only on the schedule, for the version ci.yml pins", () => {
    const job = compat.jobs["demosdk-pin-drift"];
    expect(job?.if).toBe("github.event_name == 'schedule'");
    const command = (job?.steps ?? []).map((step) => step.run ?? "").find((run) => run.includes("demosdk-pin-drift"));
    const pinnedInCi = /@kynesyslabs\/demosdk@(\d+\.\d+\.\d+)/.exec(workflowStepScript(PIN_STEP, ciPath))?.[1];
    expect(pinnedInCi).toBe(PINNED);
    expect(command).toContain(`scripts/demosdk-pin-drift.mjs ${pinnedInCi} `);
  });
});
