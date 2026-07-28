#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import {
  formatDoctorText,
  rpcSensitiveNeedles,
  runDoctor,
  sanitizeText,
  type DoctorOptions,
} from "../cli/index.js";

export interface CliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

interface DoctorCliOptions extends DoctorOptions {
  rpcEnv?: string;
  rpcFile?: string;
  walletSecretEnv?: string;
  walletSecretFile?: string;
}

export const USAGE = `Usage:
  dacs doctor [--json] [--offline] [--rpc <url>] [--rpc-file <path>] [--rpc-env <name>] [--wallet-secret-file <path>] [--wallet-secret-env <name>] [--rail <id>]
`;

export function isHelpArg(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readSecretInput(path: string, label: string): string {
  if (path === "-" && isatty(0)) {
    throw new Error(`${label} requires piped stdin when path is -`);
  }
  return readFileSync(path === "-" ? 0 : path, "utf8").trimEnd();
}

function assertDirectRpcIsOriginOnly(rpc: string): void {
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    throw new Error("--rpc requires a valid URL");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "--rpc accepts origin-only URLs; use --rpc-file or --rpc-env for URLs with credentials, path, query, or fragment",
    );
  }
}

export function parseDoctorArgs(args: string[]): DoctorCliOptions {
  const opts: DoctorCliOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--offline") {
      opts.offline = true;
    } else if (arg === "--rpc") {
      opts.rpc = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--rpc-env") {
      opts.rpcEnv = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--rpc-file") {
      opts.rpcFile = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--wallet-secret-env") {
      opts.walletSecretEnv = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--wallet-secret-file") {
      opts.walletSecretFile = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--rail") {
      opts.rail = readValue(args, i, arg);
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function resolveDoctorOptions(opts: DoctorCliOptions): DoctorOptions {
  const { rpcEnv, rpcFile, walletSecretEnv, walletSecretFile, ...doctorOptions } = opts;
  const rpcSources = [doctorOptions.rpc, rpcEnv, rpcFile].filter(Boolean);
  if (rpcSources.length > 1) {
    throw new Error("use only one of --rpc, --rpc-env, or --rpc-file");
  }
  if (doctorOptions.rpc) {
    assertDirectRpcIsOriginOnly(doctorOptions.rpc);
  }
  if (rpcFile === "-" && walletSecretFile === "-") {
    throw new Error("only one secret source can read from stdin");
  }
  if (rpcFile) {
    doctorOptions.rpc = readSecretInput(rpcFile, "--rpc-file -");
  } else if (rpcEnv) {
    const value = process.env[rpcEnv];
    if (!value) throw new Error(`${rpcEnv} is not set`);
    doctorOptions.rpc = value;
  }

  if (walletSecretEnv && walletSecretFile) {
    throw new Error("use only one of --wallet-secret-env or --wallet-secret-file");
  }
  if (walletSecretFile) {
    doctorOptions.walletSecret = readSecretInput(walletSecretFile, "--wallet-secret-file -");
  } else if (walletSecretEnv) {
    const value = process.env[walletSecretEnv];
    if (!value) throw new Error(`${walletSecretEnv} is not set`);
    doctorOptions.walletSecret = value;
  }
  return doctorOptions;
}

export function isMainModule(importMetaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

export async function runCli(args: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = args;
  if (command == null || isHelpArg(command)) {
    io.stdout(USAGE);
    return 0;
  }
  if (command !== "doctor") {
    io.stderr(USAGE);
    return 2;
  }
  if (rest.some(isHelpArg)) {
    io.stdout(USAGE);
    return 0;
  }

  let opts: DoctorCliOptions;
  try {
    opts = parseDoctorArgs(rest);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }

  let doctorOptions: DoctorOptions;
  try {
    doctorOptions = resolveDoctorOptions(opts);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }

  try {
    const report = await runDoctor(doctorOptions);
    io.stdout(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorText(report));
    return report.exitCode;
  } catch (err) {
    io.stderr(
      `dacs doctor internal error: ${sanitizeText(
        err instanceof Error ? err.message : String(err),
        [doctorOptions.walletSecret, doctorOptions.rpc, ...rpcSensitiveNeedles(doctorOptions.rpc)],
      )}\n`,
    );
    return 4;
  }
}

if (isMainModule(import.meta.url)) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  });
  process.exitCode = code;
}
