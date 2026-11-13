import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../..");
const modulePath = "../../scripts/bounded-log.mjs";
const { BUILD_LOG_MAX_BYTES, copyBoundedLog } = await import(modulePath);
const roots: string[] = [];
const scratch = () => { const path = mkdtempSync(join(tmpdir(), "dacs-bounded-log-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const collect = (stream: PassThrough) => { const chunks: Buffer[] = []; stream.on("data", chunk => chunks.push(chunk)); return () => Buffer.concat(chunks); };

describe("bounded build log", () => {
  it("copies output below the limit to the file and to the console unchanged", async () => {
    const log = join(scratch(), "build.log");
    const console_ = new PassThrough(); const seen = collect(console_);
    const complete = await copyBoundedLog(Readable.from([Buffer.from("step 1\n"), Buffer.from("step 2\n")]), console_, log, 64);
    console_.end();
    expect(complete).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("step 1\nstep 2\n");
    expect(seen().toString()).toBe("step 1\nstep 2\n");
  });
  it("accepts output of exactly the limit", async () => {
    const log = join(scratch(), "build.log");
    const complete = await copyBoundedLog(Readable.from([Buffer.alloc(64, "a")]), new PassThrough(), log, 64);
    expect(complete).toBe(true);
    expect(statSync(log).size).toBe(64);
  });
  it("stops at the limit and reports it when one more byte arrives", async () => {
    const log = join(scratch(), "build.log");
    const console_ = new PassThrough(); const seen = collect(console_);
    const complete = await copyBoundedLog(Readable.from([Buffer.alloc(40, "a"), Buffer.alloc(40, "b")]), console_, log, 64);
    console_.end();
    expect(complete).toBe(false);
    expect(readFileSync(log)).toEqual(Buffer.concat([Buffer.alloc(40, "a"), Buffer.alloc(24, "b")]));
    expect(seen().length).toBe(64);
  });
  it("exits non-zero with a message from the command line once the limit is reached", () => {
    const log = join(scratch(), "build.log");
    const result = spawnSync(process.execPath, [join(root, "scripts/bounded-log.mjs"), log], { input: Buffer.alloc(BUILD_LOG_MAX_BYTES + 1, "x"), maxBuffer: 2 * BUILD_LOG_MAX_BYTES });
    expect(result.status).toBe(1);
    expect(result.stderr.toString()).toContain("exceeded");
    expect(statSync(log).size).toBe(BUILD_LOG_MAX_BYTES);
  });
});

describe("image build stage", () => {
  // The build command and the pipeline after it, run with a stand-in for the bounded build.
  const imageBuild = () => {
    const text = readFileSync(join(root, "scripts/verify-registry-container-consumer.sh"), "utf8");
    const block = text.split("stage=image-build\n")[1]?.split("stage=image-policy")[0]?.split("image_started=1\n")[1];
    expect(block).toBeDefined();
    return block as string;
  };
  const runStage = (outputBytes: number) => {
    const artifacts = scratch();
    const run = `set -euo pipefail
repo_root=${JSON.stringify(root)}
cd "$repo_root"
artifact_stage=${JSON.stringify(artifacts)}
project=/unused runtime_image=unused
build_network_args=()
run_bounded() { head -c ${outputBytes} /dev/zero | tr '\\0' x; }
${imageBuild()}
echo stage-continued
`;
    const result = spawnSync("bash", ["--norc", "--noprofile", "-c", run], { encoding: "buffer", maxBuffer: 4 * BUILD_LOG_MAX_BYTES });
    return { status: result.status, stdout: result.stdout.length, tail: result.stdout.subarray(-32).toString(), logBytes: statSync(join(artifacts, "docker-build.log")).size };
  };
  it("fails the stage and keeps the log at the limit when the build prints more", () => {
    const result = runStage(BUILD_LOG_MAX_BYTES + 4096);
    expect(result.status).not.toBe(0);
    expect(result.tail).not.toContain("stage-continued");
    expect(result.logBytes).toBe(BUILD_LOG_MAX_BYTES);
  });
  it("continues past the build when the output stays within the limit", () => {
    const result = runStage(1024);
    expect(result.status).toBe(0);
    expect(result.logBytes).toBe(1024);
  });
});
