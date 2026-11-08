import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readRegistryDistTags, readRegistryRelease, REGISTRY_DIST_TAGS_MAX_ENTRIES, REGISTRY_ORIGIN, REGISTRY_READ_ATTEMPTS,
  REGISTRY_RETRY_DELAY_MS,
} from "../../scripts/registry-release-reader.mjs";
import boundedTransport from "../../scripts/bounded-npm-http.cjs";

const { NPM_JSON_MAX_ENTRIES, NPM_METADATA_MAX_BYTES } = boundedTransport;
const NAME = "@kynesyslabs/dacs";
const VERSION = "0.1.0-alpha.1";
const INTEGRITY = "sha512-ZmFrZSBpbnRlZ3JpdHkgZm9yIHJlYWRlciB0ZXN0cw==";
const TARBALL = `${REGISTRY_ORIGIN}/${NAME}/-/dacs-${VERSION}.tgz`;
const ONE_MEBIBYTE = 1024 * 1024;

function versionDocument(overrides = {}) {
  return { name: NAME, version: VERSION, dist: { integrity: INTEGRITY, tarball: TARBALL }, ...overrides };
}
const json = (body, init = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });

// Each queued entry answers one request: a Response, or a function returning one (or throwing).
// The clock is virtual: `wait` advances it, and the request timer never fires unless a test asks.
function harness(queue, { fireTimers = false } = {}) {
  const calls = [];
  const clock = { time: 1_000_000, waits: [] };
  const options = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      return typeof next === "function" ? next(init) : next;
    },
    now: () => clock.time,
    monotonicNow: () => clock.time,
    wait: async (milliseconds) => { clock.waits.push(milliseconds); clock.time += milliseconds; },
    schedule: (callback) => { if (fireTimers) queueMicrotask(callback); return 0; },
    cancel: () => {},
    deadline: clock.time + 60_000,
  };
  return { options, calls, clock };
}

async function refusal(promise, code) {
  const error = await promise.then(() => assert.fail("expected a refusal"), (rejected) => rejected);
  assert.equal(error.code, code, error.message);
  assert.match(error.message, new RegExp(code));
  return error;
}

test("a version document within limits returns its integrity", async () => {
  const { options, calls } = harness([json(versionDocument())]);
  assert.deepEqual(await readRegistryRelease(NAME, VERSION, options), { integrity: INTEGRITY, tarball: TARBALL });
  assert.equal(calls[0].url, `${REGISTRY_ORIGIN}/%40kynesyslabs%2Fdacs/${VERSION}`);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.accept, "application/json");
});

test("a version document with ordinary npm metadata is accepted", async () => {
  const ordinary = versionDocument({
    _id: `${NAME}@${VERSION}`, description: "ordinary", license: "MIT", dependencies: { a: "^1.0.0" }, scripts: { build: "tsc" },
    dist: { integrity: INTEGRITY, tarball: TARBALL, shasum: "0".repeat(40), fileCount: 3, signatures: [{ keyid: "k", sig: "s" }] },
  });
  const { options } = harness([json(ordinary)]);
  assert.equal((await readRegistryRelease(NAME, VERSION, options)).integrity, INTEGRITY);
});

test("a declared content-length above the limit is refused before the body is read", async () => {
  let bodyRead = false;
  const body = new ReadableStream({ pull() { bodyRead = true; } }, { highWaterMark: 0 });
  const { options } = harness([new Response(body, { headers: { "content-length": String(NPM_METADATA_MAX_BYTES + 1) } })]);
  await refusal(readRegistryRelease(NAME, VERSION, options), "registry_oversized");
  assert.equal(bodyRead, false);
});

test("a streamed body above the limit is refused at the limit, before JSON decode", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(ONE_MEBIBYTE).fill(0x20);
  const body = new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(chunk); } });
  const { options, calls } = harness([new Response(body)]);
  const error = await refusal(readRegistryRelease(NAME, VERSION, options), "registry_oversized");
  assert.equal(error.cause.code, "ELIMIT");
  assert.ok(pulls <= NPM_METADATA_MAX_BYTES / ONE_MEBIBYTE + 2, `pulled ${pulls} chunks`);
  assert.equal(calls.length, 1);
});

test("a redirect is refused with registry_redirect_refused", async () => {
  const redirected = () => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") }); };
  const thrown = harness([redirected]);
  const error = await refusal(readRegistryRelease(NAME, VERSION, thrown.options), "registry_redirect_refused");
  assert.equal(error.cause.message, "fetch failed");
  assert.equal(thrown.calls.length, 1);
  const returned = harness([new Response(null, { status: 302, headers: { location: "https://example.invalid/" } })]);
  await refusal(readRegistryRelease(NAME, VERSION, returned.options), "registry_redirect_refused");
});

test("stalled headers time out per request and keep the timeout cause", async () => {
  const stalled = () => new Promise(() => {});
  const { options, calls } = harness([stalled, stalled, stalled], { fireTimers: true });
  const error = await refusal(readRegistryRelease(NAME, VERSION, options), "registry_timeout");
  assert.equal(error.cause.code, "ETIMEDOUT");
  assert.equal(calls.length, REGISTRY_READ_ATTEMPTS);
});

test("a stalled body times out per request", async () => {
  const stalledBody = () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
  const { options } = harness([stalledBody, stalledBody, stalledBody], { fireTimers: true });
  const error = await refusal(readRegistryRelease(NAME, VERSION, options), "registry_timeout");
  assert.equal(error.cause.code, "ETIMEDOUT");
});

test("a transient 5xx is retried within the attempt limit, then fails with the last cause", async () => {
  const recovered = harness([new Response("", { status: 503 }), json(versionDocument())]);
  assert.equal((await readRegistryRelease(NAME, VERSION, recovered.options)).integrity, INTEGRITY);
  assert.deepEqual(recovered.clock.waits, [REGISTRY_RETRY_DELAY_MS]);
  const failing = harness([new Response("", { status: 502 }), new Response("", { status: 503 }), new Response("", { status: 504 })]);
  const error = await refusal(readRegistryRelease(NAME, VERSION, failing.options), "registry_unavailable");
  assert.equal(failing.calls.length, REGISTRY_READ_ATTEMPTS);
  assert.match(error.cause.message, /504/);
});

test("the aggregate deadline stops retries even when attempts remain", async () => {
  const unavailable = () => new Response("", { status: 503 });
  const { options, calls, clock } = harness([unavailable, unavailable, unavailable]);
  options.deadline = clock.time + REGISTRY_RETRY_DELAY_MS + 500;
  await refusal(readRegistryRelease(NAME, VERSION, options), "registry_unavailable");
  assert.equal(calls.length, 2);
  assert.ok(clock.time <= options.deadline);
});

test("404 is absent; 403 is refused, not absent", async () => {
  assert.equal(await readRegistryRelease(NAME, VERSION, harness([new Response("{}", { status: 404 })]).options), undefined);
  const forbidden = harness([new Response("{}", { status: 403 })]);
  const error = await refusal(readRegistryRelease(NAME, VERSION, forbidden.options), "registry_refused");
  assert.match(error.cause.message, /403/);
  assert.equal(forbidden.calls.length, 1);
});

test("malformed JSON, a wrong name or version, a missing integrity or a non-canonical tarball URL is refused as malformed", async () => {
  const bad = {
    "malformed JSON": "{",
    "wrong name": versionDocument({ name: "@kynesyslabs/other" }),
    "wrong version": versionDocument({ version: "0.1.0-alpha.2" }),
    "missing integrity": versionDocument({ dist: { tarball: TARBALL } }),
    "integrity of another algorithm": versionDocument({ dist: { integrity: "sha1-abc", tarball: TARBALL } }),
    "tarball on another host": versionDocument({ dist: { integrity: INTEGRITY, tarball: `https://example.invalid/${NAME}/-/dacs-${VERSION}.tgz` } }),
    "tarball of another version": versionDocument({ dist: { integrity: INTEGRITY, tarball: `${REGISTRY_ORIGIN}/${NAME}/-/dacs-0.1.0-alpha.2.tgz` } }),
    "no dist": versionDocument({ dist: undefined }),
    "a JSON array": [],
  };
  for (const [label, body] of Object.entries(bad)) {
    const error = await refusal(readRegistryRelease(NAME, VERSION, harness([json(body)]).options), "registry_malformed");
    if (label === "malformed JSON") assert.ok(error.cause instanceof SyntaxError);
  }
});

test("dist-tags above the entry limit, or with non-string values, are refused", async () => {
  const tags = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`tag${index}`, VERSION]));
  const accepted = harness([json({ name: NAME, versions: { [VERSION]: {} }, "dist-tags": { ...tags(REGISTRY_DIST_TAGS_MAX_ENTRIES - 1), next: VERSION } })]);
  const observed = await readRegistryDistTags(NAME, accepted.options);
  assert.equal(observed.next, VERSION);
  assert.equal(accepted.calls[0].url, `${REGISTRY_ORIGIN}/%40kynesyslabs%2Fdacs`);
  assert.equal(accepted.calls[0].init.headers.accept, "application/vnd.npm.install-v1+json");
  await refusal(readRegistryDistTags(NAME, harness([json({ name: NAME, "dist-tags": tags(REGISTRY_DIST_TAGS_MAX_ENTRIES + 1) })]).options), "registry_oversized");
  for (const invalid of [{ next: 1 }, [], null, "next"]) {
    const error = await refusal(readRegistryDistTags(NAME, harness([json({ name: NAME, "dist-tags": invalid })]).options), "registry_malformed");
    assert.match(error.message, /dist-tag/);
  }
  assert.equal(await readRegistryDistTags(NAME, harness([new Response("{}", { status: 404 })]).options), undefined);
});

test("an abbreviated package document that names another package, or no package, is refused as malformed even when its next tag matches", async () => {
  const tags = { "dist-tags": { next: VERSION } };
  for (const [label, body] of Object.entries({
    "another package": { name: "@kynesyslabs/other", ...tags },
    "another scope": { name: "@someone/dacs", ...tags },
    "no name": tags,
    "a non-string name": { name: [NAME], ...tags },
  })) {
    const { options, calls } = harness([json(body)]);
    const error = await refusal(readRegistryDistTags(NAME, options), "registry_malformed");
    assert.match(error.message, /names another package/, label);
    assert.equal(calls.length, 1, `${label} is not retried`);
  }
});

// Both documents the reader decodes: the version document and the abbreviated package document.
const readers = {
  "version document": (options) => readRegistryRelease(NAME, VERSION, options),
  "abbreviated package document": (options) => readRegistryDistTags(NAME, options),
};

test("a version document and an abbreviated package document within the byte limit, whose unused metadata exceeds the aggregate entry limit, refuse with registry_oversized and keep the limit error as cause, before any field check", async () => {
  const filler = `${"0,".repeat(NPM_JSON_MAX_ENTRIES + 1)}0`;
  const body = `{"name":"wrong","version":"wrong","filler":[${filler}]}`;
  assert.ok(body.length < NPM_METADATA_MAX_BYTES);
  for (const [label, read] of Object.entries(readers)) {
    const error = await refusal(read(harness([json(body)]).options), "registry_oversized");
    assert.equal(error.cause.code, "ELIMIT", label);
  }
});

test("a version document and an abbreviated package document within the byte limit, whose unused metadata nests deeper than the depth limit, refuse with registry_oversized; unparsable bytes stay registry_malformed with the parse cause", async () => {
  const depth = 130;
  const nested = `{"filler":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  const unterminated = `{"filler":${"[".repeat(depth)}`;
  for (const [label, read] of Object.entries(readers)) {
    const tooDeep = await refusal(read(harness([json(nested)]).options), "registry_oversized");
    assert.equal(tooDeep.cause.code, "ELIMIT", label);
    const unparsable = await refusal(read(harness([json(unterminated)]).options), "registry_malformed");
    assert.ok(unparsable.cause instanceof SyntaxError, label);
  }
});

for (const jump of [-60_000, 60_000]) test(`registry retry budget ignores a ${jump} ms wall jump`, async () => {
  let elapsed = 0, wall = 1_000_000, reads = 0;
  await assert.rejects(readRegistryRelease(NAME, VERSION, {
    deadline: wall + 1_500, now: () => wall, monotonicNow: () => elapsed,
    fetch: async () => { reads += 1; return json({}, { status: 503 }); },
    schedule: () => 0, cancel() {},
    wait: async delay => { elapsed += delay; wall += jump; },
  }), { code: 'registry_unavailable' });
  assert.equal(elapsed, 1_500);
  assert.equal(reads, 2);
});
