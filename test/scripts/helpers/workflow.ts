import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { expect } from "vitest";

// The lines of one workflow step, from its `- name:` line to the next step.
export function workflowStepLines(stepName: string, path: string) {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const stepIndent = (lines[start] ?? "").indexOf("-");
  let end = start + 1;
  while (end < lines.length && ((lines[end] ?? "").trim() === "" || (lines[end] ?? "").search(/\S/) > stepIndent)) end += 1;
  return { lines, start, end, stepIndent };
}

// Extracts the literal `run: |` block of one workflow step without a YAML dependency.
export function workflowStepScript(stepName: string, path: string): string {
  const { lines, start, stepIndent } = workflowStepLines(stepName, path);
  let index = start + 1;
  while (index < lines.length && !/^\s+run:/.test(lines[index] ?? "")) index += 1;
  const runLine = lines[index] ?? "";
  const inline = runLine.replace(/^\s+run:\s*/, "");
  if (inline !== "|") return inline;
  const body: string[] = [];
  const blockIndent = runLine.indexOf("run:") + 2;
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && line.search(/\S/) <= stepIndent) break;
    body.push(line.slice(blockIndent));
  }
  return body.join("\n");
}

// One job's own keys: each four-space `key: value` line, with the trimmed
// lines nested under it appended one per line.
export function workflowJob(path: string, jobId: string) {
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.indexOf(`  ${jobId}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const job: Record<string, string> = {};
  let key = "";
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    const own = /^ {4}([\w-]+):\s*(.*)$/.exec(line);
    if (own) {
      key = own[1] ?? "";
      job[key] = own[2] ?? "";
    } else if (key && line.trim() !== "") {
      job[key] += `\n${line.trim()}`;
    }
  }
  return job;
}

// Every child runs without rc files and with an explicit PATH whose `node` is
// this process's own binary, never a host node.
export function stubBin(directory: string, stubs: Record<string, string> = {}) {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  for (const [name, body] of Object.entries({ node: `exec ${node} "$@"`, ...stubs })) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o700);
  }
  return [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter);
}
export function runBash(args: string[], options: { cwd: string; env: Record<string, string> }) {
  return spawnSync("bash", ["--norc", "--noprofile", ...args], { cwd: options.cwd, encoding: "utf8",
    env: { HOME: options.cwd, ...options.env } });
}
