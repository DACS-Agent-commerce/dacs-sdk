import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import npa from "npm-package-arg";
import semver from "semver";
import { validateReleaseIdentity } from "./release-identity.mjs";

const policy = JSON.parse(readFileSync(new URL("./release-policy.json", import.meta.url)));
export const { packages, plannedVersion } = policy;
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"];
function registrySpec(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = npa.resolve("dependency", value);
    const spec = parsed.type === "alias" ? parsed.subSpec : parsed;
    return ["version", "range", "tag"].includes(spec.type) &&
      !(parsed.type === "alias" && packages.some(p => p.name === spec.name));
  } catch { return false; }
}
// Node can load these from an export target; maps, declarations and other files cannot be imported.
const runtimeTarget = /\.(?:[cm]?js|json)$/;
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fail = message => { throw new Error(message); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

function entryTargets(p) {
  return ["bin", "main", "types"].flatMap(field => {
    if (!Object.hasOwn(p, field)) return [];
    const paths = field === "bin" && record(p[field]) ? Object.values(p[field]) : [p[field]];
    if (paths.some(path => typeof path !== "string" || !path)) fail(`invalid ${field} target`);
    return paths;
  });
}

function exportTargets(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    let decoded;
    try { decoded = decodeURIComponent(value.slice(2)); } catch { fail(`invalid export target: ${value}`); }
    if (!value.startsWith("./") || /[%?#]/.test(value) || decoded.includes("\\") ||
        decoded.split("/").some(segment => /^(\.{1,2}|node_modules)$/i.test(segment))) fail(`invalid export target: ${value}`);
    return [value];
  }
  if (Array.isArray(value) || record(value)) {
    if (Object.hasOwn(value, "module-sync")) fail("unsupported export condition: module-sync");
    if (!Array.isArray(value) && Object.keys(value).some(key => /^\d+$/.test(key))) fail("invalid export condition");
    return Object.values(value).flatMap(exportTargets);
  }
  fail("invalid export target type");
}

function exportMap(value) {
  if (typeof value === "string" || Array.isArray(value) || value === null) return { ".": value };
  if (value && Object.keys(value).length && Object.keys(value).every(key => !key.startsWith("."))) return { ".": value };
  const map = value ?? {};
  for (const key of Object.keys(map)) validateExportSubpath(key);
  return map;
}

function validateExportSubpath(key) {
  if (key !== "." && (!key.startsWith("./") ||
    /[%?#\\]/.test(key) || key.split("*").length > 2 ||
    key.slice(2).split("/").some(segment => /^(|\.{1,2}|node_modules)$/i.test(segment)))) fail(`invalid export subpath: ${key}`);
}

function importTarget(value) {
  if (typeof value === "string" || value === null) return value;
  if (Array.isArray(value)) {
    for (const child of value) { const target = importTarget(child); if (target) return target; }
    return null;
  }
  for (const [condition, child] of Object.entries(value ?? {})) {
    if (["node", "node-addons", "import", "default"].includes(condition)) {
      const target = importTarget(child);
      if (target !== undefined) return target;
    }
  }
}

function dependencyTargets(value, nested, path = "") {
  if (!record(value)) fail(`malformed dependency map: ${path}`);
  return Object.entries(value).flatMap(([key, child]) => {
    const name = path ? `${path}/${key}` : key;
    if (typeof child === "string") return [[name, child]];
    if (nested && record(child)) return dependencyTargets(child, true, name);
    fail(`malformed dependency value: ${name}`);
  });
}

function collectProblems(checks) {
  const errors = [];
  for (const check of checks) try { check(); } catch (error) { errors.push(...error.message.split("\n")); }
  return errors;
}

function validateDependencies(p) {
  const errors = [];
  for (const section of sections) for (let [path, value] of Object.hasOwn(p, section) ?
    dependencyTargets(p[section], ["overrides", "resolutions"].includes(section), section) : []) {
    if (section === "overrides" && value.startsWith("$")) {
      const name = value.slice(1);
      value = p.dependencies?.[name] ?? p.devDependencies?.[name] ?? p.optionalDependencies?.[name];
    }
    if (!registrySpec(value)) errors.push(`non-registry dependency in ${section}: ${value} (${path.slice(section.length + 1)})`);
  }
  if (errors.length) fail(errors.join("\n"));
}

function validateInternalPins(p, version) {
  const errors = [];
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of packages.map(d => d.name)) if (Object.hasOwn(p[section] ?? {}, name) && p[section][name] !== version) errors.push(`internal dependency must use exact release version: ${name}`);
  }
  if (errors.length) fail(errors.join("\n"));
}

export function validateArtifactSet(artifacts, planned = false) {
  if (planned) {
    if (artifacts.length !== packages.length || packages.some(definition =>
      artifacts.filter(a => a.manifest.name === definition.name && a.releasable).length !== 1))
      fail("strict release requires all five publicly releasable package identities");
    for (const { manifest } of artifacts) validateManifest(manifest, packages.find(p => p.name === manifest.name));
  }
  const version = planned ? plannedVersion : artifacts[0]?.manifest.version;
  const names = new Set();
  for (const { manifest: p } of artifacts) {
    if (!packages.some(d => d.name === p.name) || names.has(p.name)) fail(`unknown or duplicate release package identity: ${p.name}`);
    names.add(p.name);
    validateReleaseIdentity(p, p.name);
    if (p.version !== version) fail(`release versions differ: ${p.version} vs ${version}`);
    validateDependencies(p);
    validateInternalPins(p, version);
  }
}

function manifestProblems(p, definition) {
  return collectProblems([
    () => validateDependencies(p),
    () => Object.values(exportMap(p.exports)).flatMap(exportTargets),
    () => entryTargets(p),
    () => { if (Object.hasOwn(p, "private") && p.private !== false) fail("private package is not releasable"); },
    () => validateReleaseIdentity(p, definition.name),
    () => {
      const version = typeof p.version === "string" && semver.parse(p.version);
      if (!version || version.version + (version.build.length ? `+${version.build.join(".")}` : "") !== p.version) fail("invalid package version");
    },
    ...definition.requiredExports.map(key => () => {
      const value = exportMap(p.exports)[key];
      if (!value) fail(`missing public export ${key}`);
      const target = importTarget(value);
      if (!target || !runtimeTarget.test(target)) fail(`runtime target required for public export ${key}`);
    }),
  ]);
}

export function validateManifest(p, definition) {
  const errors = manifestProblems(p, definition);
  if (errors.length) fail(errors.join("\n"));
}

function pattern(glob) {
  // Only * and **/ are supported; everything else is a literal path character.
  return new RegExp("^" + glob.split(/(\*\*\/|\*)/).map(part =>
    part === "**/" ? "(?:.*/)?" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
}

export function publicEntries(p, files) {
  const map = exportMap(p.exports), entries = new Map();
  const keys = Object.keys(map);
  if (keys.some(key => !key.startsWith("."))) fail("unsupported mixed export map");
  const matchKey = (key, subpath) => {
    if (!key.includes("*")) return key === subpath;
    const [prefix, suffix] = key.split("*");
    return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length > prefix.length + suffix.length;
  };
  const effectiveKey = subpath => keys.includes(subpath) ? subpath : keys.filter(key => key.includes("*") && matchKey(key, subpath))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)[0];
  for (const [key, value] of Object.entries(map)) {
    if (value === null) continue;
    const paths = exportTargets(value);
    if (!paths.length) fail(`missing export target ${key}`);
    const captures = new Set();
    if (key.includes("*")) {
      if (key.split("*").length !== 2) fail(`unsupported export pattern ${key}`);
      for (const target of paths.filter(t => t.includes("*"))) {
        const matcher = new RegExp("^" + target.slice(2).split("*").map((part, i) =>
          (i === 0 ? "" : i === 1 ? "(.+)" : "\\1") + escapePattern(part)).join("") + "$");
        for (const file of files) { const match = matcher.exec(file); if (match) captures.add(match[1]); }
      }
      if (!captures.size) fail(`export ${key} has no packed matches`);
    } else captures.add("");
    for (const capture of captures) {
      const subpath = key.replace("*", () => capture);
      if (effectiveKey(subpath) !== key) continue;
      validateExportSubpath(subpath);
      // Node substitutes the capture only for pattern keys; elsewhere a star is a literal filename character.
      const concrete = key.includes("*") ? paths.flatMap(target => exportTargets(target.replaceAll("*", () => capture))) : paths;
      for (const target of concrete) if (!files.includes(target.slice(2))) fail(`missing packed target: ${target} (${subpath})`);
      entries.set(subpath, { subpath, json: concrete.some(t => t.endsWith(".json")) });
    }
  }
  return [...entries.values()];
}

export function validateFiles(definition, p, files) {
  for (const file of files) {
    if (isAbsolute(file) || file.split("/").some(s => s === ".." || s === ".") || file.includes("\\")) fail(`invalid packed path: ${file}`);
    if (!definition.allow.some(glob => pattern(glob).test(file))) fail(`outside allow-list: ${file}`);
  }
  const literalExportTargets = Object.entries(exportMap(p.exports)).flatMap(([key, value]) =>
    exportTargets(value).filter(target => !key.includes("*") || !target.includes("*")));
  const required = ["./package.json", ...literalExportTargets, ...entryTargets(p)];
  for (const target of required) {
    const path = target.startsWith("./") ? target.slice(2) : target;
    if (path.split("/").some(s => s === ".." || s === ".") || isAbsolute(path) || path.includes("\\")) fail(`invalid export target: ${target}`);
    // Pattern-key targets containing a star are checked per concrete capture by publicEntries below.
    if (!files.includes(path)) fail(`missing packed target: ${target}`);
  }
  publicEntries(p, files);
}

export function validateLock(lock, artifacts, consumer = ".", omitOptional = false) {
  if (!record(lock?.packages)) fail("lock requires a packages map");
  const allowed = new Map(artifacts.map(({ name, tarball }) => [name, resolve(tarball)]));
  const installed = new Set();
  for (const [name, value] of Object.entries(lock.packages)) {
    if (!record(value)) fail(`invalid lock entry: ${name}`);
    const resolution = typeof value.resolved === "string" ? value.resolved : "";
    // npm does not read a query, fragment or escape in a file path the way a path resolver does.
    if (resolution.startsWith("file:") && /[?#%]/.test(resolution)) fail(`ambiguous local file resolution: ${name}`);
    const path = resolution.startsWith("file:") ? resolve(consumer, resolution.slice(5)) : null;
    const internal = packages.filter(p => value.name === p.name || name === `node_modules/${p.name}` || name.endsWith(`/node_modules/${p.name}`));
    if (internal.some(p => allowed.get(p.name) !== path)) fail(`internal package must resolve to supplied tarball: ${name}`);
    const artifact = internal.length > 0 && internal.every(p => allowed.get(p.name) === path);
    // External install resolutions must be registry tarballs, never links or git/path specs.
    let registry = false;
    try { registry = new URL(resolution).origin === "https://registry.npmjs.org"; } catch {}
    // npm records optional dependency metadata even with --omit=optional.
    // It is not installed; internal identities above must still use our tarballs.
    const omitted = omitOptional && value.optional === true;
    if (artifact && !omitted) for (const p of internal) {
      if (name === `node_modules/${p.name}` || name.endsWith(`/node_modules/${p.name}`)) installed.add(p.name);
    }
    // Bundled children are extracted from a separately qualified parent tarball.
    const parent = name.slice(0, name.lastIndexOf("/node_modules/"));
    const bundled = value.inBundle === true && parent !== name && record(lock.packages[parent]);
    if (value.link || (!omitted && name && !(bundled && !resolution) && !artifact && !registry)) fail(`installed local link or non-registry resolution: ${name}`);
  }
  for (const name of allowed.keys()) if (!installed.has(name)) fail(`missing installed artifact in lock: ${name}`);
}

