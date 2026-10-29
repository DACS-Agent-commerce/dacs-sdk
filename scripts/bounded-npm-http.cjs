// Opt-in admission of the original bytes npm's HTTP readers consume.
const http = require("node:http");
const https = require("node:https");
const { PassThrough } = require("node:stream");
const { finished } = require("node:stream/promises");
const { createGunzip } = require("node:zlib");
const { syncBuiltinESMExports } = require("node:module");
const NPM_METADATA_MAX_BYTES = 64 * 1024 * 1024;
const NPM_TARBALL_MAX_BYTES = 64 * 1024 * 1024;
const NPM_TARBALL_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const NPM_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
const NPM_HTTP_TIMEOUT_MS = 15_000;
const NPM_JSON_MAX_ENTRIES = 2_000_000, NPM_JSON_MAX_DEPTH = 128;
const limitError = limit => Object.assign(new Error("ELIMIT npm HTTP response " + limit + " limit exceeded"), { code: "ELIMIT" });
const timeoutError = () => Object.assign(new Error("ETIMEDOUT npm HTTP deadline"), { code: "ETIMEDOUT" });

/** Returns a wire budget; the audit route can only lower it. */
function responseBudget(path) {
  return /\/-\/npm\/v1\/security\//.test(path) ? NPM_AUDIT_MAX_BYTES : NPM_METADATA_MAX_BYTES;
}

// Count tokens, not parsed objects: npm can consume multiple roots and duplicate
// keys. Syntax remains npm's responsibility. State survives every chunk boundary.
function jsonScanner() {
  const containers = [];
  let entries = 0, string = false, escaped = false;
  return bytes => {
    for (const byte of bytes) {
      if (string) {
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) string = false;
        continue;
      }
      if (byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === 58) continue;
      if (byte === 93 || byte === 125) { containers.pop(); continue; }
      const parent = containers[containers.length - 1];
      if (byte === 44) { if (parent) parent.next = true; continue; }
      if (parent?.next) {
        parent.next = false;
        if (++entries > NPM_JSON_MAX_ENTRIES) throw limitError("JSON entries");
      }
      if (byte === 34) string = true;
      if (byte === 91 || byte === 123) {
        // Keep the existing boundary: root depth is zero, so depth 128 is valid.
        if (containers.length > NPM_JSON_MAX_DEPTH) throw limitError("JSON depth");
        containers.push({ next: true });
      }
    }
  };
}

/** Buffers original wire bytes, incrementally admitting JSON tokens or gzip output.
 * Throws ELIMIT on overflow; json is retained for callers using the old signature,
 * but no route or caller can turn off token admission. Encoded bodies are refused.
 * Aborting `signal` stops reading and decompression and rejects with its reason. */
async function readBoundedResponse(response, maximum, json = true, archiveMaximum = maximum, signal) {
  signal?.throwIfAborted();
  if (Number(response.headers["content-length"]) > maximum) throw limitError("byte");
  const encoding = response.headers["content-encoding"]?.toLowerCase();
  const chunks = [], scan = jsonScanner();
  let length = 0, mode, gunzip, complete, expanded = 0;
  const abort = () => { gunzip?.destroy(signal.reason); response.destroy(); };
  const inspect = async bytes => {
    if (!mode) {
      if (bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) throw new Error("unsupported npm archive compression: zstd");
      mode = bytes[0] === 0x1f && bytes[1] === 0x8b ? "gzip" : "tokens";
      if (mode === "gzip") {
        gunzip = createGunzip();
        gunzip.on("data", chunk => { expanded += chunk.length; if (expanded > archiveMaximum) gunzip.destroy(limitError("gzip expansion")); });
        complete = finished(gunzip);
        complete.catch(() => {}); // Writes/end below observe the original failure.
      }
    }
    if (gunzip) await Promise.race([complete, new Promise((resolve, reject) => gunzip.write(bytes, error => error ? reject(error) : resolve()))]);
    else scan(bytes);
  };
  try {
    signal?.addEventListener("abort", abort, { once: true });
    for await (const chunk of response) {
      if (!chunk.length) continue;
      if (encoding && encoding !== "identity") throw new Error("unsupported npm HTTP content encoding: " + encoding);
      length += chunk.length;
      if (length > maximum) throw limitError("byte");
      chunks.push(chunk);
      // Wait for a complete magic prefix, even across one-byte chunks.
      if (mode) await inspect(chunk);
      else if (length >= 4) await inspect(Buffer.concat(chunks, length));
    }
    if (!mode && length) await inspect(Buffer.concat(chunks, length));
    if (gunzip) { gunzip.end(); await complete; }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, length);
  } catch (error) { signal?.throwIfAborted(); throw error; }
  finally { signal?.removeEventListener("abort", abort); gunzip?.destroy(); }
}

/** Installs opt-in HTTP(S) admission, with one socket-to-admission deadline per request. */
function installBoundedNpmHttp({ transports = [http, https], schedule = setTimeout, cancel = clearTimeout,
  now = () => performance.now() } = {}) {
  for (const transport of transports) {
    const request = transport.request;
    transport.request = function (...args) {
      const pending = request.apply(this, args), emit = pending.emit;
      pending.setHeader("accept-encoding", "identity");
      let failed = false, timer, deadline, response;
      // Admission can outlive the request (its body may already be read), so the
      // deadline and request failures cancel admission directly.
      const admission = new AbortController();
      const clear = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
      const stop = error => { failed = true; clear(); admission.abort(error); };
      // Delivers exactly one error after a response starts, whatever fails first.
      const fail = error => {
        if (failed) return;
        stop(error); response.destroy(); pending.destroy();
        emit.call(pending, "error", error);
      };
      pending.once("socket", () => {
        if (failed) return;
        deadline = now() + NPM_HTTP_TIMEOUT_MS;
        timer = schedule(() => response ? fail(timeoutError()) : pending.destroy(timeoutError()), NPM_HTTP_TIMEOUT_MS);
      });
      pending.once("error", error => stop(error));
      pending.once("abort", () => stop());
      pending.once("close", () => { if (!response) stop(); });
      pending.emit = function (event, incoming, ...rest) {
        if (event !== "response") return emit.call(this, event, incoming, ...rest);
        response = incoming;
        // npm relays request failures to req.res. That is the original response,
        // not the admitted stream, so absorb its relay while preserving one cause.
        response.on("error", () => {});
        if (deadline !== undefined && now() >= deadline) { fail(timeoutError()); return true; }
        if (pending.method === "HEAD" || response.statusCode === 204 || response.statusCode === 304) {
          clear(); return emit.call(this, event, response, ...rest);
        }
        readBoundedResponse(response, responseBudget(pending.path), true, NPM_TARBALL_MAX_UNPACKED_BYTES, admission.signal).then(bytes => {
          if (deadline !== undefined && now() >= deadline) { fail(timeoutError()); return; }
          if (failed) return;
          clear();
          const admitted = new PassThrough();
          for (const field of ["statusCode", "statusMessage", "httpVersion", "headers", "rawHeaders", "trailers", "socket", "req", "url"]) admitted[field] = response[field];
          emit.call(pending, "response", admitted);
          admitted.end(bytes);
        }, fail);
        return true;
      };
      return pending;
    };
    transport.get = function (...args) { const pending = transport.request(...args); pending.end(); return pending; };
  }
  syncBuiltinESMExports();
}
module.exports = { responseBudget, readBoundedResponse, installBoundedNpmHttp,
  NPM_METADATA_MAX_BYTES, NPM_TARBALL_MAX_BYTES, NPM_TARBALL_MAX_UNPACKED_BYTES, NPM_AUDIT_MAX_BYTES, NPM_HTTP_TIMEOUT_MS, NPM_JSON_MAX_ENTRIES };
if (process.env.DACS_BOUNDED_NPM_HTTP === "1") installBoundedNpmHttp();
