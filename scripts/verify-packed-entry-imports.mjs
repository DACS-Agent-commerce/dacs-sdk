// Packs the SDK, installs the tarball with the lowest demosdk its peer range allows into an
// empty ES module project, and imports every exported entry point in a fresh Node process.
// Run `npm run build` first. It exits 1 when any entry point cannot be imported.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const DEMOSDK = "@kynesyslabs/demosdk";
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const IMPORT_TIMEOUT_MS = 60 * 1000;
const COMMAND_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

/**
 * The lowest version a semver range allows.
 * @throws when the range allows no version.
 */
export function lowestAllowedVersion(range) {
  const lowest = semver.minVersion(range);
  if (lowest === null) throw new Error(`range allows no version: ${range}`);
  return lowest.version;
}

/**
 * The import specifier of every entry point in a package manifest's `exports` map.
 * @throws when an entry point has no `import` target, so it could not be checked.
 */
export function entryPointSpecifiers(manifest) {
  return Object.entries(manifest.exports).map(([key, target]) => {
    if (typeof target?.import !== "string") throw new Error(`export ${key} has no import target`);
    return key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
  });
}

function importFailure(result) {
  const lastLine = result.stderr.trim().split("\n").at(-1) ?? "";
  try {
    const { code, message } = JSON.parse(lastLine);
    return { code: code ?? "unknown", message };
  } catch {
    if (result.error?.code === "ETIMEDOUT") return { code: "ETIMEDOUT", message: `no result within ${IMPORT_TIMEOUT_MS} ms` };
    return { code: "unknown", message: lastLine || `exit ${result.status}` };
  }
}

/**
 * Imports each specifier from `projectDir` in its own Node process.
 * @returns one `{ specifier, ok, code?, message? }` per specifier, in order.
 */
export function importEntryPoints({ projectDir, specifiers, nodePath = process.execPath }) {
  return specifiers.map((specifier) => {
    const program = `import(${JSON.stringify(specifier)}).catch((error) => {
      console.error(JSON.stringify({ code: error?.code, message: String(error?.message) }));
      process.exit(1);
    });`;
    const result = spawnSync(nodePath, ["--input-type=module", "-e", program], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: IMPORT_TIMEOUT_MS,
      maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
    });
    return result.status === 0 && !result.error ? { specifier, ok: true } : { specifier, ok: false, ...importFailure(result) };
  });
}

function runNpm(args, options = {}) {
  const result = spawnSync("npm", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed: ${result.error?.message ?? `exit ${result.status}`}\n${result.stderr}`);
  }
  return result.stdout;
}

async function packSdk(destination) {
  await stat(join(repoRoot, "dist")).catch(() => {
    throw new Error("dist/ is missing; run `npm run build` first");
  });
  const [{ filename }] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", destination]));
  return join(destination, filename);
}

async function installIntoEmptyProject(projectDir, tarball, demosdkVersion) {
  await mkdir(projectDir);
  await writeFile(join(projectDir, "package.json"), `${JSON.stringify({ name: "packed-entry-imports", private: true, type: "module" })}\n`);
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, `${DEMOSDK}@${demosdkVersion}`], { cwd: projectDir });
}

async function main() {
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const demosdkVersion = lowestAllowedVersion(manifest.peerDependencies[DEMOSDK]);
  const specifiers = entryPointSpecifiers(manifest);
  const scratch = await mkdtemp(join(tmpdir(), "packed-entry-imports-"));
  try {
    const tarball = await packSdk(scratch);
    const projectDir = join(scratch, "project");
    await installIntoEmptyProject(projectDir, tarball, demosdkVersion);
    console.log(`node ${process.version}, ${DEMOSDK}@${demosdkVersion}`);
    const results = importEntryPoints({ projectDir, specifiers });
    for (const result of results) {
      console.log(result.ok ? `ok   ${result.specifier}` : `FAIL ${result.specifier}: ${result.code}: ${result.message}`);
    }
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      console.error(`${failed.length} of ${results.length} entry points cannot be imported`);
      process.exitCode = 1;
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
