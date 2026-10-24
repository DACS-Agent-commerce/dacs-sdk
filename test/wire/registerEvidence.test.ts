// The register evidence checker as a command (scripts/wire/check-register-evidence.mjs).
// It exits 0 only when every evidence entry was checked and exists. When
// DACS_TP1_PRIVATE_PROVENANCE is unset it exits nonzero and names every private
// entry it did not check; no option makes a skipped entry count as a pass, and
// the removed --allow-private-skip is refused.
//
// The first block runs the command on a synthetic register over three scratch
// git repositories, so it needs no outside checkout. The second runs it on the
// real register; it needs the Standard and plugin checkouts
// (DACS_TP1_STANDARD_CHECKOUT, DACS_TP1_FRONTEND_CHECKOUT), this repository's
// history (or DACS_TP1_SDK_CHECKOUT) and, for the supplied case, the private
// provenance file (DACS_TP1_PRIVATE_PROVENANCE). Without them those tests are
// skipped and say so in their titles.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(root, "scripts/wire/check-register-evidence.mjs");
const PRIVATE = { source: "plugin implementation (not public)" };

/** Run the checker in its own Node process, with DACS_TP1_PRIVATE_PROVENANCE set to `privateFile` or unset. */
function check(args: string[], privateFile?: string, preload?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DACS_TP1_PRIVATE_PROVENANCE;
  if (privateFile !== undefined) env.DACS_TP1_PRIVATE_PROVENANCE = privateFile;
  const run = spawnSync(process.execPath, [...(preload ? ["--require", preload] : []), SCRIPT, ...args], { env, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
  const lines = run.stdout.trimEnd().split("\n");
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, lines, last: lines[lines.length - 1] };
}

describe("check-register-evidence.mjs on a synthetic register", () => {
  let dir: string;
  const commits: Record<string, string> = {};
  const args = () => ["--register", join(dir, "register.json"), "--dacs-sdk", join(dir, "sdk"), "--frontend", join(dir, "frontend"), "--standard", join(dir, "standard")];
  const privateFile = () => join(dir, "private.json");

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tp1-evidence-"));
    for (const repo of ["sdk", "frontend", "standard"]) {
      const at = join(dir, repo);
      mkdirSync(at);
      writeFileSync(join(at, "a.txt"), `${repo} one\n${repo} two\n${repo} three\n${repo} four\n`);
      mkdirSync(join(at, "sub"));
      writeFileSync(join(at, "sub/a.txt"), "nested\n");
      writeFileSync(join(at, "unterminated.txt"), "one\ntwo");
      writeFileSync(join(at, "single.txt"), "only line");
      const git = (...a: string[]) => {
        const r = spawnSync("git", ["-C", at, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
        return r.stdout.trim();
      };
      git("init", "-q");
      git("add", "a.txt", "sub/a.txt", "unterminated.txt", "single.txt");
      git("commit", "-q", "-m", "synthetic");
      commits[repo] = git("rev-parse", "HEAD");
    }
    const register = {
      rows: [
        { id: "R1", evidence: [{ repo: "dacs-sdk", commit: commits.sdk, path: "a.txt", lines: "1-2" }, { ...PRIVATE, provenance: "prov-01" }] },
        { id: "R2", evidence: [{ repo: "DACS-Standard", commit: commits.standard, path: "a.txt", lines: "3" }] },
      ],
      qualification: [{ subject: "producer: synthetic", evidence: [{ ...PRIVATE, provenance: "prov-02" }] }],
      network: { neverUsedAsPinEvidence: { evidence: [] } },
    };
    writeFileSync(join(dir, "register.json"), JSON.stringify(register));
    writeFileSync(join(dir, "private-no-entries.json"), "{}");
    writeFileSync(join(dir, "private-array-entries.json"), '{"entries":[]}');
    writeFileSync(join(dir, "warning.cjs"), "process.emitWarning('synthetic warning before checker refusal');\n");
    const cite = (lines: string) => ({ citations: [{ repo: "frontend", commit: commits.frontend, path: "a.txt", lines }] });
    writeFileSync(privateFile(), JSON.stringify({ entries: { "prov-01": cite("1-2"), "prov-02": cite("4"), "prov-03": cite("3") } }));
    writeFileSync(join(dir, "private-missing-prov-02.json"), JSON.stringify({ entries: { "prov-01": cite("1-2"), "prov-03": cite("3") } }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const runCitation = (patch: Record<string, unknown>, privateMode?: "cited" | "extra") => {
    const citation = { repo: "dacs-sdk", commit: commits.sdk, path: "a.txt", lines: "1", ...patch };
    const evidence = privateMode ? [{ ...PRIVATE, provenance: "prov-01" }] : [citation];
    const file = join(dir, "case-register.json"), privateAt = join(dir, "case-private.json");
    writeFileSync(file, JSON.stringify({ rows: [{ id: "R", evidence }], qualification: [] }));
    if (privateMode) writeFileSync(privateAt, JSON.stringify({ entries: {
      "prov-01": { citations: [privateMode === "cited" ? citation : { ...citation, lines: "1" }] },
      ...(privateMode === "extra" ? { "prov-02": { citations: [citation] } } : {}),
    } }));
    return check(["--register", file, "--dacs-sdk", join(dir, "sdk")], privateMode ? privateAt : undefined);
  };
  it.each(["", null, ":", "HEAD^{tree}", "HEAD:a.txt"])("rejects non-commit citation revision %j", commit => {
    const run = runCitation({ commit });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL");
  });
  it("rejects a directory citation instead of reading Git's tree listing", () => {
    const run = runCitation({ path: "sub" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("blob");
  });
  it.each(["1-2-999999", "1-1-garbage", [1], 1, "", "1-", "-1", "1.0", " 1", "01", "0", "5", "2-1", "9007199254740992", null, undefined])(
    "rejects malformed or out-of-range line citation %j", lines => {
      expect(runCitation({ lines }).status).toBe(1);
    });
  it.each([["a.txt", "4", "sdk four"], ["unterminated.txt", "2", "two"], ["single.txt", "1", "only line"]])(
    "counts the final line with or without a newline in %s", (path, lines, expected) => {
      const run = runCitation({ path, lines });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(expected);
    });
  it.each(["cited", "extra"] as const)("rejects a missing line range in %s private citations", mode => {
    const run = runCitation({ lines: undefined }, mode);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(mode === "extra" ? "FAIL  private" : "FAIL  R");
  });
  it.each([{ commit: "missing-citation-commit" }, { path: "missing-citation-file" }])("preserves Git's failure diagnostic for %j", patch => {
    const run = runCitation(patch);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("fatal:");
  });

  it("input unset: exits 2, prints SKIP for each private entry and names them all in its last line", () => {
    const run = check(args());
    expect(run.status).toBe(2);
    expect(run.lines.filter((line) => line.startsWith("SKIP"))).toEqual([
      "SKIP  R1: prov-01 (plugin implementation (not public)): private entry not checked, DACS_TP1_PRIVATE_PROVENANCE is unset",
      "SKIP  qualification: producer: synthetic: prov-02 (plugin implementation (not public)): private entry not checked, DACS_TP1_PRIVATE_PROVENANCE is unset",
    ]);
    expect(run.lines).toContain("2/4 evidence entries exist at their commits (2 public, 2 private)");
    expect(run.last).toBe("NOT CHECKED: 2 private entries skipped because DACS_TP1_PRIVATE_PROVENANCE is unset: R1 prov-01; qualification: producer: synthetic prov-02. This run is not a pass.");
  });

  it("input supplied: exits 0 with every entry and every other private entry checked", () => {
    const run = check(args(), privateFile());
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/^(SKIP|FAIL|NOT CHECKED)/m);
    expect(run.lines).toContain("4/4 evidence entries exist at their commits (2 public, 2 private)");
    expect(run.last).toBe("1/1 other private provenance entries resolve");
  });

  it("input supplied but missing a cited entry: exits 1 and names it", () => {
    const run = check(args(), join(dir, "private-missing-prov-02.json"));
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/^FAIL {2}qualification: producer: synthetic: prov-02 .*does not resolve in the private provenance file$/m);
  });

  it.each(["private-no-entries.json", "private-array-entries.json"])("malformed private input %s: exits 1 before checking evidence", (name) => {
    const run = check(args(), join(dir, name));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('has no "entries" object');
    expect(run.stdout).not.toContain("evidence entries exist");
  });

  it("the removed override is refused after a preceding Node warning", () => {
    const run = check([...args(), "--allow-private-skip", "true"], undefined, join(dir, "warning.cjs"));
    expect(run.status).toBe(64);
    expect(run.stderr).toMatch(/Warning: synthetic warning before checker refusal[\s\S]*^REFUSED: --allow-private-skip was removed/m);
    expect(run.stdout).toBe("");
  });

  it.each([
    ["--allow-private-skip true, input unset", ["--allow-private-skip", "true"], false],
    ["--allow-private-skip true, input supplied", ["--allow-private-skip", "true"], true],
    ["--allow-private-skip=true", ["--allow-private-skip=true"], false],
    ["--allow-private-skip with no value", ["--allow-private-skip"], false],
  ])("the removed override is refused before any check (%s)", (_, extra, supplied) => {
    const run = check([...args(), ...extra], supplied ? privateFile() : undefined);
    expect(run.status).not.toBe(0);
    expect(run.status).toBe(64);
    expect(run.stderr).toMatch(/^REFUSED: --allow-private-skip was removed: a skipped private entry is never a pass/m);
    expect(run.stdout).toBe("");
  });

  it.each([["--public-only", "true"], ["--skip-private", "true"], ["register.json"]])("an unknown option is refused (%s)", (...extra) => {
    const run = check([...args(), ...extra]);
    expect(run.status).toBe(64);
    expect(run.stderr).toMatch(/^REFUSED: unknown option/m);
    expect(run.stdout).toBe("");
  });
});

const standard = process.env.DACS_TP1_STANDARD_CHECKOUT;
const frontend = process.env.DACS_TP1_FRONTEND_CHECKOUT;
const sdk = process.env.DACS_TP1_SDK_CHECKOUT ?? (existsSync(join(root, ".git")) ? root : undefined);
const privateFile = process.env.DACS_TP1_PRIVATE_PROVENANCE;
const checkouts = Boolean(standard && frontend && sdk);
const notChecked = (needs: string) => ` (SKIPPED: ${needs} not given, so this was not checked)`;

describe("check-register-evidence.mjs on conformance/tp1-register.json", () => {
  const register = JSON.parse(readFileSync(join(root, "conformance/tp1-register.json"), "utf8"));
  type Entry = Record<string, string>;
  const owned = [
    ...register.rows.flatMap((row: { id: string; evidence: Entry[] }) => row.evidence.map((e) => [row.id, e] as const)),
    ...register.qualification.flatMap((q: { subject: string; evidence: Entry[] }) => q.evidence.map((e) => [`qualification: ${q.subject.slice(0, 40).trimEnd()}`, e] as const)),
    ...register.network.neverUsedAsPinEvidence.evidence.map((e: Entry) => ["network: neverUsedAsPin", e] as const),
  ] as Array<readonly [string, Entry]>;
  const privateIds = owned.filter(([, e]) => "provenance" in e).map(([owner, e]) => `${owner} ${e.provenance}`);
  const total = owned.length;
  const args = () => ["--register", join(root, "conformance/tp1-register.json"), "--dacs-sdk", sdk!, "--frontend", frontend!, "--standard", standard!];

  it("has private entries to skip", () => {
    expect(privateIds.length).toBeGreaterThan(0);
  });

  it.skipIf(!checkouts)(
    `input unset: exits 2 and names each of the register's private entries${checkouts ? "" : notChecked("the Standard, plugin and SDK checkouts")}`,
    () => {
      const run = check(args());
      expect(run.status).toBe(2);
      expect(run.lines.filter((line) => line.startsWith("SKIP")).length).toBe(privateIds.length);
      expect(run.lines).toContain(`${total - privateIds.length}/${total} evidence entries exist at their commits (${total - privateIds.length} public, ${privateIds.length} private)`);
      expect(run.last).toBe(`NOT CHECKED: ${privateIds.length} private entries skipped because DACS_TP1_PRIVATE_PROVENANCE is unset: ${privateIds.join("; ")}. This run is not a pass.`);
    },
  );

  it.skipIf(!checkouts || !privateFile)(
    `input supplied: exits 0 with every entry and every other private provenance entry checked${checkouts && privateFile ? "" : notChecked("the checkouts or DACS_TP1_PRIVATE_PROVENANCE")}`,
    () => {
      const run = check(args(), privateFile);
      const entries = JSON.parse(readFileSync(privateFile!, "utf8")).entries as Record<string, unknown>;
      const cited = new Set(owned.filter(([, e]) => "provenance" in e).map(([, e]) => e.provenance));
      const others = Object.keys(entries).filter((id) => !cited.has(id)).length;
      expect(run.status).toBe(0);
      expect(run.stdout).not.toMatch(/^(SKIP|FAIL|NOT CHECKED)/m);
      expect(run.lines).toContain(`${total}/${total} evidence entries exist at their commits (${total - privateIds.length} public, ${privateIds.length} private)`);
      expect(run.last).toBe(`${others}/${others} other private provenance entries resolve`);
    },
  );

  it("the removed --allow-private-skip is refused, nonzero, before any check", () => {
    const run = check(["--register", join(root, "conformance/tp1-register.json"), "--allow-private-skip", "true"]);
    expect(run.status).toBe(64);
    expect(run.stderr).toMatch(/^REFUSED: --allow-private-skip was removed/m);
    expect(run.stdout).toBe("");
  });
});
