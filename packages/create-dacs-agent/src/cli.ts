#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  OFFLINE_PROFILE,
  LIVE_PROFILE,
  createDacsAgentProject,
  type CreateDacsAgentOptions,
} from "./index.js";

interface ParsedArguments extends CreateDacsAgentOptions {
  yes: boolean;
}

const ROLES = new Set(["demo-all", "buyer", "seller", "verifier"]);
const DEPLOYMENTS = new Set(["local", "docker"]);

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseCreateDacsAgentArguments(args: string[]): ParsedArguments {
  let targetDirectory: string | undefined;
  let mode: CreateDacsAgentOptions["mode"];
  let profile: string | undefined;
  let role: CreateDacsAgentOptions["role"];
  let deployment: CreateDacsAgentOptions["deployment"];
  let yes = false;
  let install = true;
  let run = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--yes") yes = true;
    else if (argument === "--run") run = true;
    else if (argument === "--no-install") install = false;
    else if (argument === "--mode") {
      const value = valueAfter(args, index, argument);
      if (value !== "offline" && value !== "live-demos") {
        throw new Error("--mode must be offline or live-demos");
      }
      mode = value;
      index += 1;
    } else if (argument === "--profile") {
      profile = valueAfter(args, index, argument);
      index += 1;
    } else if (argument === "--role") {
      const value = valueAfter(args, index, argument);
      if (!ROLES.has(value)) {
        throw new Error("--role must be demo-all, buyer, seller or verifier");
      }
      role = value as CreateDacsAgentOptions["role"];
      index += 1;
    } else if (argument === "--deploy") {
      const value = valueAfter(args, index, argument);
      if (!DEPLOYMENTS.has(value)) {
        throw new Error("--deploy must be local or docker");
      }
      deployment = value as CreateDacsAgentOptions["deployment"];
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else if (targetDirectory === undefined) {
      targetDirectory = argument;
    } else {
      throw new Error(`unexpected positional argument: ${argument}`);
    }
  }

  return {
    targetDirectory: targetDirectory ?? "",
    mode,
    profile,
    role,
    deployment,
    install,
    run,
    yes,
  };
}

async function boundedAnswer(
  prompt: string,
  allowed: ReadonlySet<string>,
  fallback: string,
): Promise<string> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(prompt)).trim() || fallback;
    if (!allowed.has(answer)) {
      throw new Error(`expected one of: ${[...allowed].join(", ")}`);
    }
    return answer;
  } finally {
    reader.close();
  }
}

async function interactive(parsed: ParsedArguments): Promise<ParsedArguments> {
  let targetDirectory = parsed.targetDirectory;
  if (!targetDirectory) {
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      targetDirectory = (await reader.question("Project directory: ")).trim();
    } finally {
      reader.close();
    }
  }
  if (!targetDirectory) throw new Error("project directory is required");

  await boundedAnswer("Package manager [npm]: ", new Set(["npm"]), "npm");
  const mode = (parsed.mode ??
    (await boundedAnswer(
      "Mode [offline] (offline/live-demos): ",
      new Set(["offline", "live-demos"]),
      "offline",
    ))) as "offline" | "live-demos";
  const role = (parsed.role ?? (await boundedAnswer(
    mode === "offline"
      ? "Process role [demo-all]: "
      : "Process role [buyer] (buyer/seller/verifier): ",
    mode === "offline" ? new Set(["demo-all"]) : new Set(["buyer", "seller", "verifier"]),
    mode === "offline" ? "demo-all" : "buyer",
  ))) as CreateDacsAgentOptions["role"];
  const deployment = (parsed.deployment ??
    (await boundedAnswer(
      "Deployment [local] (local/docker): ",
      DEPLOYMENTS,
      "local",
    ))) as CreateDacsAgentOptions["deployment"];
  const runAnswer = mode === "offline"
    ? parsed.run ? "yes" : await boundedAnswer(
      "Run offline smoke now? [yes] (yes/no): ", new Set(["yes", "no"]), "yes")
    : "no";
  return {
    ...parsed,
    targetDirectory,
    mode,
    profile: parsed.profile ?? (mode === "offline" ? OFFLINE_PROFILE : LIVE_PROFILE),
    role,
    deployment,
    run: runAnswer === "yes",
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let parsed = parseCreateDacsAgentArguments(args);
  if (!parsed.yes) parsed = await interactive(parsed);
  if (!parsed.targetDirectory) {
    throw new Error("project directory is required (for example: npm create dacs-agent my-agent)");
  }
  const created = await createDacsAgentProject(parsed);
  process.stdout.write(
    `\nCreated ${created.targetDirectory}\n` +
      `Profile: ${created.profile}\n` +
      `Installed: ${created.installed ? "yes" : "no"}\n` +
      `Ran verifier simulation: ${created.ran ? "yes" : "no"}\n` +
      `Doctor: ${created.doctor}\n`,
  );
}
