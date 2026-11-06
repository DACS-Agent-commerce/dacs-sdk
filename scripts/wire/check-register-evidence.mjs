#!/usr/bin/env node
// Check that every evidence entry of conformance/tp1-register.json exists at
// the commit it names: `git show <commit>:<path>` succeeds and the cited line
// range lies inside the file. Prints each cited range for a reader to compare
// with the row's summary.
//
// A public entry is {repo, commit, path, lines}. A private entry is
// {source, provenance: "prov-NN"}: it cites the plugin implementation, which is
// not public, and its coordinates are kept in a private provenance file. When
// DACS_TP1_PRIVATE_PROVENANCE names that file, every private entry is resolved
// in it and its citations are checked the same way. When it is unset, private
// entries are not checked: each is printed as SKIP, the last line names them
// all, and the run exits 2. No option turns an unchecked entry into a pass.
//
// Exit status: 0 only when every entry was checked and exists; 1 when any entry
// is missing, out of range or malformed; 2 when any entry was not checked; 64
// when the invocation is refused (an unknown option, including the removed
// --allow-private-skip).
//
// Usage: [DACS_TP1_PRIVATE_PROVENANCE=<file>] node scripts/wire/check-register-evidence.mjs \
//   --register <register.json> --dacs-sdk <checkout> --frontend <checkout> --standard <checkout> \
//   [--out <file>]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const USAGE = "usage: check-register-evidence.mjs --register <file> --dacs-sdk <dir> --frontend <dir> --standard <dir> [--out <file>]";
const OPTIONS = new Set(["register", "dacs-sdk", "frontend", "standard", "out"]);
const refuse = (reason) => {
  console.error(`REFUSED: ${reason}`);
  console.error(USAGE);
  process.exit(64);
};
const argv = process.argv.slice(2);
if (argv.includes("--allow-private-skip") || argv.some((a) => a.startsWith("--allow-private-skip="))) {
  refuse("--allow-private-skip was removed: a skipped private entry is never a pass. Set DACS_TP1_PRIVATE_PROVENANCE to check the private entries");
}
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  const name = /^--([\w-]+)$/.exec(argv[i])?.[1];
  if (!name || !OPTIONS.has(name)) refuse(`unknown option ${JSON.stringify(argv[i])}`);
  if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) refuse(`--${name} needs a value`);
  if (name in args) refuse(`--${name} given twice`);
  args[name] = argv[i + 1];
}
if (!args.register) refuse("--register is required");
const repos = { "dacs-sdk": args["dacs-sdk"], frontend: args.frontend, "DACS-Standard": args.standard };
const register = JSON.parse(readFileSync(args.register, "utf8"));
const privatePath = process.env.DACS_TP1_PRIVATE_PROVENANCE;
const privateEntries = privatePath ? JSON.parse(readFileSync(privatePath, "utf8")).entries : null;
if (privatePath && (privateEntries === null || typeof privateEntries !== "object" || Array.isArray(privateEntries))) {
  throw new Error(`${privatePath} has no "entries" object`);
}
const PROVENANCE_ID = /^prov-\d{2}$/;

const entries = [
  ...register.rows.flatMap((row) => row.evidence.map((e) => ({ owner: row.id, ...e }))),
  ...register.qualification.flatMap((q) => q.evidence.map((e) => ({ owner: `qualification: ${q.subject.slice(0, 40).trimEnd()}`, ...e }))),
  ...(register.network?.neverUsedAsPinEvidence?.evidence ?? []).map((e) => ({ owner: "network: neverUsedAsPin", ...e })),
];
let failures = 0;
const skipped = [];
let extraFailures = 0;
let extraChecked = 0;
let publicCount = 0;
const out = [];
const log = (line) => { out.push(line); console.log(line); };

// Preserve Git's captured diagnostic in every public and private failure path.
const diagnostic = (error) => {
  const stderr = error?.stderr?.toString().trim();
  return stderr ? `${error.message}\n${stderr}` : String(error?.message ?? error);
};
const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});
// Every citation names a blob at a resolved commit and a required line range.
const show = (repo, commit, path, lines) => {
  const dir = repos[repo];
  if (!dir) throw new Error(`no checkout given for ${repo}`);
  if (typeof commit !== "string" || !commit.trim()) throw new Error("nonempty commit required");
  if (typeof path !== "string" || !path) throw new Error("nonempty blob path required");
  if (typeof lines !== "string" || !/^[1-9]\d*(?:-[1-9]\d*)?$/.test(lines)) throw new Error("lines must be N or N-N");
  const revision = git(dir, ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]).trim();
  const object = `${revision}:${path}`;
  if (git(dir, ["cat-file", "-t", object]).trim() !== "blob") throw new Error("citation path must name a blob");
  const text = git(dir, ["cat-file", "blob", object]).split("\n");
  if (text.at(-1) === "") text.pop();
  const [from, to = from] = lines.split("-").map(Number);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to > text.length) throw new Error(`lines ${lines} outside the file (${text.length} lines)`);
  const shown = [];
  for (let n = from; n <= to; n += 1) shown.push(`        ${n}: ${text[n - 1].slice(0, 160)}`);
  return shown;
};

for (const e of entries) {
  if ("provenance" in e) {
    const where = `${e.owner}: ${e.provenance} (${e.source})`;
    if (typeof e.provenance !== "string" || !PROVENANCE_ID.test(e.provenance)) {
      failures += 1;
      log(`FAIL  ${where}: malformed provenance ID, expected prov-NN`);
      continue;
    }
    if (!privateEntries) {
      skipped.push(`${e.owner} ${e.provenance}`);
      log(`SKIP  ${where}: private entry not checked, DACS_TP1_PRIVATE_PROVENANCE is unset`);
      continue;
    }
    try {
      const entry = privateEntries[e.provenance];
      if (!entry || !Array.isArray(entry.citations) || entry.citations.length === 0) throw new Error(`${e.provenance} does not resolve in the private provenance file`);
      const shown = entry.citations.flatMap((c) => [`      ${c.repo} ${c.commit}:${c.path}${c.lines ? `:${c.lines}` : ""}`, ...show(c.repo, c.commit, c.path, c.lines)]);
      log(`ok    ${where}`);
      for (const line of shown) log(line);
    } catch (error) {
      failures += 1;
      log(`FAIL  ${where}: ${diagnostic(error)}`);
    }
    continue;
  }
  publicCount += 1;
  const where = `${e.owner}: ${e.repo} ${e.commit}:${e.path}:${e.lines}`;
  try {
    const shown = show(e.repo, e.commit, e.path, e.lines);
    log(`ok    ${where}`);
    for (const line of shown) log(line);
  } catch (error) {
    failures += 1;
    log(`FAIL  ${where}: ${diagnostic(error)}`);
  }
}
// The private file also holds coordinates the documents and src/wire comments no
// longer carry (and the register's private source): check those entries too.
if (privateEntries) {
  const cited = new Set(entries.filter((e) => "provenance" in e).map((e) => e.provenance));
  for (const [id, entry] of Object.entries(privateEntries)) {
    if (cited.has(id)) continue;
    try {
      if (!PROVENANCE_ID.test(id) || !Array.isArray(entry.citations) || entry.citations.length === 0) throw new Error("malformed private entry");
      for (const c of entry.citations) show(c.repo, c.commit, c.path, c.lines);
      extraChecked += 1;
      log(`ok    private ${id} (not a register evidence entry): ${entry.citations.length} citation(s)`);
    } catch (error) {
      extraFailures += 1;
      log(`FAIL  private ${id}: ${diagnostic(error)}`);
    }
  }
}
const privateCount = entries.length - publicCount;
log(`${entries.length - failures - skipped.length}/${entries.length} evidence entries exist at their commits (${publicCount} public, ${privateCount} private)`);
if (privateEntries) log(`${extraChecked}/${extraChecked + extraFailures} other private provenance entries resolve`);
if (skipped.length > 0) {
  log(`NOT CHECKED: ${skipped.length} private entries skipped because DACS_TP1_PRIVATE_PROVENANCE is unset: ${skipped.join("; ")}. This run is not a pass.`);
}
if (args.out) writeFileSync(args.out, `${out.join("\n")}\n`);
process.exitCode = failures + extraFailures > 0 ? 1 : skipped.length > 0 ? 2 : 0;
