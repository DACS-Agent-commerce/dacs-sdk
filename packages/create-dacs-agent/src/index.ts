import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { projectTemplates } from "./templates.js";
import { publishCompleteStagingDirectory } from "./publication.js";

export const CREATE_DACS_AGENT_VERSION = "0.1.0-alpha.0";
export const OFFLINE_PROFILE = "dacs-sdk:fixed-price-offline:v1" as const;
export const LIVE_PROFILE = "dacs-sdk:fixed-price-x402:v1" as const;

export interface CreateDacsAgentOptions {
  targetDirectory: string;
  mode?: "offline" | "live-demos";
  profile?: string;
  role?: "demo-all" | "buyer" | "seller" | "verifier";
  deployment?: "local" | "docker";
  install?: boolean;
  run?: boolean;
}

export interface CreatedDacsAgentProject {
  targetDirectory: string;
  mode: "offline" | "live-demos";
  profile: typeof OFFLINE_PROFILE | typeof LIVE_PROFILE;
  role: "demo-all" | "buyer" | "seller" | "verifier";
  deployment: "local" | "docker";
  installed: boolean;
  ran: boolean;
  doctor: "not-run" | "pass" | "blocked";
  files: string[];
}

function packageName(targetDirectory: string): string {
  const normalized = basename(resolve(targetDirectory))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 214);
  return normalized || "dacs-agent";
}

interface StableProjectParent {
  path: string;
  dev: number;
  ino: number;
}

async function stableProjectParent(targetDirectory: string): Promise<StableProjectParent> {
  const requestedParent = dirname(targetDirectory);
  let stat;
  try {
    stat = await lstat(requestedParent);
  } catch (cause) {
    throw new Error("target parent must already exist", { cause });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("target parent must be a directory, not a symbolic link");
  }
  const parent = await realpath(requestedParent);
  stat = await lstat(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("canonical target parent must be a non-symlink directory");
  }
  return { path: parent, dev: stat.dev, ino: stat.ino };
}

async function assertStableProjectParent(parent: StableProjectParent): Promise<void> {
  const stat = await lstat(parent.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      stat.dev !== parent.dev || stat.ino !== parent.ino ||
      await realpath(parent.path) !== parent.path) {
    throw new Error("target parent changed during project generation");
  }
}

async function prepareFreshTarget(targetDirectory: string): Promise<void> {
  try {
    const stat = await lstat(targetDirectory);
    if (stat.isSymbolicLink()) {
      throw new Error("target directory must not be a symbolic link");
    }
    if (!stat.isDirectory()) {
      throw new Error("target path exists and is not a directory");
    }
    if ((await readdir(targetDirectory)).length > 0) {
      throw new Error("target directory is not empty; refusing to overwrite it");
    }
    await rmdir(targetDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function safeDestination(targetDirectory: string, file: string): string {
  const destination = resolve(targetDirectory, file);
  const pathFromTarget = relative(targetDirectory, destination);
  if (
    pathFromTarget === "" ||
    pathFromTarget === ".." ||
    pathFromTarget.startsWith(`..${sep}`) ||
    isAbsolute(pathFromTarget)
  ) {
    throw new Error(`template path escapes the project directory: ${file}`);
  }
  return destination;
}

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  allowedExitCodes: ReadonlySet<number> = new Set([0]),
): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null && allowedExitCodes.has(code)) resolvePromise(code);
      else {
        reject(
          new Error(
            `${executable} ${args.join(" ")} failed (${signal ?? `exit ${String(code)}`})`,
          ),
        );
      }
    });
  });
}

/**
 * Generate the bounded offline quickstart and optionally install/run it.
 * The caller must select a parent directory trusted against concurrent
 * replacement; see the generated README for the atomic-publication boundary.
 */
export async function createDacsAgentProject(
  options: CreateDacsAgentOptions,
): Promise<Readonly<CreatedDacsAgentProject>> {
  if (!options || typeof options.targetDirectory !== "string") {
    throw new TypeError("targetDirectory is required");
  }
  const requestedTargetDirectory = resolve(options.targetDirectory.trim());
  if (options.targetDirectory.trim() === "") {
    throw new TypeError("targetDirectory must not be empty");
  }
  const mode = options.mode ?? "offline";
  const profile = (options.profile ??
    (mode === "offline" ? OFFLINE_PROFILE : LIVE_PROFILE)) as
      | typeof OFFLINE_PROFILE
      | typeof LIVE_PROFILE;
  const role = options.role ?? (mode === "offline" ? "demo-all" : "buyer");
  const deployment = options.deployment ?? "local";
  const install = options.install ?? true;
  const run = options.run ?? false;

  if (mode !== "offline" && mode !== "live-demos") {
    throw new Error("mode must be offline or live-demos");
  }
  if (role !== "demo-all" && role !== "buyer" && role !== "seller" && role !== "verifier") {
    throw new Error("role must be demo-all, buyer, seller or verifier");
  }
  if (deployment !== "local" && deployment !== "docker") {
    throw new Error("deployment must be local or docker");
  }
  if (typeof install !== "boolean" || typeof run !== "boolean") {
    throw new Error("install and run options must be boolean");
  }
  if (mode === "offline" && profile !== OFFLINE_PROFILE) {
    throw new Error(`offline mode requires profile ${OFFLINE_PROFILE}`);
  }
  if (mode === "live-demos" && profile !== LIVE_PROFILE) {
    throw new Error(`live-demos mode requires profile ${LIVE_PROFILE}`);
  }
  if (mode === "offline" && role !== "demo-all") {
    throw new Error(
      "this generator supports only the single-process demo-all simulation; " +
        "use live-demos for independent role services",
    );
  }
  if (mode === "live-demos" && role === "demo-all") {
    throw new Error("live-demos requires buyer, seller or verifier role separation");
  }
  if (mode === "live-demos" && run) {
    throw new Error("--run is the offline smoke flag and is not valid for live-demos");
  }
  if (run && !install) {
    throw new Error("--run cannot be combined with --no-install");
  }
  const parent = await stableProjectParent(requestedTargetDirectory);
  const targetDirectory = resolve(parent.path, basename(requestedTargetDirectory));
  await prepareFreshTarget(targetDirectory);
  const templates = projectTemplates({
    packageName: packageName(targetDirectory),
    deployment,
    mode,
    role,
    runtimeUid: typeof process.getuid === "function" && process.getuid() > 0
      ? process.getuid() : 10001,
    runtimeGid: typeof process.getgid === "function" && process.getgid() > 0
      ? process.getgid() : 10001,
  });
  const files = Object.keys(templates).sort();
  const stagingDirectory = await mkdtemp(
    `${parent.path}${sep}.${basename(targetDirectory)}.staging-`,
  );
  let published = false;
  try {
    for (const file of files) {
      const destination = safeDestination(stagingDirectory, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, templates[file]!, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    if (mode === "live-demos") {
      // Local live services require role-owned private persistence before the
      // read-only pre-start doctor may pass. Keep both authorities separated
      // even when the generated project supervises them together.
      for (const role of ["buyer", "seller"] as const) {
        await chmod(resolve(stagingDirectory, "data", role), 0o700);
      }
    }
    await assertStableProjectParent(parent);
    // All nested paths are complete before the project name becomes visible.
    // Publication never merges with or traverses a concurrently created target.
    // On POSIX an empty target may be replaced atomically; non-empty targets fail.
    await publishCompleteStagingDirectory(stagingDirectory, targetDirectory);
    published = true;
  } finally {
    if (!published) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (install) {
    await runCommand(npm, ["install", "--ignore-scripts"], targetDirectory);
    if (mode === "live-demos") {
      // The host kit's reviewed SQLite adapter is the only dependency allowed
      // to run a native install lifecycle in the generated live project.
      await runCommand(npm, ["rebuild", "better-sqlite3"], targetDirectory);
    }
  }
  let doctor: CreatedDacsAgentProject["doctor"] = "not-run";
  if (run) {
    await runCommand(npm, ["run", "typecheck"], targetDirectory);
    await runCommand(npm, ["run", "dacs:smoke:offline"], targetDirectory);
  }
  if (mode === "live-demos" && install) {
    const code = await runCommand(npm, [
      "run", "dacs:doctor", "--", "--phase", "pre-start", "--for", "start",
    ], targetDirectory, new Set([0, 5]));
    doctor = code === 0 ? "pass" : "blocked";
  }

  return Object.freeze({
    targetDirectory,
    mode,
    profile,
    role,
    deployment,
    installed: install,
    ran: run,
    doctor,
    files,
  });
}

export { projectTemplates, type ProjectTemplateOptions } from "./templates.js";
