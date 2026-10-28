#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PINNED_ACCEPTANCE_NPM_VERSION } from "./publish-exact-local-registry.mjs";
import { COMMAND_TIMEOUT_SECONDS } from "./bounded-command.mjs";
import { EVIDENCE_MAX_BYTES } from "./acceptance-evidence-io.mjs";
import admission from "./bounded-npm-http.cjs";

// Reviewed against the registry's integrity and the exact downloaded archive.
export const NPM_BOOTSTRAP_ARTIFACT = Object.freeze({ version: "11.19.0",
  url: "https://registry.npmjs.org/npm/-/npm-11.19.0.tgz",
  sha512: "SDd/hHg3KqHE5Ht2NHWxNYNtqCQ2pXAPLl6OtQhPyED5PHsRfrOtO199MZTIG2cQoQ1ZRI9t28shrD+2cr3AAw==" });

/** Downloads one archive with inherited byte/expansion limits and a total request deadline.
 * Rejects redirects, failed/interrupted HTTP, overflow and timeout before returning bytes. */
export function downloadArchive(url, { request = url.startsWith("https:") ? httpsRequest : httpRequest,
  schedule = setTimeout, cancel = clearTimeout, signal } = {}) {
  let timer, response;
  return new Promise((resolve, reject) => {
    const pending = request(url, { signal }, reply => {
      response = reply;
      if (reply.statusCode !== 200) { reply.destroy(); reject(new Error("bootstrap HTTP status " + reply.statusCode)); return; }
      admission.readBoundedResponse(reply, admission.NPM_TARBALL_MAX_BYTES, false,
        admission.NPM_TARBALL_MAX_UNPACKED_BYTES).then(resolve, error => { reply.destroy(); reject(error); });
    });
    pending.on("error", reject);
    timer = schedule(() => {
      const error = new Error("ETIMEDOUT bootstrap HTTP deadline");
      pending.destroy(error); response?.destroy(); reject(error);
    }, admission.NPM_HTTP_TIMEOUT_MS);
    pending.end();
  }).finally(() => cancel(timer));
}

/** Installs the admitted npm archive offline in a new private prefix. Returns that prefix.
 * Publishes its bin to githubPath only after version verification; failures remove partial
 * state and retain bootstrap.log. Injectable operations support local real-client tests. */
export async function bootstrapNpm({ descriptor = NPM_BOOTSTRAP_ARTIFACT,
  directory = process.env.RUNNER_TEMP || tmpdir(), githubPath = process.env.GITHUB_PATH,
  execute = promisify(execFile), signal } = {}) {
  if (descriptor.version !== PINNED_ACCEPTANCE_NPM_VERSION) throw new Error("bootstrap npm version differs from acceptance pin");
  const run = mkdtempSync(join(directory, "dacs-acceptance-npm-")), prefix = join(run, "prefix");
  const temporary = join(run, "download.part"), archive = join(run, `npm-${descriptor.version}.tgz`), cache = join(run, "cache");
  const log = join(run, "bootstrap.log");
  let published = false;
  writeFileSync(log, `Downloading ${descriptor.url}\n`);
  try {
    if (!githubPath) throw new Error("GITHUB_PATH is required");
    writeFileSync(temporary, await downloadArchive(descriptor.url, { signal }), { flag: "wx" });
    // Hash exactly the bytes returned by admission; no repacking or metadata resolution.
    if (createHash("sha512").update(readFileSync(temporary)).digest("base64") !== descriptor.sha512) throw new Error("bootstrap SHA-512 mismatch");
    renameSync(temporary, archive);
    const options = { signal, timeout: COMMAND_TIMEOUT_SECONDS * 1000, maxBuffer: EVIDENCE_MAX_BYTES,
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false" } };
    const installed = await execute("npm", ["install", "--offline", "--global", "--prefix", prefix,
      "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false", archive], options);
    appendFileSync(log, installed.stdout + installed.stderr);
    const version = await execute(process.execPath, [join(prefix, "lib/node_modules/npm/bin/npm-cli.js"), "--version"], options);
    appendFileSync(log, version.stdout + version.stderr);
    if (version.stdout.trim() !== descriptor.version) throw new Error("installed npm version differs from descriptor");
    appendFileSync(githubPath, join(prefix, "bin") + "\n");
    published = true;
    return prefix;
  } catch (error) {
    appendFileSync(log, `${error.message}\n${error.stdout || ""}${error.stderr || ""}`);
    throw new Error(`npm bootstrap failed: ${error.message}; diagnostics: ${log}`, { cause: error });
  } finally {
    for (const path of [temporary, archive, cache, ...(published ? [] : [prefix])]) rmSync(path, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try { await bootstrapNpm({ signal: controller.signal }); }
  catch (error) { console.error(error, error.cause); process.exitCode = 1; }
  finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}
