import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
        expect(step.split("\n").filter((line) => /^ {6}(?:- | {2})if: /.test(line))).toEqual([]);
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
      // Exactly, so nothing can follow the checksum check that lets an unverified binary run.
      expect(valueOf(install, "run")).toBe(
        [
          'archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"',
          'download="$RUNNER_TEMP/$archive"',
          "curl --fail --location --proto '=https' --tlsv1.2 \\",
          '  --output "$download" \\',
          '  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}"',
          'echo "${GITLEAKS_ARCHIVE_SHA256}  ${download}" | sha256sum --check',
          'tar -xzf "$download" -C "$RUNNER_TEMP" gitleaks',
          '"$RUNNER_TEMP/gitleaks" version',
          "git --version",
        ].join("\n"),
      );
    }
  });

  // The image generation is fixed, but GitHub updates the git it comes with; the self-test checks that git.
  it("run on one image generation, pin every action to a commit and upload nothing", () => {
    for (const workflow of [requiredWorkflow, auditWorkflow]) {
      expect(workflow.match(/^ +runs-on: .*$/gm)).toEqual(["    runs-on: ubuntu-24.04"]);
      for (const step of stepsOf(workflow)) {
        const uses = valueOf(step, "uses");
        if (uses !== undefined) expect(uses).toMatch(/^actions\/checkout@[0-9a-f]{40} # v4$/);
      }
      expect(workflow).not.toContain("upload-artifact");
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

  it("audit every branch, tag and pull request head", () => {
    expect(stepNames(auditWorkflow)).toEqual([
      "actions/checkout",
      "Fetch pull request heads",
      "Install pinned Gitleaks",
      "Scan all branch history",
    ]);
    expect(valueOf(stepUsing(auditWorkflow, "actions/checkout"), "fetch-depth")).toBe("0");
    expect(valueOf(stepNamed(auditWorkflow, "Fetch pull request heads"), "run")).toBe(
      "git fetch --no-tags origin '+refs/pull/*/head:refs/pull/*/head'",
    );
    const scan = stepNamed(auditWorkflow, "Scan all branch history");
    expect(valueOf(scan, "id")).toBeUndefined();
    expect(valueOf(scan, "LOG_OPTS")).toBe(`"${AUDIT_LOG_OPTS}"`);
    expect(valueOf(scan, "run")).toBe(scanScript("--redact=100 --no-banner"));
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

  it("pins every .gitleaksignore entry to a commit", async () => {
    const lines = (await readFile(join(root, ".gitleaksignore"), "utf8")).split("\n");
    expect(lines.filter((line) => line.trim() !== "" && !line.startsWith("#")).length).toBeGreaterThan(0);
    expect(ignoreEntryProblems(lines)).toEqual([]);
  });

  it("rejects every entry without a commit", () => {
    const merge = "c".repeat(40);
    expect(ignoreEntryProblems([`${"a".repeat(40)}:src/a:b.ts:generic-api-key:4`, "", "# comment"])).toEqual([]);
    const rejected = [
      ["b/src/commitment.ts:generic-api-key:4"],
      [`# Reviewed in merge ${merge}: fixture`, "b/src/commitment.ts:generic-api-key:4"],
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

// The .gitleaksignore entries that are not `commit:file:rule:line`. An entry without a commit
// matches that file, rule and line in every commit.
function ignoreEntryProblems(lines: string[]) {
  return lines.filter(
    (line) => line.trim() !== "" && !line.startsWith("#") && !/^[0-9a-f]{40}:.+:[A-Za-z0-9._-]+:[0-9]+$/.test(line),
  );
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
    // Restricting history to HEAD without the default diff filter sees the type change,
    // but still misses merges and binary-marked paths.
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
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    let stub: string;
    let calls: string;
    let markerConfig: string;

    // A directory holding a `git` that runs `shellCode` and then the real git.
    async function gitShim(name: string, shellCode: string) {
      const shim = join(directory, name);
      await mkdir(shim);
      await writeFile(join(shim, "git"), ["#!/bin/sh", shellCode, `exec '${realGit}' "$@"`, ""].join("\n"), {
        mode: 0o755,
      });
      return { PATH: `${shim}:${process.env.PATH ?? ""}` };
    }

    // A directory holding a `wc` that pads each count as BSD and macOS `wc` do (" %7ju"), e.g. "       0".
    async function wcShim() {
      const realWc = spawnSync("sh", ["-c", "command -v wc"], { encoding: "utf8" }).stdout.trim();
      const shim = await mkdtemp(join(directory, "padding-wc-"));
      await writeFile(
        join(shim, "wc"),
        ["#!/bin/sh", `out=$('${realWc}' "$@") || exit`, 'for n in $out; do printf " %7s" "$n"; done', 'printf "\\n"', ""].join("\n"),
        { mode: 0o755 },
      );
      return { PATH: `${shim}:${process.env.PATH ?? ""}` };
    }

    // A stand-in for Gitleaks: records its arguments, runs `git log` as Gitleaks does (unless
    // STUB_SKIP_GIT is set) and saves what it read to STUB_LOG, writes STUB_REPORT to
    // --report-path, STUB_STDERR to stderr, and exits with STUB_STATUS.
    beforeAll(async () => {
      stub = join(directory, "gitleaks-stub");
      calls = join(directory, "gitleaks-calls");
      markerConfig = join(directory, "markers.toml");
      await writeFile(markerConfig, '[[rules]]\nid = "marker"\nregex = "marker-[a-z-]+"\n');
      await writeFile(
        stub,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$@" >> "$STUB_CALLS"',
          'for argument; do case "$argument" in --report-path=*) printf "%s" "$STUB_REPORT" > "${argument#--report-path=}";; --log-opts=*) opts=${argument#--log-opts=};; esac; done',
          'if [ -z "$STUB_SKIP_GIT" ]; then git -C . log -p -U0 $opts > "${STUB_LOG:-/dev/null}"; fi',
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
          STUB_SKIP_GIT: "",
          ...env,
        },
      });
    }

    async function stubCalls() {
      const text = existsSync(calls) ? await readFile(calls, "utf8") : "";
      await rm(calls, { force: true });
      return text.split("\n").filter((line) => line !== "");
    }

    // A failed test must not leave its calls for the next one.
    afterEach(async () => {
      await rm(calls, { force: true });
    });

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
      expect(result.stderr).toContain("INF no leaks found\nThe scan is partial: git failed during Gitleaks' run or wrote to stderr.\n");
      expect(await stubCalls()).toHaveLength(3);
    });

    for (const real of [false, true]) {
      it.skipIf(real && !process.env.GITLEAKS)(`fails on a git warning only during ${real ? "pinned Gitleaks'" : "the stub's"} own log`, async () => {
        // Gitleaks 8.30.1 explicitly accepts this diagnostic as a warning, even though the
        // workflows require every git log to finish with nothing on stderr.
        const warning = "warning: exhaustive rename detection was skipped due to too many files.";
        const shim = await gitShim(
          `warning-git-${real}`,
          `if [ "$1 $3" = "-C log" ]; then printf '%s\\n' '${warning}' >&2; fi`,
        );
        for (const logOpts of [REQUIRED_LOG_OPTS, AUDIT_LOG_OPTS]) {
          const report = join(directory, `warning-${real}.json`);
          const result = runScript(origin, scanScriptPath, [
            real ? process.env.GITLEAKS ?? "" : stub,
            `--config=${markerConfig}`, "--exit-code=0", "--no-banner",
            "--report-format=json", `--report-path=${report}`,
          ], { LOG_OPTS: logOpts, ...shim });
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(warning);
          expect(result.stderr).toContain("The scan is partial: git failed during Gitleaks' run or wrote to stderr.");
          if (real) {
            expect(result.stderr).not.toContain("stderr is not empty");
            const findings = JSON.parse(await readFile(report, "utf8"));
            expect(findings.map((finding: { Secret: string }) => finding.Secret).sort()).toEqual(
              (logOpts === AUDIT_LOG_OPTS ? [...markers, pullOnly] : [...markers]).sort(),
            );
          } else {
            expect(await stubCalls()).toHaveLength(8);
          }
        }
      });
    }

    it("fails when Gitleaks' git log dies without a word on stderr, or never runs", async () => {
      // A git that prints part of Gitleaks' log and is then killed, as the OOM killer would.
      const dying = await gitShim(
        "dying-git",
        `if [ "$1 $3" = "-C log" ]; then '${realGit}' "$@" | head -c 100; kill -KILL $$; fi`,
      );
      for (const env of [dying, { STUB_SKIP_GIT: "1" }]) {
        const result = runScript(origin, scanScriptPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, ...env });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("The scan is partial: Gitleaks' git log did not run, or did not finish.\n");
        expect(await stubCalls()).toHaveLength(3);
      }
    });

    it("gives Gitleaks git's log without its remerge lines, so every merge keeps its commit", async () => {
      const read = join(directory, "gitleaks-read.log");
      const result = runScript(origin, scanScriptPath, [stub], { LOG_OPTS: AUDIT_LOG_OPTS, STUB_LOG: read });
      expect(result.status).toBe(0);
      const log = run(origin, ["-C", ".", "log", "-p", "-U0", ...AUDIT_LOG_OPTS.split(" ")]).stdout;
      expect(log).toMatch(/^remerge CONFLICT \(content\): Merge conflict in conflict\.txt$/m);
      expect(await readFile(read, "utf8")).toBe(log.replace(/^remerge .*\n/gm, ""));
      await stubCalls();
    });

    it("drops git's remerge lines and their continuations from file headers, and nothing else", async () => {
      const sha = (digit: string) => digit.repeat(40);
      // What git prints for a merge's remerge diff, with one of each header line; `dropped` marks
      // the lines Gitleaks must not see.
      const lines: [string, boolean][] = [
        [`commit ${sha("1")}`, false],
        ["Merge: 2222222 3333333", false],
        ["Author: fixture <fixture@example.invalid>", false],
        ["Date:   Thu Oct 15 00:00:00 2026 +0000", false],
        ["", false],
        ["    remerge: a commit message line", false],
        ["", false],
        ["diff --git a/kept.txt b/kept.txt", false],
        ["remerge CONFLICT (modify/delete): kept.txt deleted in 3333333 (side) and modified in 2222222 (main).", true],
        ['diff --git "a/nl\\ncommit.txt" "b/nl\\ncommit.txt"', false],
        ["remerge CONFLICT (content): Merge conflic  in nl", true],
        // git's continuation of that message, after a stray byte.
        ["3commit.txt", true],
        ["index 1111111..2222222 100644", false],
        ['--- "a/nl\\ncommit.txt"', false],
        ['+++ "b/nl\\ncommit.txt"', false],
        ["@@ -1,5 +1,2 @@", false],
        ["-<<<<<<< 2222222 (main)", false],
        ["-remerge removed", false],
        ["+x remerge y", false],
        ["+remerge added", false],
        ["\\ No newline at end of file", false],
        ["diff --git a/image.bin b/image.bin", false],
        ["remerge warning: Cannot merge binary files: image.bin (2222222 vs. 3333333)", true],
        ["index 3333333..4444444 100644", false],
        ["Binary files a/image.bin and b/image.bin differ", false],
        ["diff --git a/old.txt b/new.txt", false],
        ["similarity index 90%", false],
        ["rename from old.txt", false],
        ["rename to new.txt", false],
        ["--- a/old.txt", false],
        ["+++ b/new.txt", false],
        ["@@ -1 +1 @@", false],
        ["+marker-renamed", false],
        ["diff --git a/a.txt b/copy.txt", false],
        ["dissimilarity index 10%", false],
        ["copy from a.txt", false],
        ["copy to copy.txt", false],
        ["diff --git a/mode.sh b/mode.sh", false],
        ["old mode 100644", false],
        ["new mode 100755", false],
        ["diff --git a/gone.txt b/gone.txt", false],
        ["deleted file mode 100644", false],
        ["index 5555555..0000000", false],
        ["diff --git a/added.txt b/added.txt", false],
        ["new file mode 100644", false],
        ["index 0000000..6666666", false],
        ["--- /dev/null", false],
        ["+++ b/added.txt", false],
        ["@@ -0,0 +1 @@", false],
        ["+marker-added", false],
        ["diff --git a/last.txt b/last.txt", false],
        ["remerge CONFLICT (modify/delete): last.txt deleted in 3333333 (side) and modified in 2222222 (main).", true],
        [`commit ${sha("4")}`, false],
        ["Author: fixture <fixture@example.invalid>", false],
        ["", false],
        ["    next", false],
        ["", false],
      ];
      const fixture = join(directory, "remerge-fixture.log");
      await writeFile(fixture, lines.map(([line]) => `${line}\n`).join(""));
      const crafted = await gitShim("crafted-git", `if [ "$1 $3" = "-C log" ]; then cat '${fixture}'; exit; fi`);
      const read = join(directory, "gitleaks-read-crafted.log");
      const result = runScript(origin, scanScriptPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, STUB_LOG: read, ...crafted });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(await readFile(read, "utf8")).toBe(
        lines
          .filter(([, dropped]) => !dropped)
          .map(([line]) => `${line}\n`)
          .join(""),
      );
    });

    it("refuses an octopus merge that only a pull request head reaches, in the audit", async () => {
      const repository = join(directory, "octopus-pull");
      await mkdir(repository);
      git(repository, ["init", "-q", "-b", "main"]);
      await commitFile(repository, "README", "fixture\n", "base");
      for (const branch of ["o1", "o2", "o3"]) {
        git(repository, ["checkout", "-q", "-b", branch, "main"]);
        await commitFile(repository, `${branch}.txt`, `${branch}\n`, branch);
      }
      run(repository, ["merge", "-q", "--no-commit", "o1", "o2"]);
      await commitFile(repository, "octopus.txt", "marker-octopus\n", "octopus");
      const sha = git(repository, ["rev-parse", "HEAD"]);
      git(repository, ["update-ref", "refs/pull/9/head", "HEAD"]);
      git(repository, ["checkout", "-q", "main"]);
      git(repository, ["branch", "-q", "-D", "o1", "o2", "o3"]);
      expect(git(repository, ["rev-list", "--parents", "-n", "1", sha]).split(" ")).toHaveLength(4);
      const audit = runScript(repository, scanScriptPath, [stub], { LOG_OPTS: AUDIT_LOG_OPTS });
      expect(audit.status).toBe(1);
      expect(audit.stderr).toContain(`Merge one branch at a time instead of:\n${sha}\n`);
      expect(await stubCalls()).toEqual([]);
      // The required scan's history doesn't reach it.
      const required = runScript(repository, scanScriptPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS });
      expect(required.status).toBe(0);
      expect(await stubCalls()).toEqual(["git", ".", `--log-opts=${REQUIRED_LOG_OPTS}`]);
    });

    for (const [kind, unsupportedPath, reason] of [
      ["newline", "nl\ncommit.txt", "after a path containing a newline, Gitleaks can report a finding under another commit or file"],
      ["trailing-backslash", "hidden\\", "Gitleaks can't preserve a backslash path in an exact ignore entry"],
      ["interior-backslash", "ordinary\\name.txt", "Gitleaks can't preserve a backslash path in an exact ignore entry"],
      ["backslash-directory", "ordinary\\/name.txt", "Gitleaks can't preserve a backslash path in an exact ignore entry"],
    ] as const) {
      it(`refuses a ${kind} path wherever the scanned history has one, and lists its commits`, async () => {
        const refusal = `Nothing was scanned: ${reason}. Rewrite the history without it; these commits add, change or delete one:\n`;
        // In the root commit, which has no parent to compare with.
        const root = join(directory, `${kind}-root`);
        await mkdir(root);
        git(root, ["init", "-q", "-b", "main"]);
        await mkdir(join(root, unsupportedPath, ".."), { recursive: true });
        await commitFile(root, unsupportedPath, "root\n", "root");
        const rootSha = git(root, ["rev-parse", "HEAD"]);
        await commitFile(root, "README", "fixture\n", "readme");
        // Refuse the history even after the unsupported path is gone from the current tree.
        git(root, ["rm", "--", unsupportedPath]);
        git(root, ["commit", "-q", "-m", "delete unsupported path"]);
        const deleteSha = git(root, ["rev-parse", "HEAD"]);
        // Added only by a merge, which git log shows no paths for without a merge diff.
        const merge = join(directory, `${kind}-merge`);
        await mkdir(merge);
        git(merge, ["init", "-q", "-b", "main"]);
        await commitFile(merge, "README", "fixture\n", "base");
        git(merge, ["checkout", "-q", "-b", "side"]);
        await commitFile(merge, "side.txt", "side\n", "side");
        git(merge, ["checkout", "-q", "main"]);
        await commitFile(merge, "main.txt", "main\n", "main");
        run(merge, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
        await mkdir(join(merge, unsupportedPath, ".."), { recursive: true });
        await commitFile(merge, unsupportedPath, "merged\n", "merge");
        const mergeSha = git(merge, ["rev-parse", "HEAD"]);
        // In a directory, which git diff-tree lists as only `src` unless it recurses.
        const nested = join(directory, `${kind}-nested`);
        await mkdir(join(nested, "src"), { recursive: true });
        git(nested, ["init", "-q", "-b", "main"]);
        await commitFile(nested, "README", "fixture\n", "base");
        await mkdir(join(nested, "src", unsupportedPath, ".."), { recursive: true });
        await commitFile(nested, `src/${unsupportedPath}`, "nested\n", "nested");
        const nestedSha = git(nested, ["rev-parse", "HEAD"]);
        await commitFile(nested, "README", "changed\n", "readme");
        // Each case also with a `wc` that pads its counts, as BSD and macOS `wc` do.
        const padding = await wcShim();
        for (const env of [{}, padding]) {
          for (const [repository, sha] of [
            [root, `${deleteSha}\n${rootSha}`],
            [merge, mergeSha],
            [nested, nestedSha],
          ] as const) {
            for (const logOpts of [REQUIRED_LOG_OPTS, AUDIT_LOG_OPTS]) {
              const result = runScript(repository, scanScriptPath, [stub], { LOG_OPTS: logOpts, ...env });
              expect(result.status).toBe(1);
              expect(result.stderr).toBe(`${refusal}${sha}\n`);
            }
          }
        }
        expect(await stubCalls()).toEqual([]);

        // Changed only on a pull request head: the audit refuses it, the required scan doesn't reach it.
        const pull = join(directory, `${kind}-pull`);
        await mkdir(pull);
        git(pull, ["init", "-q", "-b", "main"]);
        await commitFile(pull, "README", "fixture\n", "base");
        git(pull, ["checkout", "-q", "-b", "pull"]);
        await mkdir(join(pull, unsupportedPath, ".."), { recursive: true });
        await commitFile(pull, unsupportedPath, "pull\n", "pull");
        const pullSha = git(pull, ["rev-parse", "HEAD"]);
        git(pull, ["update-ref", "refs/pull/9/head", "HEAD"]);
        git(pull, ["checkout", "-q", "main"]);
        git(pull, ["branch", "-q", "-D", "pull"]);
        const audit = runScript(pull, scanScriptPath, [stub], { LOG_OPTS: AUDIT_LOG_OPTS });
        expect(audit.status).toBe(1);
        expect(audit.stderr).toBe(`${refusal}${pullSha}\n`);
        expect(await stubCalls()).toEqual([]);
        for (const env of [{}, padding]) {
          const required = runScript(pull, scanScriptPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, ...env });
          expect(required.status).toBe(0);
          expect(await stubCalls()).toEqual(["git", ".", `--log-opts=${REQUIRED_LOG_OPTS}`]);
        }
      });
    }

    it.skipIf(!process.env.GITLEAKS)("refuses a history containing only a trailing-backslash path before pinned Gitleaks can return an empty report", async () => {
      const repository = join(directory, "trailing-only");
      await mkdir(repository);
      git(repository, ["init", "-q", "-b", "main"]);
      await commitFile(repository, "hidden\\", "marker-hidden\n", "hidden");
      const sha = git(repository, ["rev-parse", "HEAD"]);
      for (const logOpts of [REQUIRED_LOG_OPTS, AUDIT_LOG_OPTS]) {
        const report = join(directory, "trailing-only.json");
        const result = runScript(repository, scanScriptPath, [
          process.env.GITLEAKS ?? "", `--config=${markerConfig}`, "--exit-code=0", "--no-banner",
          "--report-format=json", `--report-path=${report}`,
        ], { LOG_OPTS: logOpts });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Gitleaks can't preserve a backslash path in an exact ignore entry.`);
        expect(result.stderr).toContain(`\n${sha}\n`);
        expect(existsSync(report)).toBe(false);
      }
    });

    it.skipIf(!process.env.GITLEAKS)("refuses an interior backslash and its slash counterpart before applying a misleading ignore pin", async () => {
      const repository = join(directory, "backslash-alias");
      await mkdir(join(repository, "ordinary"), { recursive: true });
      git(repository, ["init", "-q", "-b", "main"]);
      await writeFile(join(repository, "ordinary\\name.txt"), "marker-reviewed\n");
      await commitFile(repository, "ordinary/name.txt", "marker-unreviewed\n", "both paths");
      const sha = git(repository, ["rev-parse", "HEAD"]);
      await writeFile(join(repository, ".gitleaksignore"), `${sha}:ordinary\\name.txt:marker:1\n`);
      for (const logOpts of [REQUIRED_LOG_OPTS, AUDIT_LOG_OPTS]) {
        const report = join(directory, "backslash-alias.json");
        const result = runScript(repository, scanScriptPath, [
          process.env.GITLEAKS ?? "", `--config=${markerConfig}`, "--no-banner",
          "--report-format=json", `--report-path=${report}`,
        ], { LOG_OPTS: logOpts });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Gitleaks can't preserve a backslash path in an exact ignore entry.");
        expect(result.stderr).toContain(`\n${sha}\n`);
        expect(existsSync(report)).toBe(false);
      }
    });

    for (const real of [false, true]) {
      it.skipIf(real && !process.env.GITLEAKS)(`refuses byte-distinct invalid UTF-8 paths before ${real ? "pinned Gitleaks" : "the stub"} runs`, async () => {
        const repository = join(directory, `invalid-utf8-${real}`);
        await mkdir(repository);
        git(repository, ["init", "-q", "-b", "main"]);
        // Go's JSON encoder replaces each of these different bytes with U+FFFD.
        const paths = [0xff, 0xfe].map((byte) => Buffer.concat([
          Buffer.from(`${repository}/bad-`), Buffer.from([byte]), Buffer.from(".txt"),
        ]));
        for (const path of paths) await writeFile(path, "marker-invalid\n");
        git(repository, ["add", "--all"]);
        git(repository, ["commit", "-q", "-m", "invalid byte paths"]);
        const added = git(repository, ["rev-parse", "HEAD"]);
        for (const path of paths) await unlink(path);
        git(repository, ["add", "--all"]);
        git(repository, ["commit", "-q", "-m", "delete invalid byte paths"]);
        const removed = git(repository, ["rev-parse", "HEAD"]);
        for (const logOpts of [REQUIRED_LOG_OPTS, AUDIT_LOG_OPTS]) {
          const report = join(directory, `invalid-utf8-${real}.json`);
          const result = runScript(repository, scanScriptPath, [
            real ? process.env.GITLEAKS ?? "" : stub, `--config=${markerConfig}`, "--no-banner",
            "--report-format=json", `--report-path=${report}`,
          ], { LOG_OPTS: logOpts });
          expect(result.status).toBe(1);
          expect(result.stderr).toBe(
            "Nothing was scanned: Gitleaks can't preserve an invalid UTF-8 path in JSON. Rewrite the history without it; these commits add, change or delete one:\n" +
            `${removed}\n${added}\n`,
          );
          expect(existsSync(report)).toBe(false);
        }
        expect(await stubCalls()).toEqual([]);
      });
    }

    for (const real of [false, true]) {
      it.skipIf(real && !process.env.GITLEAKS)(`checks nested invalid UTF-8 merge paths on PR-only history with ${real ? "pinned Gitleaks" : "the stub"}, while accepting valid Unicode`, async () => {
        const repository = join(directory, `invalid-utf8-merge-${real}`);
        await mkdir(join(repository, "目录"), { recursive: true });
        git(repository, ["init", "-q", "-b", "main"]);
        await commitFile(repository, "目录/é.txt", "marker-unicode\n", "valid Unicode");
        const valid = git(repository, ["rev-parse", "HEAD"]);
        git(repository, ["checkout", "-q", "-b", "side"]);
        await commitFile(repository, "side.txt", "side\n", "side");
        git(repository, ["checkout", "-q", "-b", "pull", "main"]);
        await commitFile(repository, "pull.txt", "pull\n", "pull");
        run(repository, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
        await writeFile(Buffer.concat([
          Buffer.from(`${repository}/目录/bad-`), Buffer.from([0xff]), Buffer.from(".txt"),
        ]), "marker-invalid\n");
        git(repository, ["add", "--all"]);
        git(repository, ["commit", "-q", "-m", "merge adds nested invalid path"]);
        const merge = git(repository, ["rev-parse", "HEAD"]);
        git(repository, ["update-ref", "refs/pull/9/head", "HEAD"]);
        git(repository, ["checkout", "-q", "main"]);
        git(repository, ["branch", "-q", "-D", "side", "pull"]);
        const report = join(directory, `invalid-utf8-merge-${real}.json`);
        const args = [real ? process.env.GITLEAKS ?? "" : stub, `--config=${markerConfig}`,
          "--exit-code=0", "--no-banner", "--report-format=json", `--report-path=${report}`];
        const audit = runScript(repository, scanScriptPath, args, { LOG_OPTS: AUDIT_LOG_OPTS });
        expect(audit.status).toBe(1);
        expect(audit.stderr).toContain("Gitleaks can't preserve an invalid UTF-8 path in JSON.");
        expect(audit.stderr).toContain(`\n${merge}\n`);
        expect(existsSync(report)).toBe(false);
        expect(await stubCalls()).toEqual([]);
        const required = runScript(repository, scanScriptPath, args, { LOG_OPTS: REQUIRED_LOG_OPTS });
        expect(required.status).toBe(0);
        if (real) {
          expect(JSON.parse(await readFile(report, "utf8")).map((finding: { Fingerprint: string }) => finding.Fingerprint)).toEqual(
            [`${valid}:目录/é.txt:marker:1`],
          );
        } else {
          expect(await stubCalls()).toEqual(["git", ".", `--log-opts=${REQUIRED_LOG_OPTS}`, ...args.slice(1)]);
        }
      });
    }

    it.skipIf(!process.env.GITLEAKS)("honors a colon-filename pin without printing it, while leaving the other finding visible", async () => {
      const repository = join(directory, "colon-pin");
      await mkdir(repository);
      git(repository, ["init", "-q", "-b", "main"]);
      await writeFile(join(repository, "private:reviewed.txt"), "marker-reviewed\n");
      await commitFile(repository, "other.txt", "marker-unreviewed\n", "two findings");
      const sha = git(repository, ["rev-parse", "HEAD"]);
      const pin = `${sha}:private:reviewed.txt:marker:1`;
      const report = join(directory, "colon-pin.json");
      for (const logOpts of [REQUIRED_LOG_OPTS, AUDIT_LOG_OPTS]) {
        // First prove both findings exist, then prove the exact pin hides only its own.
        await rm(join(repository, ".gitleaksignore"), { force: true });
        const scan = () => runScript(repository, scanScriptPath, [
          process.env.GITLEAKS ?? "", `--config=${markerConfig}`, "--redact=100", "--no-banner",
          "--report-format=json", `--report-path=${report}`,
        ], { LOG_OPTS: logOpts });
        expect(scan().status).toBe(1);
        const findings = JSON.parse(await readFile(report, "utf8"));
        expect(findings.map((finding: { Fingerprint: string }) => finding.Fingerprint).sort()).toEqual(
          [`${sha}:other.txt:marker:1`, pin].sort(),
        );
        await writeFile(join(repository, ".gitleaksignore"), `${pin}\n`);
        const result = scan();
        expect(result.status).toBe(1); // The unreviewed finding still fails the scan.
        expect(result.stdout + result.stderr).not.toContain("private:reviewed.txt");
        expect(result.stdout + result.stderr).not.toContain(pin);
        expect(result.stderr).toContain("ignore-entry diagnostic hidden");
        expect(JSON.parse(await readFile(report, "utf8")).map((finding: { Fingerprint: string }) => finding.Fingerprint)).toEqual(
          [`${sha}:other.txt:marker:1`],
        );
        await writeFile(join(repository, ".gitleaksignore"), `${pin}\n${sha}:other.txt:marker:1\n`);
        const clean = scan();
        expect(clean.status).toBe(0);
        expect(clean.stdout + clean.stderr).not.toContain("private:reviewed.txt");
        expect(JSON.parse(await readFile(report, "utf8"))).toEqual([]);
      }
    });

    it("self-test fails unless Gitleaks reports exactly the expected fingerprints", async () => {
      const missing = runScript(directory, selfTestPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, STUB_REPORT: "" });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("self-test: Gitleaks did not report exactly the expected fingerprints");
      expect(await stubCalls()).not.toEqual([]);
      // It knows which fingerprints to expect only for the workflows' revisions.
      const unknown = runScript(directory, selfTestPath, [stub], { LOG_OPTS: "--full-history --text --remerge-diff main" });
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain("self-test: LOG_OPTS must end with HEAD or --all");
      expect(await stubCalls()).toEqual([]);
      // Each check of git's own output stops the self-test before anything is scanned.
      // A git that no longer prints the remerge line the commit-less case relies on.
      const quiet = await gitShim(
        "no-remerge-git",
        `if [ "$1" = log ]; then '${realGit}' "$@" | sed '/^remerge /d'; exit; fi`,
      );
      const noRemerge = runScript(directory, selfTestPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, ...quiet });
      expect(noRemerge.status).toBe(1);
      expect(noRemerge.stderr).toContain("self-test: git no longer shows the remerge CONFLICT line this case needs");
      expect(noRemerge.stderr).not.toContain("later.txt");
      expect(await stubCalls()).toEqual([]);
      // A git whose patch for that merge has no file after the conflicted one: the case would show nothing.
      const noLater = await gitShim(
        "no-later-git",
        `if [ "$1" = log ]; then '${realGit}' "$@" | sed '/^diff --git a\\/later\\.txt /d'; exit; fi`,
      );
      const later = runScript(directory, selfTestPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, ...noLater });
      expect(later.status).toBe(1);
      expect(later.stderr).toContain("self-test: git no longer shows later.txt after the conflicted file in the merge's patch");
      expect(await stubCalls()).toEqual([]);
      // A git whose default options would show a merge: the control must fail.
      const merging = await gitShim(
        "merging-git",
        `case " $* " in *" --diff-filter=tuxdb "*) exec '${realGit}' "$@" --text --remerge-diff;; esac`,
      );
      const defaults = runScript(directory, selfTestPath, [stub], { LOG_OPTS: REQUIRED_LOG_OPTS, ...merging });
      expect(defaults.status).toBe(1);
      expect(defaults.stderr).toContain("self-test: Gitleaks' default options see more than the control case");
      expect(await stubCalls()).toEqual([]);
    });

    it("self-test reads git's messages in English whatever the caller's locale", async () => {
      // git translates `CONFLICT`, as its German translation does here, unless LC_ALL is C.
      const translating = await gitShim(
        "translating-git",
        `if [ "$1" = log ] && [ "$LC_ALL" != C ]; then '${realGit}' "$@" | sed 's/^remerge CONFLICT/remerge KONFLIKT/'; exit; fi`,
      );
      const result = runScript(directory, selfTestPath, [stub], {
        LOG_OPTS: REQUIRED_LOG_OPTS,
        LC_ALL: "de_DE.UTF-8",
        ...translating,
      });
      expect(result.stderr).not.toContain("remerge CONFLICT line");
      // The stub reports nothing, so it gets as far as comparing fingerprints.
      expect(result.stderr).toContain("self-test: Gitleaks did not report exactly the expected fingerprints");
      expect(result.status).toBe(1);
    });

    // Set GITLEAKS to a Gitleaks 8.30.1 binary to run the workflows' self-test here.
    for (const [mode, logOpts, count] of [
      ["required", REQUIRED_LOG_OPTS, 7],
      ["audit", AUDIT_LOG_OPTS, 8],
    ] as const) {
      for (const [wcStyle, padded] of [["normal", false], ["padded", true]] as const) {
        it.skipIf(!process.env.GITLEAKS)(`self-test passes with the pinned Gitleaks under ${mode} options and ${wcStyle} wc`, async () => {
          const env = padded ? await wcShim() : {};
          const result = runScript(directory, selfTestPath, [process.env.GITLEAKS ?? ""], { LOG_OPTS: logOpts, ...env });
          expect(result.stderr).not.toContain("self-test:");
          expect(result.status).toBe(0);
          expect(result.stdout).toBe(
            `Secret scan self-test passed: ${count} fingerprints as expected; an octopus merge, paths containing a newline or a backslash and invalid UTF-8 paths are refused.\n`,
          );
        });
      }
    }

    for (const [name, from, to, message] of [
      ["doesn't refuse octopus merges", 'if [ -n "$octopus" ]; then', "if false; then", "an octopus merge"],
      ["doesn't refuse paths containing a newline", 'if ! [ "$newlines" -eq 0 ]; then', "if false; then", "a path containing a newline"],
      ["refuses a path containing a newline without naming its commits", '      echo "$commit"\n', "      :\n", "a path containing a newline"],
    ] as const) {
      it.skipIf(!process.env.GITLEAKS)(`self-test fails with a scan that ${name}`, async () => {
        const scripts = join(directory, `mutated-${name.replaceAll(" ", "-")}`);
        await mkdir(scripts);
        const scan = await readFile(scanScriptPath, "utf8");
        expect(scan).toContain(from);
        await writeFile(join(scripts, "secret-scan.sh"), scan.replace(from, to));
        await writeFile(join(scripts, "secret-scan-self-test.sh"), await readFile(selfTestPath, "utf8"));
        const result = runScript(directory, join(scripts, "secret-scan-self-test.sh"), [process.env.GITLEAKS ?? ""], {
          LOG_OPTS: REQUIRED_LOG_OPTS,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`self-test: the scan did not refuse ${message} before running Gitleaks`);
      });
    }
  });
});
