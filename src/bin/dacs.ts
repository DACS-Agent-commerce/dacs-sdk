#!/usr/bin/env node

import { formatDoctorText, runDoctor, type DoctorOptions } from "../cli/index.js";

export interface CliIO {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
}

export const USAGE = `Usage:
  dacs doctor [--json] [--offline] [--rpc <url>] [--wallet-secret <secret>] [--rail <id>]
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

export function parseDoctorArgs(args: string[]): DoctorOptions {
  const opts: DoctorOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--offline") {
      opts.offline = true;
    } else if (arg === "--rpc") {
      opts.rpc = readValue(args, i, arg);
      i += 1;
    } else if (arg === "--wallet-secret") {
      opts.walletSecret = readValue(args, i, arg);
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
  if (rest.length === 1 && rest[0] != null && isHelpArg(rest[0])) {
    io.stdout(USAGE);
    return 0;
  }

  let opts: DoctorOptions;
  try {
    opts = parseDoctorArgs(rest);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }

  try {
    const report = await runDoctor(opts);
    io.stdout(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorText(report));
    return report.exitCode;
  } catch (err) {
    io.stderr(`dacs doctor internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 4;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  });
  process.exitCode = code;
}
