// Opt-in npm HTTP admission, before npm's decompression and JSON readers.
const http = require("node:http");
const https = require("node:https");
const { PassThrough } = require("node:stream");
const { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } = require("node:zlib");
const { syncBuiltinESMExports } = require("node:module");
// Full npm metadata can exceed 40 MiB when serialized by a registry proxy.
const NPM_METADATA_MAX_BYTES = 64 * 1024 * 1024;
const NPM_TARBALL_MAX_BYTES = 64 * 1024 * 1024;
// Locked native archives (uws) expand beyond the compressed wire budget.
const NPM_TARBALL_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const NPM_AUDIT_MAX_BYTES = 16 * 1024 * 1024;
const NPM_HTTP_TIMEOUT_MS = 15_000;
// Full npm self-install metadata exceeds 1.24 million aggregate entries.
const NPM_JSON_MAX_ENTRIES = 2_000_000, NPM_JSON_MAX_DEPTH = 128;
const limitError = () => Object.assign(new Error("ELIMIT npm HTTP response byte limit exceeded"), { code: "ELIMIT" });
// npm tarballs are tar streams; the first header block identifies the payload
// npm's archive reader will consume.
const TAR_MAGIC_OFFSET = 257;
const isTarArchive = bytes => bytes.length >= TAR_MAGIC_OFFSET + 5 &&
  bytes.toString("latin1", TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + 5) === "ustar";

const isArchiveResponse = (path, statusCode = 200) => statusCode < 300 && /\/-\/[^/?]+\.(?:tgz|tar\.gz)(?:\?[^#]*)?$/.test(path);
// HEAD, 204 and 304 responses carry no body, so there is nothing to decode or
// admit; npm's fetch passes them through untouched as well. A 205 response is
// framed with a body by Node, so it stays subject to all admission limits.
const isBodylessResponse = (method, statusCode) => method === "HEAD" || statusCode === 204 || statusCode === 304;

/** Returns the HTTP response byte budget for an npm request path. */
function responseBudget(path, statusCode = 200) {
  if (/\/-\/npm\/v1\/security\//.test(path)) return NPM_AUDIT_MAX_BYTES;
  // A package name can end in .tgz; only an unambiguous archive route gets
  // archive expansion budget. Redirects and error replies still need JSON admission.
  return isArchiveResponse(path, statusCode)
    ? NPM_TARBALL_MAX_BYTES : NPM_METADATA_MAX_BYTES;
}

const isJsonShaped = bytes => {
  const first = bytes.find(byte => ![0x20, 0x09, 0x0a, 0x0d].includes(byte));
  return first === 0x7b || first === 0x5b;
};

function validateJsonLists(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch {
    // npm's streaming reader accepts a sequence of concatenated values. A
    // JSON-shaped body that is not one value must fail closed: an appended
    // root could otherwise carry lists and depth past these limits. Non-JSON
    // replies still pass through so npm keeps its malformed-body diagnostics.
    if (isJsonShaped(bytes)) throw limitError();
    return;
  }
  const pending = [[value, 0]];
  let entries = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (!item || typeof item !== "object") continue;
    const children = Object.values(item);
    entries += children.length;
    if (entries > NPM_JSON_MAX_ENTRIES || depth > NPM_JSON_MAX_DEPTH) throw limitError();
    for (const child of children) pending.push([child, depth + 1]);
  }
}

function decodeBounded(bytes, decode, maximum) {
  try { return decode(bytes, { maxOutputLength: maximum }); }
  catch (error) { if (error.code === "ERR_BUFFER_TOO_LARGE") throw limitError(); throw error; }
}

// npm's reader accepts both zlib-wrapped and raw deflate under `deflate`, and
// proxies also emit the x-deflate alias. A wrapped expansion that overflows is
// rejected outright; only a header mismatch falls through to the raw form.
function inflateEither(bytes, options) {
  try { return inflateSync(bytes, options); }
  catch (wrapped) {
    if (wrapped.code === "ERR_BUFFER_TOO_LARGE") throw wrapped;
    try { return inflateRawSync(bytes, options); }
    catch (raw) { throw raw.code === "ERR_BUFFER_TOO_LARGE" ? raw : wrapped; }
  }
}

/** Buffers bounded encoded bytes, then bounded decompression; throws ELIMIT before downstream decoding. */
async function readBoundedResponse(response, maximum, json = true, archiveMaximum = maximum) {
  if (Number(response.headers["content-length"]) > maximum) throw limitError();
  const chunks = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > maximum) throw limitError();
    chunks.push(chunk);
  }
  let bytes = Buffer.concat(chunks, length);
  const encoding = response.headers["content-encoding"]?.toLowerCase();
  const decoders = { gzip: gunzipSync, "x-gzip": gunzipSync, deflate: inflateEither, "x-deflate": inflateEither, br: brotliDecompressSync };
  const decode = Object.hasOwn(decoders, encoding) ? decoders[encoding] : undefined;
  if (encoding && encoding !== "identity" && !decode) throw new Error("unsupported npm HTTP content encoding");
  // An empty reply can still carry a compression header (redirects and global
  // compression middleware); npm accepts it, so do not decode nothing.
  if (decode && bytes.length > 0) bytes = decodeBounded(bytes, decode, maximum);
  if (bytes.length > maximum) throw limitError();
  // Registry tarballs carry their own gzip layer, independent of HTTP encoding.
  // Validate expansion without changing the exact archive bytes npm hashes.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!json) {
      decodeBounded(bytes, gunzipSync, archiveMaximum);
    } else {
      try {
        decodeBounded(bytes, gunzipSync, maximum);
      } catch (error) {
        // A direct suffixless download URL may still serve an archive npm's
        // reader consumes, so the metadata budget admits an over-budget gzip
        // body when its payload is a tar stream. Every other route, including
        // the audit budget, keeps its own decoded ceiling.
        if (error.code !== "ELIMIT" || maximum !== NPM_METADATA_MAX_BYTES) throw error;
        if (!isTarArchive(decodeBounded(bytes, gunzipSync, archiveMaximum))) throw limitError();
      }
    }
  }
  // npm also auto-detects zstd, which has no bounded decoder on supported Node.
  if (bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
    throw new Error("unsupported npm archive compression: zstd");
  }
  if (json || isJsonShaped(bytes)) validateJsonLists(bytes);
  return bytes;
}

/** Installs an opt-in guard for npm's Node HTTP(S) transport, including redirects and error bodies. */
function installBoundedNpmHttp({ transports = [http, https], schedule = setTimeout, cancel = clearTimeout } = {}) {
  // Archive intent follows a redirect to a suffixless download URL. Bounded so
  // an untrusted registry cannot grow the set without limit.
  const archiveRedirects = new Set();
  for (const transport of transports) {
    const request = transport.request;
    transport.request = function (...args) {
      const pending = request.apply(this, args);
      const emit = pending.emit;
      let failed = false;
      const timer = schedule(() => pending.destroy(Object.assign(new Error("ETIMEDOUT npm HTTP deadline"), { code: "ETIMEDOUT" })), NPM_HTTP_TIMEOUT_MS);
      pending.once("error", () => { failed = true; cancel(timer); });
      pending.emit = function (event, response, ...rest) {
        if (event !== "response") return emit.call(this, event, response, ...rest);
        const statusCode = response.statusCode ?? 200;
        // npm follows redirects with a fresh request; remember where an archive
        // route sent it so the target keeps the archive budget. Archive intent
        // also carries through a chain of redirects.
        const archiveRequest = isArchiveResponse(pending.path) || archiveRedirects.has(pending.path);
        if (archiveRequest && statusCode >= 300 && statusCode < 400) {
          const location = response.headers.location;
          if (location) try {
            const target = new URL(location, "http://redirect.invalid" + pending.path);
            archiveRedirects.add(target.pathname + target.search);
            if (archiveRedirects.size > 256) archiveRedirects.delete(archiveRedirects.values().next().value);
          } catch {}
        }
        // Forward bodyless responses unchanged: decoding an empty body (for
        // example a 304 with Content-Encoding: gzip) fails, and rewriting
        // entity headers would corrupt cache revalidation.
        if (isBodylessResponse(pending.method, statusCode)) {
          cancel(timer);
          return emit.call(this, event, response, ...rest);
        }
        const maximum = responseBudget(pending.path, statusCode);
        // Error and redirect replies at a redirect target stay JSON-admitted.
        const archive = statusCode < 300 && archiveRequest;
        // npm's request-error path relays a failure to this original response
        // (req.res) after the response event. Admission hands npm a separate
        // stream, so absorb that relay; otherwise it throws inside the relay
        // handler and replaces the one ELIMIT request rejection.
        response.on("error", () => {});
        // The archive budget must survive a redirect to a suffixless download
        // URL; readBoundedResponse promotes only a genuine tar payload past the
        // path budget, so JSON admission still bounds metadata and error replies.
        readBoundedResponse(response, maximum, !archive, NPM_TARBALL_MAX_UNPACKED_BYTES).then(bytes => {
          cancel(timer);
          if (failed) return;
          const admitted = new PassThrough();
          for (const field of ["statusCode", "statusMessage", "httpVersion", "rawHeaders", "trailers", "socket", "req", "url"]) admitted[field] = response[field];
          admitted.headers = { ...response.headers, "content-length": String(bytes.length) };
          delete admitted.headers["content-encoding"];
          emit.call(pending, "response", admitted);
          admitted.end(bytes);
        }, error => {
          cancel(timer);
          response.destroy();
          pending.destroy();
          if (!failed) emit.call(pending, "error", error);
        });
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
