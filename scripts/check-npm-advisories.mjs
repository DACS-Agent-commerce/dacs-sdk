#!/usr/bin/env node

import { appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const OSV_BATCH_ENDPOINT = "https://api.osv.dev/v1/querybatch";
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 2;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const offset = lockPath.lastIndexOf(marker);
  if (offset < 0) return undefined;
  const tail = lockPath.slice(offset + marker.length);
  if (!tail || tail.includes("/node_modules/")) return undefined;
  const parts = tail.split("/");
  if (parts[0]?.startsWith("@")) {
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : undefined;
  }
  return parts.length === 1 ? parts[0] : undefined;
}

function isOmitted(entry, omit) {
  if (omit.has("dev") && entry.dev === true) return true;
  if (omit.has("optional") && (entry.optional === true || entry.devOptional === true)) {
    return true;
  }
  if (omit.has("peer") && (entry.peer === true || entry.peerOptional === true)) {
    return true;
  }
  return false;
}

function addVersion(result, name, version) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("package-lock entry has no valid package name");
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`package-lock entry for ${name} has no exact version`);
  }
  const versions = result.get(name) ?? new Set();
  versions.add(version);
  result.set(name, versions);
}

function directDependencyEntries(packages, manifestPath, entry, omit) {
  const dependencies = {
    ...(isObject(entry.dependencies) ? entry.dependencies : {}),
    ...(omit.has("optional") || !isObject(entry.optionalDependencies)
      ? {}
      : entry.optionalDependencies),
  };
  const found = [];

  for (const dependencyName of Object.keys(dependencies)) {
    let current = manifestPath;
    let resolvedEntry;
    let resolvedPath;
    while (true) {
      const candidate = current
        ? `${current}/node_modules/${dependencyName}`
        : `node_modules/${dependencyName}`;
      if (Object.hasOwn(packages, candidate)) {
        resolvedEntry = packages[candidate];
        resolvedPath = candidate;
        break;
      }
      if (!current) break;
      const parent = dirname(current);
      current = parent === "." ? "" : parent;
    }

    if (!isObject(resolvedEntry) || typeof resolvedPath !== "string") {
      throw new Error(
        `cannot resolve direct dependency ${dependencyName} from ${manifestPath || "the root"}`,
      );
    }
    // npm audit excludes workspace/file links because no registry version is
    // installed at that node. Their external dependencies are considered from
    // each workspace's own manifest below.
    if (resolvedEntry.link === true) continue;
    found.push({
      name: typeof resolvedEntry.name === "string" ? resolvedEntry.name : dependencyName,
      version: resolvedEntry.version,
    });
  }
  return found;
}

export function collectAuditVersions(lockfile, { scope, omit = [] }) {
  if (!isObject(lockfile) || !isObject(lockfile.packages)) {
    throw new Error("package-lock.json must contain a packages object");
  }
  if (scope !== "direct" && scope !== "all") {
    throw new Error(`unsupported audit scope: ${scope}`);
  }
  const omissions = new Set(omit);
  for (const value of omissions) {
    if (!["dev", "optional", "peer"].includes(value)) {
      throw new Error(`unsupported omit class: ${value}`);
    }
  }

  const result = new Map();
  const entries = Object.entries(lockfile.packages);
  if (scope === "direct") {
    // The root and each workspace are first-party manifests. This mirrors the
    // repository-wide npm audit gate while deliberately excluding optional
    // peer integrations, which consuming applications must audit themselves.
    for (const [lockPath, entry] of entries) {
      if (lockPath.includes("node_modules") || !isObject(entry)) continue;
      for (const dependency of directDependencyEntries(
        lockfile.packages,
        lockPath,
        entry,
        omissions,
      )) {
        addVersion(result, dependency.name, dependency.version);
      }
    }
  } else {
    for (const [lockPath, entry] of entries) {
      if (!lockPath.includes("node_modules") || !isObject(entry)) continue;
      if (entry.link === true || isOmitted(entry, omissions)) continue;
      const name = typeof entry.name === "string"
        ? entry.name
        : packageNameFromLockPath(lockPath);
      addVersion(result, name, entry.version);
    }
  }

  return Object.fromEntries(
    [...result.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
}

export function decodeAuditResponse(bytes, maximumDecodedBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("audit response must be bytes");
  }
  const decoded = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes, { maxOutputLength: maximumDecodedBytes })
    : bytes;
  let value;
  try {
    value = JSON.parse(Buffer.from(decoded).toString("utf8"));
  } catch (error) {
    throw new Error(
      `registry returned invalid audit JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(value)) {
    throw new Error("registry audit response must be an object");
  }
  return value;
}

export function validateAdvisories(payload, requestedPackages) {
  if (!isObject(payload)) throw new Error("registry audit response must be an object");
  const requested = new Set(Object.keys(requestedPackages));
  const advisories = [];

  for (const [packageName, packageAdvisories] of Object.entries(payload)) {
    if (!requested.has(packageName)) {
      throw new Error(`registry returned an unrequested package: ${packageName}`);
    }
    if (!Array.isArray(packageAdvisories)) {
      throw new Error(`registry returned invalid advisories for ${packageName}`);
    }
    for (const advisory of packageAdvisories) {
      if (!isObject(advisory)) {
        throw new Error(`registry returned a non-object advisory for ${packageName}`);
      }
      if (typeof advisory.severity !== "string" || !SEVERITIES.includes(advisory.severity)) {
        throw new Error(`registry returned an invalid severity for ${packageName}`);
      }
      const id = advisory.id;
      if (typeof id !== "number" && typeof id !== "string") {
        throw new Error(`registry returned an advisory without an id for ${packageName}`);
      }
      advisories.push({
        packageName,
        id,
        severity: advisory.severity,
        title: typeof advisory.title === "string" ? advisory.title : "untitled advisory",
        url: typeof advisory.url === "string" ? advisory.url : undefined,
        vulnerableVersions:
          typeof advisory.vulnerable_versions === "string"
            ? advisory.vulnerable_versions
            : undefined,
      });
    }
  }
  return advisories;
}

function exactVersionQueries(versions) {
  return Object.entries(versions).flatMap(([packageName, packageVersions]) =>
    packageVersions.map((version) => ({ packageName, version })),
  );
}

export function validateOsvResults(payload, queries) {
  if (!isObject(payload) || !Array.isArray(payload.results)) {
    throw new Error("OSV response must contain a results array");
  }
  if (payload.results.length !== queries.length) {
    throw new Error("OSV response count does not match the exact-version query count");
  }
  const deduplicated = new Map();
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const result = payload.results[index];
    if (!isObject(query) || !isObject(result)) {
      throw new Error("OSV returned an invalid exact-version result");
    }
    if (result.vulns === undefined) continue;
    if (!Array.isArray(result.vulns)) {
      throw new Error(`OSV returned invalid vulnerabilities for ${query.packageName}`);
    }
    for (const vulnerability of result.vulns) {
      if (!isObject(vulnerability) || typeof vulnerability.id !== "string" || !vulnerability.id) {
        throw new Error(`OSV returned a vulnerability without an id for ${query.packageName}`);
      }
      const key = `${query.packageName}\u0000${vulnerability.id}`;
      deduplicated.set(key, {
        packageName: query.packageName,
        id: vulnerability.id,
        // Querybatch returns compact identifiers rather than a scoring record.
        // Treat every exact-version match as blocking on fallback; this is
        // stricter than guessing a severity or silently dropping the finding.
        severity: "unknown",
        title: `OSV exact-version match ${vulnerability.id}`,
        url: `https://osv.dev/vulnerability/${encodeURIComponent(vulnerability.id)}`,
        vulnerableVersions: query.version,
      });
    }
  }
  return [...deduplicated.values()];
}

async function readBoundedBody(response, maximumBytes) {
  if (!response.body) return new Uint8Array();
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      throw new Error(`registry audit response exceeded ${maximumBytes} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function registryEndpoint(registry) {
  let parsed;
  try {
    parsed = new URL(registry);
  } catch {
    throw new Error(`invalid npm registry URL: ${registry}`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("npm registry must use HTTPS (except loopback test servers)");
  }
  if (parsed.username || parsed.password) {
    throw new Error("npm registry URL must not contain credentials");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return new URL("-/npm/v1/security/advisories/bulk", parsed);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function requestBulkAdvisories(
  versions,
  {
    registry = process.env.npm_config_registry || DEFAULT_REGISTRY,
    attempts = DEFAULT_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maximumResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new Error("audit attempts must be an integer from 1 to 5");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("audit timeout must be between 1 and 120000 milliseconds");
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    maximumResponseBytes > 64 * 1024 * 1024
  ) {
    throw new Error("audit response limit must be between 1 byte and 64 MiB");
  }
  if (Object.keys(versions).length === 0) return {};

  const endpoint = registryEndpoint(registry);
  const body = gzipSync(Buffer.from(JSON.stringify(versions), "utf8"));
  let finalError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "content-encoding": "gzip",
          "content-type": "application/json",
          "user-agent": "dacs-sdk-ci-audit/1",
        },
        body,
      });
      if (!response.ok) {
        throw new Error(`registry audit endpoint returned HTTP ${response.status}`);
      }
      const bytes = await readBoundedBody(response, maximumResponseBytes);
      return decodeAuditResponse(bytes, maximumResponseBytes);
    } catch (error) {
      finalError = error;
      if (attempt < attempts) {
        process.stderr.write(
          `registry audit attempt ${attempt}/${attempts} failed; retrying: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        await sleep(250 * attempt);
      }
    }
  }
  throw new Error(
    `registry audit failed after ${attempts} attempts: ${
      finalError instanceof Error ? finalError.message : String(finalError)
    }`,
  );
}

export async function requestOsvAdvisories(
  versions,
  {
    attempts = DEFAULT_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maximumResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const queries = exactVersionQueries(versions);
  if (queries.length === 0) return [];
  if (queries.length > 1_000) {
    throw new Error("OSV fallback supports at most 1000 exact package/version queries");
  }
  const body = JSON.stringify({
    queries: queries.map(({ packageName, version }) => ({
      package: { ecosystem: "npm", name: packageName },
      version,
    })),
  });
  let finalError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(OSV_BATCH_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "dacs-sdk-ci-audit/1",
        },
        body,
      });
      if (!response.ok) {
        throw new Error(`OSV querybatch endpoint returned HTTP ${response.status}`);
      }
      const bytes = await readBoundedBody(response, maximumResponseBytes);
      const payload = decodeAuditResponse(bytes, maximumResponseBytes);
      return validateOsvResults(payload, queries);
    } catch (error) {
      finalError = error;
      if (attempt < attempts) {
        process.stderr.write(
          `OSV audit attempt ${attempt}/${attempts} failed; retrying: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        await sleep(250 * attempt);
      }
    }
  }
  throw new Error(
    `OSV exact-version audit failed after ${attempts} attempts: ${
      finalError instanceof Error ? finalError.message : String(finalError)
    }`,
  );
}

function countsFor(advisories) {
  const counts = Object.fromEntries(
    [...SEVERITIES, "unknown"].map((severity) => [severity, 0]),
  );
  for (const advisory of advisories) counts[advisory.severity] += 1;
  counts.total = advisories.length;
  return counts;
}

export function violationsAtThreshold(advisories, threshold) {
  if (threshold === "none") return [];
  const thresholdIndex = SEVERITIES.indexOf(threshold);
  if (thresholdIndex < 0) throw new Error(`unsupported audit threshold: ${threshold}`);
  return advisories.filter(
    (advisory) =>
      advisory.severity === "unknown" ||
      SEVERITIES.indexOf(advisory.severity) >= thresholdIndex,
  );
}

function parseArguments(argumentsList) {
  const options = {
    prefix: ".",
    scope: undefined,
    omit: [],
    threshold: undefined,
    registry: process.env.npm_config_registry || DEFAULT_REGISTRY,
    summary: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--summary") {
      options.summary = true;
      continue;
    }
    if (argument === "--omit") {
      const value = argumentsList[++index];
      if (!value) throw new Error("--omit requires a value");
      options.omit.push(value);
      continue;
    }
    const supported = new Map([
      ["--prefix", "prefix"],
      ["--scope", "scope"],
      ["--threshold", "threshold"],
      ["--registry", "registry"],
    ]);
    const key = supported.get(argument);
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = argumentsList[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    options[key] = value;
  }
  if (options.scope !== "direct" && options.scope !== "all") {
    throw new Error("--scope must be direct or all");
  }
  if (options.threshold !== "none" && !SEVERITIES.includes(options.threshold)) {
    throw new Error("--threshold must be none, info, low, moderate, high, or critical");
  }
  return options;
}

function markdownSummary(report) {
  return [
    `### dependency advisory audit (${report.scope})`,
    "",
    `Audited **${report.packagesAudited}** exact package/version sets using **${report.source}**.`,
    "",
    "| severity | advisories |",
    "| --- | ---: |",
    ...["unknown", ...SEVERITIES.slice().reverse()].map(
      (severity) => `| ${severity} | ${report.counts[severity]} |`,
    ),
    "",
    `Blocking threshold: **${report.threshold}**. Matching advisories: **${report.violations.length}**.`,
    "",
  ].join("\n");
}

export async function runAudit(options) {
  const prefix = resolve(options.prefix);
  const lockfile = JSON.parse(await readFile(join(prefix, "package-lock.json"), "utf8"));
  const versions = collectAuditVersions(lockfile, {
    scope: options.scope,
    omit: options.omit,
  });
  let advisories;
  let source = "npm-bulk";
  try {
    const payload = await requestBulkAdvisories(versions, { registry: options.registry });
    advisories = validateAdvisories(payload, versions);
  } catch (npmError) {
    process.stderr.write(
      `npm bulk advisory service unavailable; using stricter OSV exact-version fallback: ${
        npmError instanceof Error ? npmError.message : String(npmError)
      }\n`,
    );
    source = "osv-exact-version-fallback";
    try {
      advisories = await requestOsvAdvisories(versions);
    } catch (osvError) {
      throw new Error(
        `both advisory services failed (npm: ${
          npmError instanceof Error ? npmError.message : String(npmError)
        }; OSV: ${osvError instanceof Error ? osvError.message : String(osvError)})`,
      );
    }
  }
  const violations = violationsAtThreshold(advisories, options.threshold);
  return {
    source,
    scope: options.scope,
    threshold: options.threshold,
    packagesAudited: Object.keys(versions).length,
    counts: countsFor(advisories),
    advisories,
    violations,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runAudit(options);
  const output = markdownSummary(report);
  process.stdout.write(output);
  if (options.summary && process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, output, "utf8");
  }
  if (report.violations.length > 0) {
    for (const advisory of report.violations) {
      process.stderr.write(
        `${advisory.packageName}: ${advisory.title} (${advisory.severity})${
          advisory.url ? ` ${advisory.url}` : ""
        }\n`,
      );
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `dependency audit failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
