// Module-loader hooks that silence demosdk's own diagnostic output while the Node wallet session
// signs. node-demos-loading.mjs registers them once per process; nothing else should.
//
// For exactly the target files it names (demosdk's GCRGeneration.js and demosclass.js) the load
// hook looks the source's SHA-256 up in the reviewed table below, checks that each listed line is
// the recorded statement, replaces it with `;` on the same line (so line numbers stay), and checks
// the SHA-256 of the output. Any other source shape throws `node_wallet_sdk_unreviewed`. Every
// other URL passes through untouched. Nothing here assigns `console`, `process.stdout` or
// `process.stderr`.
//
// Reviewed statements, by line, at demosdk 4.0.16:
// GCRGeneration.js lines 173, 246, 249, 250; demosclass.js lines 719, 1547.
// At demosdk 4.0.18: GCRGeneration.js lines 178, 302, 305, 306; demosclass.js lines 738, 1775, 1781.
import { createHash } from 'node:crypto';

const UNREVIEWED = 'node_wallet_sdk_unreviewed';

const GAS_EDIT_ERROR = 'console.log("[generate] Error creating gas edit: " + e);';
const NATIVE_OPERATION_TYPE = 'console.log("handleNativeOperations: ", tx.content.type);';
const NATIVE_PAYLOAD = 'console.log("nativePayload: ", nativePayload);';
const NATIVE_OPERATION = 'console.log("nativeOperation: ", nativePayload.nativeOperation);';
const FEE_FALLBACK = 'console.warn("[demos] fee derivation skipped:", e);';
const FORK_READ_REFRESH_FAILED = 'console.warn("getNetworkInfo refresh failed — using the last fork status this node reported until a refresh succeeds.");';
const FORK_READ_UNAVAILABLE = 'console.warn("getNetworkInfo unavailable on target node — assuming pre-fork wire format. Upgrade the node to a post-fork-aware version (>= the version that ships with forkHandlers). This fallback path is deprecated and will be removed in v4.");';

/** File name -> reviewed source versions: the source digest, the digest of its transformed output, and the diagnostic statements to empty. */
const REVIEWED_SOURCES = Object.freeze({
  'GCRGeneration.js': [{
    sourceSha256: '324ccba194f2c3274456b7cd02c08636621c4acf95be8a54826c6dd44596250b',
    outputSha256: '0879773315b927a1e908d88f1493cd6e84f67674fd77141038a614d9b15af2e2',
    statements: [{ line: 173, text: GAS_EDIT_ERROR }, { line: 246, text: NATIVE_OPERATION_TYPE }, { line: 249, text: NATIVE_PAYLOAD }, { line: 250, text: NATIVE_OPERATION }],
  }, {
    sourceSha256: '338fd4b44e0823e6c321e35f7dd794447982f631e2c31113a437513f8fcecb44',
    outputSha256: 'a3c3e7845241b6e4109e00de4353248da6814cbbcf91dc0bba329df709f3be06',
    statements: [{ line: 178, text: GAS_EDIT_ERROR }, { line: 302, text: NATIVE_OPERATION_TYPE }, { line: 305, text: NATIVE_PAYLOAD }, { line: 306, text: NATIVE_OPERATION }],
  }],
  'demosclass.js': [{
    sourceSha256: '6b80162f0e15f1e5e85bc4e2831401d47951afbac4d444d4095b0a889369e6c3',
    outputSha256: '085ee6907645912e39bf2dd593c21a055ff6af3220ee273dba4c5e0c17d57ee8',
    statements: [{ line: 719, text: FEE_FALLBACK }, { line: 1547, text: FORK_READ_UNAVAILABLE }],
  }, {
    sourceSha256: 'ebc5dd85fe8f73f2c7ecede5e24343ed322eb319ae6f3744d971674a5b94adaa',
    outputSha256: '354b639026f63a7680ac07235d29d422ae90eaa1d763e842ae099604156208d7',
    statements: [{ line: 738, text: FEE_FALLBACK }, { line: 1775, text: FORK_READ_REFRESH_FAILED }, { line: 1781, text: FORK_READ_UNAVAILABLE }],
  }],
});

let targetUrls = new Set();
let reviewedSources = REVIEWED_SOURCES;
let transformedUrls = new Set();

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unreviewed = (url, reason) => Object.assign(new Error(`${url}: ${reason}`), { code: UNREVIEWED });

/**
 * Receives the registration data: `port` (answers any message with the target URLs transformed
 * so far), `targets` (the file URLs to transform) and `reviewed` (a replacement table, used only
 * by tests; registration passes none).
 */
export function initialize({ port, targets, reviewed = REVIEWED_SOURCES }) {
  targetUrls = new Set(targets);
  reviewedSources = reviewed;
  transformedUrls = new Set();
  port.on('message', () => port.postMessage([...transformedUrls]));
}

function transformReviewedSource(url, bytes) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  const sourceSha256 = sha256(bytes);
  const entry = (Object.hasOwn(reviewedSources, name) ? reviewedSources[name] : []).find(candidate => candidate.sourceSha256 === sourceSha256);
  if (!entry) throw unreviewed(url, `source ${sourceSha256} is not a reviewed version`);
  const lines = bytes.toString('utf8').split('\n');
  for (const { line, text } of entry.statements) {
    if (lines[line - 1]?.trim() !== text) throw unreviewed(url, `line ${line} is not its reviewed statement`);
    lines[line - 1] = ';';
  }
  const output = lines.join('\n');
  if (sha256(Buffer.from(output)) !== entry.outputSha256) throw unreviewed(url, 'the transformed output is not the reviewed output');
  return output;
}

/** The module `load` hook: returns `nextLoad`'s result, with the diagnostic statements emptied when `url` is a target. Throws an error with code `node_wallet_sdk_unreviewed` for a target that is not a reviewed source. */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!targetUrls.has(url)) return result;
  if (result.source == null) throw unreviewed(url, 'no source to review');
  const source = transformReviewedSource(url, Buffer.from(result.source));
  transformedUrls.add(url);
  return { ...result, source };
}
