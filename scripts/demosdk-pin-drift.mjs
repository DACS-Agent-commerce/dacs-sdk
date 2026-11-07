// Reports when the registry lists a newer @kynesyslabs/demosdk than the version
// ci.yml pins, within the published peer range. Run by the scheduled
// demosdk-compat workflow only; pull-request CI never looks up the newest version.
//
// Usage: node scripts/demosdk-pin-drift.mjs <pinned-version> <range>
// Exit codes: 0 the pin is the newest in range, 1 a newer release exists,
// 2 the registry could not be read or its reply was not usable.
import { execFileSync } from "node:child_process";

const PACKAGE_NAME = "@kynesyslabs/demosdk";
const REGISTRY_TIMEOUT_MS = Number(process.env.DEMOSDK_DRIFT_TIMEOUT_MS) || 30_000;
const REGISTRY_REPLY_MAX_BYTES = 1024 * 1024;
const EXIT_DRIFT = 1;
const EXIT_UNREADABLE = 2;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

class RegistryReadError extends Error {}

/** Returns the stdout of `npm view <spec> version --json`, bounded in time and size.
 * Throws RegistryReadError naming the cause: timeout, oversized reply, or npm's own failure. */
function readRegistryVersions(spec) {
  try {
    return execFileSync("npm", ["view", spec, "version", "--json"], {
      encoding: "utf8", timeout: REGISTRY_TIMEOUT_MS, maxBuffer: REGISTRY_REPLY_MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.code === "ETIMEDOUT") throw new RegistryReadError(`registry lookup timed out after ${REGISTRY_TIMEOUT_MS} ms`);
    if (error.code === "ENOBUFS") throw new RegistryReadError(`registry reply too large (over ${REGISTRY_REPLY_MAX_BYTES} bytes)`);
    const detail = String(error.stderr ?? error.message).trim().split("\n")[0];
    throw new RegistryReadError(`registry lookup failed: ${detail}`);
  }
}

/** Parses npm's reply (one version string, or a list) into x.y.z strings.
 * Throws RegistryReadError for anything else. */
function parseVersions(reply) {
  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new RegistryReadError("registry reply unreadable: not JSON");
  }
  const versions = typeof parsed === "string" ? [parsed] : parsed;
  if (!Array.isArray(versions) || versions.length === 0 || !versions.every((v) => typeof v === "string" && VERSION_PATTERN.test(v))) {
    throw new RegistryReadError("registry reply unreadable: expected a non-empty list of x.y.z versions");
  }
  return versions;
}

const parts = (version) => version.split(".").map(Number);
const compareVersions = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

function main(pinned, range) {
  if (!VERSION_PATTERN.test(pinned ?? "") || !range) {
    console.error("usage: demosdk-pin-drift.mjs <pinned x.y.z> <range>");
    return EXIT_UNREADABLE;
  }
  let newest;
  try {
    newest = parseVersions(readRegistryVersions(`${PACKAGE_NAME}@${range}`)).sort(compareVersions).at(-1);
  } catch (error) {
    if (!(error instanceof RegistryReadError)) throw error;
    console.error(`::error::${PACKAGE_NAME} drift check could not read the registry: ${error.message}`);
    return EXIT_UNREADABLE;
  }
  if (compareVersions(newest, pinned) !== 0) {
    console.error(`::error::${PACKAGE_NAME} ${newest} is the newest in ${range}, but ci.yml pins ${pinned}. Update the pin in ci.yml and demosdk-compat.yml.`);
    return EXIT_DRIFT;
  }
  console.log(`${PACKAGE_NAME} ${pinned} is the newest in ${range}`);
  return 0;
}

process.exitCode = main(process.argv[2], process.argv[3]);
