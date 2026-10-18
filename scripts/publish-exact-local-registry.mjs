#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

// The acceptance workflow installs exactly this npm client before publishing.
export const PINNED_ACCEPTANCE_NPM_VERSION = "11.19.0";

// Reads package/package.json from an npm pack tarball (gzip + ustar) without
// a host `tar`, so the manifest is the one inside the exact bytes published.
export function readPackedManifest(tarball) {
  const archive = gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = (prefix ? prefix + "/" : "") + field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("packed tarball has a malformed entry size");
    const body = offset + 512;
    if ((type === "0" || type === "") && name === "package/package.json") {
      return JSON.parse(archive.subarray(body, body + size).toString("utf8"));
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error("packed tarball has no package/package.json");
}

function loopbackRegistry(registryValue) {
  const registry = new URL(registryValue);
  if (registry.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(registry.hostname)) {
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
  const fail = detail => {
    throw new Error(`exact local publisher requires the pinned npm ${pinned} (install it with ` +
      `\`npm install --global npm@${pinned}\`): ${detail}`);
  };
  let version;
  let root;
  try {
    version = npm(["--version"]);
    root = npm(["root", "--global"]);
  } catch (error) { fail(`npm is not runnable (${error instanceof Error ? error.message : String(error)})`); }
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
  return new URL(name.replace("/", "%2f"), registry.href.endsWith("/") ? registry.href : registry.href + "/");
}

// Publishes the exact archive under the `acceptance` dist-tag, then proves the
// registry serves only that version with the archive's integrity: an upstream
// copy of the same package can neither shadow nor refuse the candidate.
export async function publishExactLocalRegistry({ archivePath, registry: registryValue, token, publish, fetch: fetchImpl = fetch }) {
  if (!archivePath || !registryValue || !token) {
    throw new Error("usage: DACS_LOCAL_REGISTRY_TOKEN=<token> publish-exact-local-registry.mjs <archive> <registry>");
  }
  const registry = loopbackRegistry(registryValue);
  const tarball = readFileSync(archivePath);
  const manifest = readPackedManifest(tarball);
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("packed manifest has no name or version");
  }
  await publish(manifest, tarball, {
    registry: registry.href,
    defaultTag: "acceptance",
    access: "public",
    provenance: false,
    [`//${registry.host}/:_authToken`]: token,
  });
  const response = await fetchImpl(packumentUrl(registry, manifest.name), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`local registry did not serve ${manifest.name} after publish (HTTP ${response.status})`);
  const packument = await response.json();
  const versions = Object.keys(packument?.versions ?? {});
  if (versions.length !== 1 || versions[0] !== manifest.version) {
    throw new Error(`local registry serves ${manifest.name} versions ${JSON.stringify(versions)}; ` +
      `expected only the candidate ${manifest.version} (an uplink must not serve candidate packages)`);
  }
  const integrity = "sha512-" + createHash("sha512").update(tarball).digest("base64");
  const served = packument.versions[manifest.version]?.dist?.integrity;
  if (served !== integrity) {
    throw new Error(`local registry integrity for ${manifest.name}@${manifest.version} is ${String(served)}, expected ${integrity}`);
  }
  return { name: manifest.name, version: manifest.version, integrity };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archivePath, registry] = process.argv.slice(2);
  const token = process.env.DACS_LOCAL_REGISTRY_TOKEN;
  if (!archivePath || !registry || !token) {
    throw new Error("usage: DACS_LOCAL_REGISTRY_TOKEN=<token> publish-exact-local-registry.mjs <archive> <registry>");
  }
  await publishExactLocalRegistry({ archivePath, registry, token, publish: loadPinnedLibnpmpublish() });
}
