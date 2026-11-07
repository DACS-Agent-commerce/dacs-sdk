import { readBoundedBody } from "./check-npm-advisories.mjs";
import boundedTransport from "./bounded-npm-http.cjs";

const { NPM_HTTP_TIMEOUT_MS, NPM_METADATA_MAX_BYTES, jsonScanner } = boundedTransport;

/** The one registry the release path reads and publishes to. It is never taken from the environment or arguments. */
export const REGISTRY_ORIGIN = "https://registry.npmjs.org";
export const REGISTRY_READ_ATTEMPTS = 3;
export const REGISTRY_RETRY_DELAY_MS = 1000;
export const REGISTRY_DIST_TAGS_MAX_ENTRIES = 100;
const FAILURE_CODES = { ETIMEDOUT: "registry_timeout", ELIMIT: "registry_oversized" };
const RETRYABLE_CODES = new Set(["registry_timeout", "registry_unavailable"]);

/** A release-path failure. `code` is its class (for example `registry_timeout`); `cause` keeps the underlying error. */
export class ReleaseError extends Error {
  constructor(code, subject, detail, cause) {
    super(`${code} for ${subject}: ${detail}`, { cause });
    this.code = code;
  }
}

/** Resolves after `milliseconds`. The release path waits only through this function. */
export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function statusFailure(status, subject) {
  const redirected = status >= 300 && status < 400;
  const transient = status >= 500 || status === 408 || status === 429;
  const code = redirected ? "registry_redirect_refused" : transient ? "registry_unavailable" : "registry_refused";
  return new ReleaseError(code, subject, `the registry answered ${status}`, new Error(`HTTP status ${status}`));
}

function classifyFailure(error, subject) {
  if (error instanceof ReleaseError) return error;
  const redirected = error.cause?.message === "unexpected redirect";
  const code = FAILURE_CODES[error.code] ?? (redirected ? "registry_redirect_refused" : "registry_unavailable");
  return new ReleaseError(code, subject, error.message, error);
}

// Parses the bytes, then counts their JSON entries and depth, so unused fields are bounded too.
function decodeDocument(bytes, subject) {
  let document;
  try { document = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch (error) { throw new ReleaseError("registry_malformed", subject, "the reply is not JSON", error); }
  try { jsonScanner()(bytes); } catch (error) { throw new ReleaseError("registry_oversized", subject, error.message, error); }
  return document;
}

async function fetchDocument({ url, accept, subject }, fetch, signal) {
  const response = await fetch(url, { headers: { accept }, redirect: "error", signal });
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw statusFailure(response.status, subject);
  if (Number(response.headers.get("content-length")) > NPM_METADATA_MAX_BYTES) {
    throw Object.assign(new Error("declared content-length is above the limit"), { code: "ELIMIT" });
  }
  return decodeDocument(await readBoundedBody(response, NPM_METADATA_MAX_BYTES), subject);
}

// One attempt, ended by its own deadline even when the transport ignores the abort signal.
async function attemptRead(target, { fetch, schedule, cancel }, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = schedule(() => {
      const timeout = Object.assign(new Error(`the request exceeded ${timeoutMs} ms`), { code: "ETIMEDOUT" });
      controller.abort(timeout);
      reject(timeout);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetchDocument(target, fetch, controller.signal), expired]);
  } catch (error) {
    throw classifyFailure(error, target.subject);
  } finally {
    cancel(timer);
  }
}

// Reads one document, retrying transient failures up to REGISTRY_READ_ATTEMPTS inside the aggregate deadline.
async function readDocument(target, { fetch = globalThis.fetch, now = Date.now, wait = sleep, schedule = setTimeout, cancel = clearTimeout, deadline }) {
  if (!Number.isFinite(deadline)) throw new TypeError("a registry read needs an aggregate deadline");
  let lastError;
  for (let attempt = 1; attempt <= REGISTRY_READ_ATTEMPTS && deadline > now(); attempt += 1) {
    try {
      return await attemptRead(target, { fetch, schedule, cancel }, Math.min(NPM_HTTP_TIMEOUT_MS, deadline - now()));
    } catch (error) {
      if (!RETRYABLE_CODES.has(error.code)) throw error;
      lastError = error;
    }
    if (attempt < REGISTRY_READ_ATTEMPTS) await wait(Math.max(0, Math.min(REGISTRY_RETRY_DELAY_MS, deadline - now())));
  }
  throw lastError ?? new ReleaseError("registry_timeout", target.subject, "the aggregate deadline passed before the read started");
}

function validateRelease(document, name, version, subject) {
  const { integrity, tarball } = document?.dist ?? {};
  const canonicalTarball = `${REGISTRY_ORIGIN}/${name}/-/${name.split("/").pop()}-${version}.tgz`;
  if (document?.name !== name || document.version !== version) throw new ReleaseError("registry_malformed", subject, "the document names another release");
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) throw new ReleaseError("registry_malformed", subject, "dist.integrity is not a sha512 integrity");
  if (tarball !== canonicalTarball) throw new ReleaseError("registry_malformed", subject, "dist.tarball is not the canonical archive URL");
  return { integrity, tarball };
}

function validateDistTags(document, name, subject) {
  if (document?.name !== name) throw new ReleaseError("registry_malformed", subject, "the document names another package");
  const tags = document?.["dist-tags"];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) throw new ReleaseError("registry_malformed", subject, "dist-tags is not an object");
  const values = Object.values(tags);
  if (values.length > REGISTRY_DIST_TAGS_MAX_ENTRIES) throw new ReleaseError("registry_oversized", subject, `dist-tags has more than ${REGISTRY_DIST_TAGS_MAX_ENTRIES} entries`);
  if (values.some((value) => typeof value !== "string")) throw new ReleaseError("registry_malformed", subject, "a dist-tag is not a string");
  return tags;
}

/**
 * Reads one version document. `options` takes the aggregate `deadline` (epoch milliseconds, required) and test seams
 * (`fetch`, `now`, `wait`, `schedule`, `cancel`). Resolves to `{ integrity, tarball }`, or undefined when absent. Throws
 * a ReleaseError (registry_timeout, _refused, _oversized, _malformed, _redirect_refused or _unavailable) with its cause.
 */
export async function readRegistryRelease(name, version, options) {
  const subject = `${name}@${version}`;
  const url = `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const document = await readDocument({ url, accept: "application/json", subject }, options);
  return document === undefined ? undefined : validateRelease(document, name, version, subject);
}

/** Reads a package's `dist-tags` from its abbreviated document; same `options` and errors as readRegistryRelease. Resolves to a tag-to-version object, or undefined when absent. */
export async function readRegistryDistTags(name, options) {
  const document = await readDocument({ url: `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}`, accept: "application/vnd.npm.install-v1+json", subject: name }, options);
  return document === undefined ? undefined : validateDistTags(document, name, name);
}
