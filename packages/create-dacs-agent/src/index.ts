import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { projectTemplates } from "./templates.js";

export const CREATE_DACS_AGENT_VERSION = "0.1.0-alpha.0";
export const OFFLINE_PROFILE = "dacs-sdk:fixed-price-offline:v1" as const;

export interface CreateDacsAgentOptions {
  targetDirectory: string;
  mode?: "offline" | "live-demos";
  profile?: string;
  role?: "demo-all";
  deployment?: "local" | "docker";
  install?: boolean;
  run?: boolean;
}

export interface CreatedDacsAgentProject {
  targetDirectory: string;
  mode: "offline";
  profile: typeof OFFLINE_PROFILE;
  role: "demo-all";
  deployment: "local" | "docker";
  installed: boolean;
  ran: boolean;
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

async function ensureWritableEmptyTarget(targetDirectory: string): Promise<void> {
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(targetDirectory, { recursive: true });
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
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
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

/** Generate the bounded offline quickstart and optionally install/run it. */
export async function createDacsAgentProject(
  options: CreateDacsAgentOptions,
): Promise<Readonly<CreatedDacsAgentProject>> {
  if (!options || typeof options.targetDirectory !== "string") {
    throw new TypeError("targetDirectory is required");
  }
  const targetDirectory = resolve(options.targetDirectory.trim());
  if (options.targetDirectory.trim() === "") {
    throw new TypeError("targetDirectory must not be empty");
  }
  const mode = options.mode ?? "offline";
  const profile = options.profile ?? OFFLINE_PROFILE;
  const role = options.role ?? "demo-all";
  const deployment = options.deployment ?? "local";
  const install = options.install ?? true;
  const run = options.run ?? false;

  if (mode !== "offline") {
    throw new Error(
      "live-demos is not implemented in this work package; generation fails closed",
    );
  }
  if (profile !== OFFLINE_PROFILE) {
    throw new Error(`offline mode requires profile ${OFFLINE_PROFILE}`);
  }
  if (role !== "demo-all") {
    throw new Error(
      "this generator supports only the single-process demo-all simulation; " +
        "independent role services are not implemented",
    );
  }
  if (run && !install) {
    throw new Error("--run cannot be combined with --no-install");
  }
  await ensureWritableEmptyTarget(targetDirectory);
  const templates = projectTemplates({
    packageName: packageName(targetDirectory),
    deployment,
  });
  const files = Object.keys(templates).sort();
  for (const file of files) {
    const destination = safeDestination(targetDirectory, file);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, templates[file]!, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  if (install) {
    await runCommand(npm, ["install", "--ignore-scripts"], targetDirectory);
  }
  if (run) {
    await runCommand(npm, ["run", "typecheck"], targetDirectory);
    await runCommand(npm, ["run", "dacs:smoke:offline"], targetDirectory);
  }

  return Object.freeze({
    targetDirectory,
    mode: "offline",
    profile: OFFLINE_PROFILE,
    role,
    deployment,
    installed: install,
    ran: run,
    files,
  });
}

export { projectTemplates, type ProjectTemplateOptions } from "./templates.js";
