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
  for (const line of lines.slice(lines.indexOf("    steps:") + 1)) {
    if (line.startsWith("      - ")) steps.push([line]);
    else if (line === "" || line.startsWith("        ")) steps.at(-1)?.push(line);
    else break;
  }
  return steps.map((step) => step.join("\n").trimEnd());
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

// Gitleaks logs a git error but still passes, so each scan first runs the same log itself.
function scanScript(gitleaksArguments: string) {
  return [
    'if ! git log -p -U0 $LOG_OPTS > /dev/null 2> "$RUNNER_TEMP/git-log.err" || [ -s "$RUNNER_TEMP/git-log.err" ]; then',
    '  cat "$RUNNER_TEMP/git-log.err"',
    "  exit 1",
    "fi",
    `"$RUNNER_TEMP/gitleaks" git . --log-opts="$LOG_OPTS" ${gitleaksArguments}`,
  ].join("\n");
}

describe("secret scan workflows", () => {
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

  it("documents a local reproduction that fetches and scans what the audit does", async () => {
    const docs = await readFile(join(root, "docs/public-repository-cutover.md"), "utf8");
    expect(docs).toContain("\n  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1\n");
    expect(docs).toContain(`\n  ${valueOf(stepNamed(auditWorkflow, "Fetch pull request heads"), "run")}\n`);
    expect(docs).toContain(`\n  gitleaks git . --log-opts="${AUDIT_LOG_OPTS}" \\\n`);
  });

  it("pins every .gitleaksignore entry to a commit", async () => {
    const entries = (await readFile(join(root, ".gitleaksignore"), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"));
    expect(entries.length).toBeGreaterThan(0);
    // A `file:rule:line` entry would match that file, rule and line in every commit.
    for (const entry of entries) expect(entry).toMatch(/^[0-9a-f]{40}:.+:[A-Za-z0-9._-]+:[0-9]+$/);
  });
});

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
});
