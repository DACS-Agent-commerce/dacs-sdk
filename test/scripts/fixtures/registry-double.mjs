// Test-only preload for scripts/publish-release-set.mjs: replaces fetch with an
// in-memory npm registry and gives the publisher a virtual clock. The test
// directory (REGISTRY_DOUBLE_DIR) holds registry.json, the stub npm's npm.log and
// accepted.log, and the fetch.log, timers.log and clock.log this preload appends to.
//
// registry.json: { clockStartMs, version, releases, archives, and optional
//   tags: { name: permanent next tag },
//   staleTagReads: { name: reads that still show an old next tag },
//   hiddenReads: { name: reads that still miss a version the stub npm accepted },
//   neverVisible: [names the stub npm accepted but the registry never shows],
//   readStatus: { name: status every read of that package answers },
//   readStatusAfterPublish: { name: status every read answers once npm publish has been called for that package } }
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.REGISTRY_DOUBLE_DIR;
const {
  clockStartMs, version, releases, archives, tags = {}, staleTagReads = {}, hiddenReads = {}, neverVisible = [], readStatus = {},
  readStatusAfterPublish = {},
} = JSON.parse(readFileSync(join(directory, "registry.json"), "utf8"));
const logTo = (file, line) => appendFileSync(join(directory, file), `${line}\n`);
const STALE_TAG = "0.0.1-stale";
const SLOW_TIMER_MS = 100_000;
const HUNG_POLL_MS = 5;

// Virtual time: only the publisher's own sleeps and a hung command's deadline move it.
let elapsedMilliseconds = 0;
Date.now = () => clockStartMs + elapsedMilliseconds;
Object.defineProperty(performance, "now", { configurable: true, value: () => elapsedMilliseconds });
process.on("exit", () => logTo("clock.log", Date.now()));

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (callback, delay, ...rest) {
  const origin = new Error().stack;
  if (/at sleep \(/.test(origin)) {
    logTo("timers.log", delay);
    elapsedMilliseconds += delay;
    return realSetTimeout(callback, 0);
  }
  if (origin.includes("bounded-command.mjs") && delay >= SLOW_TIMER_MS) {
    // The command deadline expires once the stub npm reports it is hung.
    logTo("timers.log", delay);
    const hung = join(directory, "hung");
    const poll = setInterval(() => {
      if (!existsSync(hung)) return;
      clearInterval(poll);
      rmSync(hung);
      elapsedMilliseconds += delay;
      callback();
    }, HUNG_POLL_MS);
    return poll;
  }
  return realSetTimeout(callback, delay, ...rest);
};

function publishCalled(name) {
  const log = join(directory, "npm.log");
  if (!existsSync(log)) return false;
  return readFileSync(log, "utf8").split("\n").some((call) => archives[call.split(" ")[1]]?.name === name);
}

function acceptedIntegrity(name) {
  const log = join(directory, "accepted.log");
  if (!existsSync(log)) return undefined;
  for (const archivePath of readFileSync(log, "utf8").split("\n")) {
    if (archives[archivePath]?.name === name) return archives[archivePath].integrity;
  }
  return undefined;
}

const reads = { afterAcceptance: {}, tags: {} };
const count = (table, name) => { table[name] = (table[name] ?? 0) + 1; return table[name]; };
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

// The integrity of a release the registry shows without delay: one that existed before the run, or one the stub npm accepted.
function settledIntegrity(name) {
  if (releases[name] !== undefined) return releases[name];
  return neverVisible.includes(name) ? undefined : acceptedIntegrity(name);
}

// A version-document read: a release accepted in this run stays hidden for its first `hiddenReads` reads.
function versionDocumentIntegrity(name) {
  const settled = settledIntegrity(name);
  if (settled === undefined || releases[name] !== undefined) return settled;
  return count(reads.afterAcceptance, name) > (hiddenReads[name] ?? 0) ? settled : undefined;
}

function nextTag(name) {
  if (tags[name] !== undefined) return tags[name];
  return count(reads.tags, name) > (staleTagReads[name] ?? 0) ? version : STALE_TAG;
}

globalThis.fetch = async (url) => {
  logTo("fetch.log", url);
  const [, encodedName, encodedVersion] = new URL(url).pathname.split("/");
  const name = decodeURIComponent(encodedName);
  const status = readStatus[name] ?? (publishCalled(name) ? readStatusAfterPublish[name] : undefined);
  if (status !== undefined) return new Response("{}", { status });
  if (encodedVersion === undefined) {
    return json({ name, "dist-tags": settledIntegrity(name) === undefined ? {} : { next: nextTag(name) } });
  }
  const integrity = versionDocumentIntegrity(name);
  if (integrity === undefined) return new Response("{}", { status: 404 });
  const unscoped = name.split("/").pop();
  const tarball = `https://registry.npmjs.org/${name}/-/${unscoped}-${decodeURIComponent(encodedVersion)}.tgz`;
  return json({ name, version: decodeURIComponent(encodedVersion), description: "registry double", dist: { integrity, tarball } });
};
