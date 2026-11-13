import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runBash, shellQuote, stubBin, workflowStepScript } from "./helpers/workflow.js";

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

// Runs the real demosdk-compat.yml step script with a stub npm/npx and returns the calls it made.
// `node --test` is recorded and not run, because the scratch folder holds no test files;
// every other node call (the installed-version check) runs on the real binary.
function runPinnedStep(
  registryBody: string,
  installedVersion = PINNED,
  { directory = scratch(), nodeBinary = process.execPath } = {},
) {
  const calls = join(directory, "npm-calls.log");
  const npm = `echo "$*" >> ${shellQuote(calls)}
${registryBody}
if [ "$1" = install ]; then
  mkdir -p node_modules/@kynesyslabs/demosdk
  printf '{"version":"${installedVersion}"}' > node_modules/@kynesyslabs/demosdk/package.json
fi
exit 0`;
  const node = `if [ "$1" = --test ]; then echo "node $*" >> ${shellQuote(calls)}; exit 0; fi
exec ${shellQuote(nodeBinary)} "$@"`;
  const path = stubBin(directory, { node, npm, npx: "exit 0" });
  const script = join(directory, "step.sh");
  writeFileSync(script, workflowStepScript(PIN_STEP, compatPath));
  const result = runBash(["-e", script], { cwd: directory, env: { PATH: path } });
  return { result, calls: readFileSync(calls, "utf8").trim().split("\n") };
}

describe("pinned demosdk step", () => {
  it("runs when the node path and the folder holding the calls log contain a single quote", () => {
    const directory = mkdtempSync(join(tmpdir(), "demosdk-pin-it's-"));
    directories.push(directory);
    const nodeBinary = join(directory, "node");
    symlinkSync(process.execPath, nodeBinary);
    const { result, calls } = runPinnedStep(registryReplying([PINNED]), PINNED, { directory, nodeBinary });
    expect(result.status).toBe(0);
    expect(calls.some((call) => call.startsWith("node --test"))).toBe(true);
  });

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

  it("installs the pinned version without running install scripts", () => {
    const { calls } = runPinnedStep(registryReplying([PINNED]));
    const install = calls.find((call) => call.startsWith("install"));
    expect(install).toContain("--ignore-scripts");
  });

  it("runs the client loading suite by its own file name after the pinned install", () => {
    const { result, calls } = runPinnedStep(registryReplying([PINNED]));
    expect(result.status).toBe(0);
    // The step names every client file one by one and later changes append theirs, so the loading suite is one whole argument, never a glob.
    const install = calls.findIndex((call) => call.startsWith("install") && call.includes(`@kynesyslabs/demosdk@${PINNED}`));
    const loadingSuite = calls.findIndex((call) => call.startsWith("node --test") && call.split(" ").includes("packages/dacs-client/test/node-demos-loading.test.mjs"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(loadingSuite).toBeGreaterThan(install);
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

  it("runs only on the schedule, for the version the pinned step installs", () => {
    const job = compat.jobs["demosdk-pin-drift"];
    expect(job?.if).toBe("github.event_name == 'schedule'");
    const command = (job?.steps ?? []).map((step) => step.run ?? "").find((run) => run.includes("demosdk-pin-drift"));
    const pinned = /@kynesyslabs\/demosdk@(\d+\.\d+\.\d+)/.exec(workflowStepScript(PIN_STEP, compatPath))?.[1];
    expect(pinned).toBe(PINNED);
    expect(command).toContain(`scripts/demosdk-pin-drift.mjs ${pinned} `);
  });
});

describe("where the pinned demosdk step runs", () => {
  const ci = parse(readFileSync(ciPath, "utf8")) as Workflow;
  const compat = parse(readFileSync(compatPath, "utf8")) as Workflow;

  it("is not in ci.yml", () => {
    const steps = Object.values(ci.jobs).flatMap((job) => job.steps ?? []);
    expect(steps.some((step) => step.name === PIN_STEP)).toBe(false);
    // An exact-version install (the package smoke's caret range is the consumer's own install, not a pin).
    expect(steps.some((step) => /@kynesyslabs\/demosdk@\d/.test(step.run ?? ""))).toBe(false);
  });

  it("is the last step of its own unconditional compatibility job, which builds the host kit first", () => {
    const job = compat.jobs["demosdk-pinned-tests"];
    const steps = job?.steps ?? [];
    expect(job?.if).toBeUndefined();
    expect(steps.at(-1)?.name).toBe(PIN_STEP);
    expect(steps.at(-1)?.if).toBeUndefined();
    const runs = steps.map((step) => step.run ?? "");
    expect(runs.indexOf("npm run host:build")).toBeGreaterThan(runs.indexOf("npm ci --no-audit"));
    expect(runs.indexOf("npm run host:build")).toBeLessThan(steps.length - 1);
    // The build/declaration matrix keeps an entry for the same pinned version.
    const compatMatrix = (compat.jobs["demosdk-compat"] as { strategy?: { matrix?: { demosdk?: string[] } } }).strategy?.matrix?.demosdk;
    expect(compatMatrix).toContain(PINNED);
  });
});
