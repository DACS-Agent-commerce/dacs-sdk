#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { Agent } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

// Future acceptance workflows must install exactly this npm client before publishing.
export const PINNED_ACCEPTANCE_NPM_VERSION = "11.19.0";

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_TAR_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const REGISTRY_TIMEOUT_MS = 15_000;
const TAR_BLOCK_BYTES = 512;
// Closed npm-pack header shapes; every byte after the name is covered.
const NUL = /^\0+$/, OCTAL_10 = /^[0-7]{10} \0$/;
const HEADER_FIELDS = [
  [100, 8, /^000[0-7]{3} \0$/], [108, 16, NUL], [124, 12, OCTAL_10], [136, 12, OCTAL_10],
  [148, 8, /^[0-7]{6} \0$/], [156, 1, /^0$/], [157, 100, NUL], [257, 8, /^ustar\x0000$/],
  [265, 64, NUL], [329, 16, /^(?:000000 \0){2}$/], [345, 167, NUL],
];
const PACKAGE_PATH = /^package(?:\/[A-Za-z0-9_@+.-]*[A-Za-z0-9_@+-])+$/;
const RESERVED_NAME = /\/(?:con|prn|aux|nul|com\d|lpt\d)(?:\.[^/]*)?(?:\/|$)/i;
const MAX_PACKAGE_NAME_LENGTH = 214;
const MAX_VERSION_LENGTH = 256;
// Metadata fields npm registries may add without changing the packed manifest.
const NPM_ADDED_FIELDS = new Set(["_id", "_nodeVersion", "_npmVersion", "_npmUser"]);
const NPM_ADDED_DIST_FIELDS = ["integrity", "shasum", "tarball"];

function packedHeader(header) {
  for (const [start, length, shape] of HEADER_FIELDS) {
    const field = header.subarray(start, start + length).toString("latin1");
    // Compare the whole match too: JavaScript's $ permits a final newline.
    if (shape.exec(field)?.[0].length !== length) throw new Error("packed tarball has a noncanonical header field");
  }
  const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (Number.parseInt(header.toString("latin1", 148, 156), 8) !== checksum) {
    throw new Error("packed tarball has an invalid checksum");
  }
  const name = header.toString("latin1", 0, 100).replace(/\0+$/, "");
  if (PACKAGE_PATH.exec(name)?.[0] !== name || RESERVED_NAME.test(name)) {
    throw new Error("packed tarball has an unsupported path (canonical ASCII npm-pack paths required)");
  }
  return { name, size: Number.parseInt(header.toString("latin1", 124, 136), 8) };
}

function packedManifest(body) {
  if (body.length > MAX_JSON_BYTES) throw new Error("packed manifest exceeded byte limit");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body));
  } catch (cause) { throw new Error("packed tarball has an invalid manifest JSON", { cause }); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("packed tarball manifest must be an object");
  }
  return manifest;
}

// Returns the sole manifest and a map of exact file bodies. Throws unless the
// bounded gzip archive uses the canonical npm-pack subset, with unambiguous paths.
export function readPackedArchive(tarball) {
  if (tarball.length > MAX_ARCHIVE_BYTES) throw new Error("packed archive exceeded byte limit");
  let archive;
  try { archive = gunzipSync(tarball, { maxOutputLength: MAX_TAR_BYTES }); }
  catch (cause) { throw new Error("packed tarball cannot be decompressed within byte limit", { cause }); }
  const limit = archive.length - 2 * TAR_BLOCK_BYTES;
  if (limit < 0 || archive.length % TAR_BLOCK_BYTES || archive.subarray(limit).some(byte => byte !== 0)) {
    throw new Error("packed tarball has a malformed trailer");
  }
  const files = new Map(), entries = new Set(), directories = new Set();
  let manifest;
  for (let offset = 0; offset < limit;) {
    const { name, size } = packedHeader(archive.subarray(offset, offset + TAR_BLOCK_BYTES));
    const body = offset + TAR_BLOCK_BYTES, end = body + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (end > limit) throw new Error("packed tarball has a truncated entry");
    if (archive.subarray(body + size, end).some(byte => byte !== 0)) throw new Error("packed tarball has nonzero body padding");
    const key = name.toLowerCase(), parts = key.split("/");
    const parents = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
    if (entries.has(key) || directories.has(key) || parents.some(parent => entries.has(parent))) {
      throw new Error("packed tarball has duplicate or conflicting paths");
    }
    entries.add(key); for (const parent of parents) directories.add(parent);
    const bytes = archive.subarray(body, body + size);
    files.set(name, bytes);
    if (name === "package/package.json") manifest = packedManifest(bytes);
    offset = end;
  }
  if (manifest === undefined) throw new Error("packed tarball has no package/package.json");
  return { manifest, files };
}

// Reads the sole object manifest, throwing for unsupported or ambiguous archives.
export function readPackedManifest(tarball) { return readPackedArchive(tarball).manifest; }

function readArchive(archivePath) {
  const descriptor = openSync(archivePath, "r");
  try {
    if (fstatSync(descriptor).size > MAX_ARCHIVE_BYTES) throw new Error("packed archive exceeded byte limit");
    const bytes = Buffer.alloc(MAX_ARCHIVE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) return bytes.subarray(0, length);
      length += count;
    }
    throw new Error("packed archive exceeded byte limit");
  } finally { closeSync(descriptor); }
}

function loopbackRegistry(registryValue) {
  const registry = new URL(registryValue);
  if (registry.username || registry.password || /[?#]/.test(registry.href) || registry.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(registry.hostname)) {
    throw new Error("exact local publisher only accepts a loopback HTTP registry");
  }
  return registry;
}

// npm 11.19.0 gives explicit CLI flags precedence over publishConfig, including
// --provenance=false. This helper uses its pinned libnpmpublish directly to pass
// the exact archive bytes and explicit local-registry options in one call,
// without rewriting the packed manifest's publishConfig. The version/layout
// checks below keep that direct dependency on npm internals explicit.
export function loadPinnedLibnpmpublish({
  npm = args => execFileSync("npm", args, { encoding: "utf8" }).trim(),
  pinned = PINNED_ACCEPTANCE_NPM_VERSION,
} = {}) {
  const fail = (detail, cause) => {
    throw new Error(`exact local publisher requires the pinned npm ${pinned} (install it with ` +
      `\`npm install --global npm@${pinned}\`): ${detail}`, { cause });
  };
  let version;
  let root;
  try {
    version = npm(["--version"]);
    root = npm(["root", "--global"]);
  } catch (error) { fail(`npm is not runnable (${error instanceof Error ? error.message : String(error)})`, error); }
  if (version !== pinned) fail(`npm --version reports ${JSON.stringify(version)}`);
  const npmPackage = path.join(root, "npm", "package.json");
  if (!existsSync(npmPackage)) fail(`no npm package at ${npmPackage}`);
  const installed = JSON.parse(readFileSync(npmPackage, "utf8")).version;
  if (installed !== pinned) fail(`${npmPackage} is version ${JSON.stringify(installed)}`);
  const modulePath = path.join(root, "npm", "node_modules", "libnpmpublish");
  if (!existsSync(path.join(modulePath, "package.json"))) fail(`libnpmpublish is not bundled at ${modulePath}`);
  const { publish } = createRequire(import.meta.url)(modulePath);
  if (typeof publish !== "function") fail(`${modulePath} does not export publish()`);
  return publish;
}

function packumentUrl(registry, name) {
  const escapedName = encodeURIComponent(name).replace("%40", "@").replace("%2F", "%2f");
  return new URL(escapedName, registry.href.endsWith("/") ? registry.href : registry.href + "/");
}

async function registryDeadline(operation) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`local registry request timed out after ${REGISTRY_TIMEOUT_MS} ms`);
      reject(error);
      controller.abort(error);
    }, REGISTRY_TIMEOUT_MS);
  });
  try { return await Promise.race([deadline, operation(controller.signal)]); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function registryBytes(url, fetchImpl, maximumBytes, accept) {
  return registryDeadline(async signal => {
    const response = await fetchImpl(url, { redirect: "error", signal, headers: { accept } });
    signal.throwIfAborted();
    const reader = response.body?.getReader();
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (!response.ok) throw new Error(`local registry did not serve ${url} (HTTP ${response.status})`);
      if (Number(response.headers.get("content-length")) > maximumBytes) {
        throw new Error(`local registry response exceeded ${maximumBytes} bytes`);
      }
      if (!reader) throw new Error("local registry response has no body");
      const chunks = [];
      let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximumBytes) throw new Error(`local registry response exceeded ${maximumBytes} bytes`);
        chunks.push(value);
      }
      return Buffer.concat(chunks, length);
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      reader?.releaseLock();
    }
  });
}

// npm-registry-fetch buffers error bodies internally. Bound its HTTP transport
// before decoding, and refuse compression/redirects that could bypass the cap.
class LocalRegistryAgent extends Agent {
  constructor(registry) { super(); this.registry = registry; }
  addRequest(request, options) {
    if (this.refusal || request.getHeader("host") !== this.registry.host) {
      this.refusal ??= new Error("local registry publish redirect left the registry origin");
      // No socket was assigned, so destroy() alone cannot emit the error.
      queueMicrotask(() => { request.destroy(); request.emit("error", this.refusal); });
      return;
    }
    request.setHeader("accept-encoding", "identity");
    request.once("response", response => {
      const refuse = message => {
        this.refusal ??= new Error(message);
        response.destroy(this.refusal);
        request.destroy(this.refusal);
      };
      if (response.statusCode >= 300 && response.statusCode < 400) {
        refuse("local registry publish redirect is forbidden");
      } else if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        refuse("local registry encoded publication response is forbidden");
      } else if (Number(response.headers["content-length"]) > MAX_JSON_BYTES) {
        refuse(`local registry response exceeded ${MAX_JSON_BYTES} bytes`);
      }
      let length = 0;
      response.on("data", chunk => {
        length += chunk.length;
        if (length > MAX_JSON_BYTES) refuse(`local registry response exceeded ${MAX_JSON_BYTES} bytes`);
      });
    });
    super.addRequest(request, options);
  }
}

function requireCanonicalIdentity({ name, version }) {
  // This publisher accepts canonical, URL-safe names and semver without build
  // metadata: npm's semver.clean strips build metadata and v/= prefixes.
  const match = typeof version === "string" && version.length <= MAX_VERSION_LENGTH &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (typeof name !== "string" || name.trim() !== name || name.length > MAX_PACKAGE_NAME_LENGTH ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
      !match || match[0] !== version || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part))) ||
      match[4]?.split(".").some(part => /^0\d+$/.test(part))) {
    throw new Error("packed manifest must have a canonical npm name and version");
  }
}

function verifyManifestMetadata(packument, manifest) {
  const served = { ...packument.versions[manifest.version] };
  const publishedId = served._id;
  const dist = { ...served.dist };
  for (const field of NPM_ADDED_DIST_FIELDS) if (!Object.hasOwn(manifest.dist ?? {}, field)) delete dist[field];
  if (Object.hasOwn(manifest, "dist") || Object.keys(dist).length) served.dist = dist;
  else delete served.dist;
  // Never disregard a packed field, even when npm normally adds that field.
  for (const field of NPM_ADDED_FIELDS) if (!Object.hasOwn(manifest, field)) delete served[field];
  // Verdaccio adds an empty contributors list when none was packed.
  if (!Object.hasOwn(manifest, "contributors") && isDeepStrictEqual(served.contributors, [])) delete served.contributors;
  if (packument.name !== manifest.name || (packument._id !== undefined && packument._id !== manifest.name) ||
      (publishedId !== undefined && publishedId !== `${manifest.name}@${manifest.version}`) ||
      !isDeepStrictEqual(served, manifest)) {
    throw new Error("local registry package metadata does not match packed manifest");
  }
}

async function verifyCandidate(registry, manifest, tarball, fetchImpl) {
  const bytes = await registryBytes(packumentUrl(registry, manifest.name), fetchImpl, MAX_JSON_BYTES, "application/json");
  let packument;
  try { packument = JSON.parse(bytes.toString("utf8")); }
  catch (cause) { throw new Error("local registry has invalid packument JSON", { cause }); }
  const publishedVersions = packument?.versions;
  const versions = publishedVersions && typeof publishedVersions === "object" && !Array.isArray(publishedVersions)
    ? Object.keys(publishedVersions) : [];
  // Exactly one version is also the decoded list-size limit.
  if (versions.length !== 1 || versions[0] !== manifest.version) {
    throw new Error(`local registry serves ${manifest.name} versions ${JSON.stringify(versions)}; ` +
      `expected only the candidate ${manifest.version} (an uplink must not serve candidate packages)`);
  }
  const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
  const dist = publishedVersions[manifest.version]?.dist;
  if (dist?.integrity !== integrity) {
    throw new Error(`local registry integrity for ${manifest.name}@${manifest.version} is ${String(dist?.integrity)}, expected ${integrity}`);
  }
  const shasum = createHash("sha1").update(tarball).digest("hex");
  if (dist?.shasum !== shasum) throw new Error("local registry shasum does not match packed archive");
  verifyManifestMetadata(packument, manifest);
  if (packument["dist-tags"]?.acceptance !== manifest.version) throw new Error("local registry acceptance tag does not match candidate");
  let tarballUrl;
  try { tarballUrl = new URL(dist.tarball); } catch (cause) { throw new Error("local registry has an invalid tarball URL", { cause }); }
  if (typeof dist.tarball !== "string" || tarballUrl.origin !== registry.origin || tarballUrl.username || tarballUrl.password) {
    throw new Error("local registry tarball URL must stay on the registry origin without credentials");
  }
  const served = await registryBytes(tarballUrl, fetchImpl, MAX_ARCHIVE_BYTES, "application/octet-stream");
  if (!served.equals(tarball)) throw new Error("local registry tarball bytes do not match candidate archive");
  return { name: manifest.name, version: manifest.version, integrity };
}

// Publishes the unchanged archive with the acceptance tag, or verifies an
// existing version after a publish conflict. Returns its identity and SHA-512;
// throws unless bounded registry reads prove the sole version, metadata and bytes.
export async function publishExactLocalRegistry({ archivePath, registry: registryValue, token, publish, fetch: fetchImpl = fetch }) {
  if (!archivePath || !registryValue || !token) {
    throw new Error("usage: DACS_LOCAL_REGISTRY_TOKEN=<token> publish-exact-local-registry.mjs <archive> <registry>");
  }
  const registry = loopbackRegistry(registryValue);
  const tarball = readArchive(archivePath);
  const manifest = readPackedManifest(tarball);
  requireCanonicalIdentity(manifest);
  // libnpmpublish prefers manifest.tag to defaultTag; never certify another tag.
  if (manifest.tag !== undefined && manifest.tag !== "acceptance") throw new Error("packed manifest tag must be acceptance");
  const agent = new LocalRegistryAgent(registry);
  try {
    await registryDeadline(signal => publish(manifest, tarball, {
      registry: registry.href,
      defaultTag: "acceptance",
      access: "public",
      provenance: false,
      timeout: REGISTRY_TIMEOUT_MS,
      fetchRetries: 0,
      agent, signal,
      [`//${registry.host}/:_authToken`]: token,
    }));
    if (agent.refusal) throw agent.refusal;
  } catch (error) {
    if (agent.refusal) throw agent.refusal;
    if (error?.code !== "EPUBLISHCONFLICT" && error?.statusCode !== 409) throw error;
  } finally { agent.destroy(); }
  return verifyCandidate(registry, manifest, tarball, fetchImpl);
}

// A symlink is a valid CLI entry, while importing with a non-file argv is safe.
function isCommandLine() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (isCommandLine()) {
  const [archivePath, registry] = process.argv.slice(2);
  const token = process.env.DACS_LOCAL_REGISTRY_TOKEN;
  await publishExactLocalRegistry({ archivePath, registry, token, publish: loadPinnedLibnpmpublish() });
}
