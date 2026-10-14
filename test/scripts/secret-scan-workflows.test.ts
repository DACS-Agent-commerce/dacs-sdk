import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requiredWorkflow = await readFile(join(root, ".github/workflows/secret-scan.yml"), "utf8");
const auditWorkflow = await readFile(join(root, ".github/workflows/secret-scan-all-branches.yml"), "utf8");

const REQUIRED_LOG_OPTS = "--full-history --text --remerge-diff HEAD";
const AUDIT_LOG_OPTS = "--full-history --text --remerge-diff --all";
// What Gitleaks 8.30.1 runs after `git log -p -U0` when no --log-opts is given.
const GITLEAKS_DEFAULT_LOG_OPTS = "--full-history --all --diff-filter=tuxdb";

// The steps of a workflow's only job, each as the text from its `- ` line to the next.
function stepsOf(workflow: string) {
  const lines = workflow.split("\n");
  expect(lines.filter((line) => line.trim() === "steps:")).toEqual(["    steps:"]);
  const steps: string[][] = [];
  const rest = lines.slice(lines.indexOf("    steps:") + 1);
  for (const line of rest) {
    if (line.startsWith("      - ")) steps.push([line]);
    else if (line === "" || line.startsWith("        ")) steps.at(-1)?.push(line);
    else break;
  }
  // The steps are the end of the file: no second job, and nothing after them.
  expect(steps.flat()).toHaveLength(rest.length);
  return steps.map((step) => step.join("\n").trimEnd());
}

// Everything before the steps, without comments: the triggers, token, job name and image.
function headerOf(workflow: string) {
  const lines = workflow.split("\n");
  return lines.slice(0, lines.indexOf("    steps:")).filter((line) => line !== "" && !line.trimStart().startsWith("#"));
}

function stepNames(workflow: string) {
  return stepsOf(workflow).map((step) => valueOf(step, "name") ?? valueOf(step, "uses")?.split("@")[0]);
}

function stepNamed(workflow: string, name: string) {
  const steps = stepsOf(workflow).filter((step) => valueOf(step, "name") === name);
  expect(steps).toHaveLength(1);
  return steps[0] ?? "";
}

function stepUsing(workflow: string, action: string) {
  const steps = stepsOf(workflow).filter((step) => valueOf(step, "uses")?.startsWith(`${action}@`));
  expect(steps).toHaveLength(1);
  return steps[0] ?? "";
}

// A key's value as written, quotes included, or a block scalar's lines without their indent.
function valueOf(step: string, key: string) {
  const lines = step.split("\n");
  const index = lines.findIndex((line) => new RegExp(`^ +(?:- )?${key}: `).test(line));
  if (index < 0) return undefined;
  const value = (lines[index] ?? "").replace(new RegExp(`^ +(?:- )?${key}: `), "");
  if (value !== "|") return value;
  const block = lines.slice(index + 1);
  const indent = /^ */.exec(block[0] ?? "")?.[0].length ?? 0;
  const end = block.findIndex((line) => line !== "" && !line.startsWith(" ".repeat(indent)));
  return block
    .slice(0, end < 0 ? undefined : end)
    .map((line) => line.slice(indent))
    .join("\n")
    .trimEnd();
}

// Each scan first tests this git and Gitleaks on known history, then scans with the same script.
function scanScript(gitleaksArguments: string) {
  return [
    'bash scripts/secret-scan-self-test.sh "$RUNNER_TEMP/gitleaks"',
    `bash scripts/secret-scan.sh "$RUNNER_TEMP/gitleaks" ${gitleaksArguments}`,
  ].join("\n");
}

describe("secret scan workflows", () => {
  it("keep their triggers, read-only token, job name and image, and let no step fail open", () => {
    // `secret scan` is the check name the ruleset requires.
    expect(headerOf(requiredWorkflow)).toEqual([
      "name: Secret scan",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "  workflow_dispatch:",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  secret-scan:",
      "    name: secret scan",
      "    runs-on: ubuntu-24.04",
    ]);
    // Daily at 04:17 UTC, as the docs say, and when dispatched.
    expect(headerOf(auditWorkflow)).toEqual([
      "name: Secret scan (all branches)",
      "on:",
      "  schedule:",
      "    - cron: '17 4 * * *'",
      "  workflow_dispatch:",
      "permissions:",
      "  contents: read",
      "jobs:",
      "  secret-scan-all-branches:",
      "    name: secret scan (all branches)",
      "    runs-on: ubuntu-24.04",
    ]);
    for (const workflow of [requiredWorkflow, auditWorkflow]) {
      // The default shell, `bash -e`, stops a step at its first failing command.
      expect(workflow).not.toMatch(/continue-on-error|shell:|defaults:|permissions:.*write|: write/);
      for (const step of stepsOf(workflow)) {
        expect(step.split("\n").filter((line) => /^ {6}(?:- | {2})if: /.test(line))).toEqual(
          valueOf(step, "name") === "List findings" ? ["        if: ${{ !cancelled() && steps.scan.outcome != 'skipped' }}"] : [],
        );
      }
    }
  });

  it("pin the same Gitleaks release in both workflows and in .gitleaks.toml", async () => {
    const config = await readFile(join(root, ".gitleaks.toml"), "utf8");
    const minVersion = /^minVersion = "([^"]+)"$/m.exec(config)?.[1];
    for (const workflow of [requiredWorkflow, auditWorkflow]) {
      const install = stepNamed(workflow, "Install pinned Gitleaks");
      expect(valueOf(install, "GITLEAKS_VERSION")).toBe(`"${minVersion}"`);
      expect(valueOf(install, "GITLEAKS_ARCHIVE_SHA256")).toMatch(/^"[0-9a-f]{64}"$/);
      expect(valueOf(install, "GITLEAKS_ARCHIVE_SHA256")).toBe(
        valueOf(stepNamed(requiredWorkflow, "Install pinned Gitleaks"), "GITLEAKS_ARCHIVE_SHA256"),
      );
      expect(valueOf(install, "run")).toContain('sha256sum --check');
      expect(valueOf(install, "run")).toContain("git --version");
    }
  });

  it("run on a fixed image, pin every action to a commit and upload nothing", () => {
    for (const workflow of [requiredWorkflow, auditWorkflow]) {
      expect(workflow.match(/^ +runs-on: .*$/gm)).toEqual(["    runs-on: ubuntu-24.04"]);
      for (const step of stepsOf(workflow)) {
        const uses = valueOf(step, "uses");
        if (uses !== undefined) expect(uses).toMatch(/^actions\/(?:checkout|setup-node)@[0-9a-f]{40} # v4$/);
      }
      expect(workflow).not.toContain("upload-artifact");
      expect(workflow).not.toContain("--report-path=-");
    }
  });

  it("scan the history of the commit under test, both parents of a PR merge included", () => {
    expect(stepNames(requiredWorkflow)).toEqual([
      "actions/checkout",
      "Fetch checked-out history",
      "Install pinned Gitleaks",
      "Scan reachable history",
    ]);
    expect(valueOf(stepUsing(requiredWorkflow, "actions/checkout"), "fetch-depth")).toBe("1");
    expect(valueOf(stepNamed(requiredWorkflow, "Fetch checked-out history"), "run")).toBe(
      'git fetch --no-tags --unshallow origin "$GITHUB_SHA"',
    );
    const scan = stepNamed(requiredWorkflow, "Scan reachable history");
    expect(valueOf(scan, "LOG_OPTS")).toBe(`"${REQUIRED_LOG_OPTS}"`);
    expect(valueOf(scan, "run")).toBe(scanScript("--redact=100 --no-banner"));
  });

  it("audit every branch, tag and pull request head, and list its findings after a red scan", () => {
    expect(stepNames(auditWorkflow)).toEqual([
      "actions/checkout",
      "Fetch pull request heads",
      "actions/setup-node",
      "Install pinned Gitleaks",
      "Scan all branch history",
      "List findings",
    ]);
    expect(valueOf(stepUsing(auditWorkflow, "actions/checkout"), "fetch-depth")).toBe("0");
    expect(valueOf(stepUsing(auditWorkflow, "actions/setup-node"), "node-version")).toMatch(/^"\d+\.\d+\.\d+"$/);
    expect(valueOf(stepNamed(auditWorkflow, "Fetch pull request heads"), "run")).toBe(
      "git fetch --no-tags origin '+refs/pull/*/head:refs/pull/*/head'",
    );
    const scan = stepNamed(auditWorkflow, "Scan all branch history");
    expect(valueOf(scan, "id")).toBe("scan");
    expect(valueOf(scan, "LOG_OPTS")).toBe(`"${AUDIT_LOG_OPTS}"`);
    const report = '"$RUNNER_TEMP/gitleaks-report.json"';
    expect(valueOf(scan, "run")).toBe(
      scanScript(`--redact=100 --no-banner \\\n  --report-format=json --report-path=${report}`),
    );
    const list = stepNamed(auditWorkflow, "List findings");
    expect(valueOf(list, "if")).toBe("${{ !cancelled() && steps.scan.outcome != 'skipped' }}");
    expect(valueOf(list, "SCAN_OUTCOME")).toBe("${{ steps.scan.outcome }}");
    expect(valueOf(list, "run")).toBe(
      `node scripts/gitleaks-fingerprint-summary.mjs --report ${report} --scan-outcome "$SCAN_OUTCOME"`,
    );
  });

  it("documents a local reproduction that checks and scans what the audit does", async () => {
    const docs = await readFile(join(root, "docs/public-repository-cutover.md"), "utf8");
    const install = valueOf(stepNamed(auditWorkflow, "Install pinned Gitleaks"), "GITLEAKS_VERSION");
    expect(docs).toContain("\n  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\n");
    expect(docs).toContain(`\n  export LOG_OPTS="${AUDIT_LOG_OPTS}"\n`);
    expect(docs).toContain(`\n  ${valueOf(stepNamed(auditWorkflow, "Fetch pull request heads"), "run")}\n`);
    expect(docs).toContain(`\n  test "$(gitleaks version)" = ${install?.replaceAll('"', "")}\n`);
    expect(docs).toContain('\n  bash scripts/secret-scan-self-test.sh "$(command -v gitleaks)"\n');
    expect(docs).toContain('\n  bash scripts/secret-scan.sh "$(command -v gitleaks)" --redact=100 --no-banner \\\n');
  });

  it("pins every .gitleaksignore entry to a commit, or a conflict resolution to its reviewed merge", async () => {
    const lines = (await readFile(join(root, ".gitleaksignore"), "utf8")).split("\n");
    expect(lines.filter((line) => line.trim() !== "" && !line.startsWith("#")).length).toBeGreaterThan(0);
    expect(ignoreEntryProblems(lines)).toEqual([]);
  });

  it("accepts an entry without a commit only for a b/ file under a comment naming its merge", () => {
    const merge = "c".repeat(40);
    expect(ignoreEntryProblems([`${"a".repeat(40)}:src/a:b.ts:generic-api-key:4`, ""])).toEqual([]);
    expect(
      ignoreEntryProblems([`# Reviewed in merge ${merge}: fixture`, "b/src/commitment.ts:generic-api-key:4"]),
    ).toEqual([]);
    const rejected = [
      ["b/src/commitment.ts:generic-api-key:4"],
      ["# Reviewed in merge abc", "b/src/commitment.ts:generic-api-key:4"],
      [`# Reviewed in merge ${merge}`, "", "b/src/commitment.ts:generic-api-key:4"],
      [`# Reviewed in merge ${merge}`, "src/commitment.ts:generic-api-key:4"],
      [`# Reviewed in merge ${merge}`, "later.txt:generic-api-key:4"],
      [`${"A".repeat(40)}:src/a.ts:generic-api-key:4`],
      [`${"a".repeat(40)}:src/a.ts:generic-api-key:`],
    ];
    for (const lines of rejected) expect(ignoreEntryProblems(lines)).toEqual([lines.at(-1)]);
  });
});

// The .gitleaksignore entries that are neither `commit:file:rule:line` nor a commit-less
// `b/file:rule:line`, which Gitleaks writes for some merges' conflict resolutions, directly
// under a comment that names the merge it was reviewed in. Any entry without a commit matches
// that file, rule and line in every commit.
function ignoreEntryProblems(lines: string[]) {
  return lines.filter((line, index) => {
    if (line.trim() === "" || line.startsWith("#")) return false;
    if (/^[0-9a-f]{40}:.+:[A-Za-z0-9._-]+:[0-9]+$/.test(line)) return false;
    return !(
      /^b\/.+:[A-Za-z0-9._-]+:[0-9]+$/.test(line) && /^# Reviewed in merge [0-9a-f]{40}\b/.test(lines[index - 1] ?? "")
    );
  });
}

// Gitleaks scans the added lines of the patches `git log -p -U0 <log-opts>` prints, so each
// case below must show up as an added line under both workflows' options.
describe("secret scan git log options", () => {
  let directory: string;
  let origin: string;
  const markers = ["control", "typechange", "attributes", "conflict", "merge"].map((name) => `marker-${name}`);
  const pullOnly = "marker-pull-request";

  function run(cwd: string, args: string[]) {
    return spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  }

  function git(cwd: string, args: string[]) {
    const result = run(cwd, args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  // The markers in lines the patches add. Like the workflows' preflight, git must say nothing on stderr.
  function scanned(cwd: string, logOpts: string) {
    const result = run(cwd, ["log", "-p", "-U0", ...logOpts.split(" ")]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const added = result.stdout.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++ "));
    return [...markers, pullOnly].filter((marker) => added.some((line) => line.includes(marker)));
  }

  async function commitFile(cwd: string, file: string, text: string, message: string) {
    await writeFile(join(cwd, file), text);
    git(cwd, ["add", "--all"]);
    git(cwd, ["commit", "-q", "-m", message]);
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "dacs-secret-scan-"));
    origin = join(directory, "origin");
    await mkdir(origin);
    git(origin, ["init", "-q", "-b", "main"]);
    await writeFile(join(origin, "conflict.txt"), "base\n");
    await symlink("README", join(origin, "link.cfg"));
    await commitFile(origin, "README", "fixture\n", "base");
    await commitFile(origin, "control.txt", `${markers[0]}\n`, "control");
    // A symlink turned into a regular file: a type change.
    await unlink(join(origin, "link.cfg"));
    await commitFile(origin, "link.cfg", `${markers[1]}\n`, "type change");
    // A path that .gitattributes marks as binary.
    await writeFile(join(origin, ".gitattributes"), "notes.cfg -diff\n");
    await commitFile(origin, "notes.cfg", `${markers[2]}\n`, "attributes");
    // A conflict whose resolution adds a line neither parent has.
    git(origin, ["checkout", "-q", "-b", "side"]);
    await commitFile(origin, "conflict.txt", "side\n", "side");
    git(origin, ["checkout", "-q", "main"]);
    await commitFile(origin, "conflict.txt", "main\n", "main");
    expect(run(origin, ["merge", "-q", "side"]).status).not.toBe(0);
    await commitFile(origin, "conflict.txt", `${markers[3]}\n`, "resolve conflict");
    // A merge without conflicts that also adds a file.
    git(origin, ["checkout", "-q", "-b", "side2"]);
    await commitFile(origin, "side2.txt", "side2\n", "side2");
    git(origin, ["checkout", "-q", "main"]);
    await commitFile(origin, "main2.txt", "main2\n", "main2");
    git(origin, ["merge", "-q", "--no-ff", "--no-commit", "side2"]);
    await commitFile(origin, "merged.txt", `${markers[4]}\n`, "merge side2");
    // A commit that only a pull request ref reaches, as GitHub serves refs/pull/<number>/head.
    git(origin, ["checkout", "-q", "-b", "pull"]);
    await commitFile(origin, "pull.txt", `${pullOnly}\n`, "pull request");
    git(origin, ["update-ref", "refs/pull/7/head", "HEAD"]);
    git(origin, ["checkout", "-q", "main"]);
    git(origin, ["branch", "-q", "-D", "pull", "side", "side2"]);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("shows every case to the scans, and Gitleaks' default options miss all but the control", () => {
    expect(git(origin, ["rev-list", "--count", "--merges", "HEAD"])).toBe("2");
    expect(scanned(origin, REQUIRED_LOG_OPTS)).toEqual(markers);
    expect(scanned(origin, AUDIT_LOG_OPTS)).toEqual([...markers, pullOnly]);
    expect(scanned(origin, GITLEAKS_DEFAULT_LOG_OPTS)).toEqual([markers[0], pullOnly]);
    // The options before this change saw the type change, but no merge or binary-marked path.
    expect(scanned(origin, "--full-history HEAD")).toEqual(markers.slice(0, 2));
  });

  it("scans the whole history of a depth-1 merge checkout after the unshallow fetch", async () => {
    const clone = join(directory, "required");
    await mkdir(clone);
    const sha = git(origin, ["rev-parse", "HEAD"]);
    git(clone, ["init", "-q"]);
    git(clone, ["remote", "add", "origin", pathToFileURL(origin).href]);
    // actions/checkout's fetch for `fetch-depth: 1` on a pull request's merge commit.
    git(clone, ["fetch", "-q", "--no-tags", "--depth=1", "origin", `+${sha}:refs/remotes/pull/7/merge`]);
    git(clone, ["checkout", "-q", "--force", "refs/remotes/pull/7/merge"]);
    expect(git(clone, ["rev-list", "--count", "HEAD"])).toBe("1");
    // The workflow's `git fetch --no-tags --unshallow origin "$GITHUB_SHA"`.
    git(clone, ["fetch", "-q", "--no-tags", "--unshallow", "origin", sha]);
    expect(existsSync(join(clone, ".git", "shallow"))).toBe(false);
    expect(git(clone, ["rev-list", "--count", "HEAD"])).toBe(git(origin, ["rev-list", "--count", "HEAD"]));
    expect(git(clone, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ")).toHaveLength(3);
    expect(scanned(clone, REQUIRED_LOG_OPTS)).toEqual(markers);
  });

  it("audits a pull request head only after fetching refs/pull", async () => {
    const clone = join(directory, "audit");
    // Like actions/checkout with `fetch-depth: 0`: every branch and tag, with `main` checked out.
    git(directory, ["clone", "-q", pathToFileURL(origin).href, clone]);
    expect(scanned(clone, AUDIT_LOG_OPTS)).toEqual(markers);
    // The workflow's `git fetch --no-tags origin '+refs/pull/*/head:refs/pull/*/head'`.
    git(clone, ["fetch", "-q", "--no-tags", "origin", "+refs/pull/*/head:refs/pull/*/head"]);
    expect(scanned(clone, AUDIT_LOG_OPTS)).toEqual([...markers, pullOnly]);
  });

  describe("scripts", () => {
    const scanScriptPath = join(root, "scripts/secret-scan.sh");
    const selfTestPath = join(root, "scripts/secret-scan-self-test.sh");
    let stub: string;
    let calls: string;

    // A stand-in for Gitleaks: records its arguments, writes STUB_REPORT to --report-path,
    // STUB_STDERR to stderr, and exits with STUB_STATUS.
    beforeAll(async () => {
      stub = join(directory, "gitleaks-stub");
      calls = join(directory, "gitleaks-calls");
      await writeFile(
        stub,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$@" >> "$STUB_CALLS"',
          'for argument; do case "$argument" in --report-path=*) printf "%s" "$STUB_REPORT" > "${argument#--report-path=}";; esac; done',
          'printf "%s" "$STUB_STDERR" >&2',
          'exit "$STUB_STATUS"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    });

    function runScript(cwd: string, script: string, args: string[], env: Record<string, string>) {
      return spawnSync("bash", [script, ...args], {
        cwd,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          STUB_CALLS: calls,
          STUB_REPORT: "",
          STUB_STDERR: "",
          STUB_STATUS: "0",
          ...env,
        },
      });
    }

    async function stubCalls() {
      const text = existsSync(calls) ? await readFile(calls, "utf8") : "";
      await rm(calls, { force: true });
      return text.split("\n").filter((line) => line !== "");
    }

    it("runs Gitleaks on a clean history with the job's options, and keeps its exit status", async () => {
      for (const status of ["0", "1"]) {
        const result = runScript(origin, scanScriptPath, [stub, "--no-banner"], {
          LOG_OPTS: REQUIRED_LOG_OPTS,
          STUB_STATUS: status,
        });
        expect(result.status).toBe(Number(status));
        expect(await stubCalls()).toEqual(["git", ".", `--log-opts=${REQUIRED_LOG_OPTS}`, "--no-banner"]);
      }
    });

    it("fails without running Gitleaks on a git error, on anything git writes to stderr, or on an octopus merge", async () => {
      const badRevision = runScript(origin, scanScriptPath, [stub], { LOG_OPTS: "--full-history --text --remerge-diff no-such-ref" });
      expect(badRevision.status).toBe(1);
      expect(badRevision.stderr).toContain("no-such-ref");
      // A trace is the simplest way to make git write to stderr and still succeed.
      const stderr = runScript(origin, scanScriptPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, GIT_TRACE: "1" });
      expect(stderr.status).toBe(1);
      expect(stderr.stderr).toContain("Nothing was scanned: git log failed or wrote to stderr.");
      expect(await stubCalls()).toEqual([]);

      const octopus = join(directory, "octopus");
      await mkdir(octopus);
      git(octopus, ["init", "-q", "-b", "main"]);
      await commitFile(octopus, "README", "fixture\n", "base");
      for (const branch of ["o1", "o2", "o3"]) {
        git(octopus, ["checkout", "-q", "-b", branch, "main"]);
        await commitFile(octopus, `${branch}.txt`, `${branch}\n`, branch);
      }
      git(octopus, ["checkout", "-q", "main"]);
      run(octopus, ["merge", "-q", "--no-commit", "o1", "o2", "o3"]);
      await commitFile(octopus, "octopus.txt", "marker-octopus\n", "octopus");
      const sha = git(octopus, ["rev-parse", "HEAD"]);
      // git itself shows no patch for it and says so only on stdout, so the preflight alone passes.
      const log = run(octopus, ["log", "-p", "-U0", ...REQUIRED_LOG_OPTS.split(" ")]);
      expect([log.status, log.stderr, log.stdout.includes("marker-octopus")]).toEqual([0, "", false]);
      for (const logOpts of [REQUIRED_LOG_OPTS, AUDIT_LOG_OPTS]) {
        const result = runScript(octopus, scanScriptPath, [stub], { LOG_OPTS: logOpts });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`octopus merge itself changes. Merge one branch at a time instead of:\n${sha}\n`);
      }
      expect(await stubCalls()).toEqual([]);
    });

    it("fails when git fails during Gitleaks' own run, which Gitleaks passes", async () => {
      const result = runScript(origin, scanScriptPath, [stub], {
        LOG_OPTS: REQUIRED_LOG_OPTS,
        STUB_STDERR: 'ERR [git] fatal: early EOF\nERR error="stderr is not empty"\nINF no leaks found\n',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("INF no leaks found\nThe scan is partial: git failed during Gitleaks' run.\n");
      expect(await stubCalls()).toHaveLength(3);
    });

    it("self-test fails unless Gitleaks reports exactly the expected fingerprints", async () => {
      const missing = runScript(directory, selfTestPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, STUB_REPORT: "" });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("self-test: Gitleaks did not report exactly the expected fingerprints");
      // It knows which fingerprints to expect only for the workflows' revisions.
      const unknown = runScript(directory, selfTestPath, [stub], { LOG_OPTS: "--full-history --text --remerge-diff main" });
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("self-test: LOG_OPTS must end with HEAD or --all");
      await stubCalls();
    });

    // Set GITLEAKS to a Gitleaks 8.30.1 binary to run the workflows' self-test here.
    it.skipIf(!process.env.GITLEAKS)("self-test passes with the pinned Gitleaks under both workflows' options", () => {
      for (const [logOpts, count] of [
        [REQUIRED_LOG_OPTS, 7],
        [AUDIT_LOG_OPTS, 8],
      ] as const) {
        const result = runScript(directory, selfTestPath, [process.env.GITLEAKS ?? ""], { LOG_OPTS: logOpts });
        expect(result.stderr).not.toContain("self-test:");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(
          `Secret scan self-test passed: ${count} fingerprints as expected; an octopus merge is refused.\n`,
        );
      }
    });
  });
});
