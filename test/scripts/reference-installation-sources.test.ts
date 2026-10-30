import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { packTarball, sri } from "./npm-archive-fixtures.js";

const referencePath = "../../scripts/reference-installation.mjs";
const { npmInstallContract, referenceInstallation } = await import(referencePath);
const shapes = ["resolved git+file", "resolved file directory", "resolved file archive", "version git URL", "resolved git+https", "name git URL"] as const;
const placements = ["root", "nested with edge", "nested without edge"] as const;
const cases = shapes.flatMap(shape => placements.filter(placement => shape !== "version git URL" || placement !== "nested with edge")
  .flatMap(placement => [true, false].map(inBundle => ({ shape, placement, inBundle, optional: false }))));
cases.push(...shapes.map(shape => ({ shape, placement: shape === "version git URL" ? "nested without edge" as const : "nested with edge" as const,
  inBundle: true, optional: true })));

describe("extraction source types", { timeout: 60_000 }, () => {
  let directory: string;
  let installer: ReturnType<typeof npmInstallContract>;
  let gitSource: string;
  let httpsSource: string;
  let localSource: string;
  let archiveSource: string;
  let gitLog: string;
  let prepareMarker: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "reference-sources-"));
    gitLog = join(directory, "git-calls.jsonl");
    prepareMarker = join(directory, "prepare-ran");
    const repository = join(directory, "source");
    mkdirSync(repository);
    writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "b", version: "1.0.0",
      scripts: { prepare: "node prepare.cjs" } }));
    writeFileSync(join(repository, "prepare.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(prepareMarker)}, 'ran');`);
    execFileSync("git", ["init", repository], { stdio: "pipe" });
    execFileSync("git", ["add", "package.json", "prepare.cjs"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "test: add local package fixture"], { cwd: repository, stdio: "pipe" });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    localSource = "file:" + repository;
    const archivePath = join(directory, "source.tgz");
    writeFileSync(archivePath, packTarball({ "package.json": readFileSync(join(repository, "package.json"), "utf8"),
      "prepare.cjs": readFileSync(join(repository, "prepare.cjs"), "utf8") }));
    archiveSource = "file:" + archivePath;
    const localUrl = pathToFileURL(repository).href;
    gitSource = `git+${localUrl}#${revision}`;
    const remoteUrl = "https://registry.invalid/local-source.git";
    httpsSource = `git+${remoteUrl}#${revision}`;
    // Every URL is rewritten to the local repository; the shim cannot contact a server.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = join(directory, "git");
    writeFileSync(shim, `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(args) + '\\n');
      const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)},
        args.map(arg => arg.replace(${JSON.stringify(remoteUrl)}, ${JSON.stringify(localUrl)})), { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    `);
    chmodSync(shim, 0o755);
    writeFileSync(join(directory, "package.json"), "{}");
    installer = npmInstallContract(directory);
    installer.config.git = shim;
    installer.env.PATH = directory + ":" + installer.env.PATH;
  });
  beforeEach(() => {
    rmSync(gitLog, { force: true });
    rmSync(prepareMarker, { force: true });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it.each(cases)("refuses $shape at $placement (inBundle=$inBundle, optional=$optional) before any git or prepare effect", ({ shape, placement, inBundle, optional }) => {
    const nested = placement !== "root";
    const location = nested ? "node_modules/a/node_modules/b" : "node_modules/b";
    const root = { dependencies: nested ? { a: "1.0.0" } : shape === "version git URL" ? {} : { b: "1.0.0" } };
    const entry: Record<string, unknown> = { version: "1.0.0", ...(inBundle ? { inBundle } : {}), ...(optional ? { optional } : {}) };
    if (shape === "version git URL") entry.version = gitSource;
    else if (shape === "name git URL") entry.name = gitSource;
    else entry.resolved = shape === "resolved git+file" ? gitSource : shape === "resolved git+https" ? httpsSource
      : shape === "resolved file archive" ? archiveSource : localSource;
    const packages: Record<string, Record<string, unknown>> = { "": root, [location]: entry };
    const archive = packTarball({ "package.json": JSON.stringify({ name: "a", version: "1.0.0",
      ...(placement === "nested with edge" ? { [optional ? "optionalDependencies" : "dependencies"]: { b: "1.0.0" } } : {}) }) });
    if (nested) packages["node_modules/a"] = { version: "1.0.0", resolved: "https://registry.invalid/a.tgz", integrity: sri(archive),
      ...(placement === "nested with edge" ? { [optional ? "optionalDependencies" : "dependencies"]: { b: "1.0.0" } } : {}) };
    const reference = referenceInstallation({ manifest: Buffer.from(JSON.stringify(root)), lock: { lockfileVersion: 3, packages }, installer,
      readArchive: () => archive });
    expect.soft(existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "", reference.errors.join()).toBe("");
    expect.soft(existsSync(prepareMarker)).toBe(false);
    expect(reference.errors.length).toBeGreaterThan(0);
    expect(reference.inventory).toBeNull();
    expect(reference.entries.size).toBe(0);
    expect(reference.carried.size).toBe(0);
    if (inBundle) expect(reference.errors.join()).toContain("non-registry archive extraction");
    else expect(reference.errors.join()).toContain("cannot authenticate an unverified registry archive");
    if (optional) expect(reference.errors.join()).toContain("archive extraction failed");
  });
});
