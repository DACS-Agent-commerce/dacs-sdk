// What compensation may conclude about the two Vet sink addresses of a context start. Each address is read from the signer
// and wallet journals, the dispatch history of every signed CREATE it names, the chain's execution and, where the sink has
// one, its retirement proof. Absence is never proof: an unread, incomplete or malformed answer leaves the address undetermined.
import { boundedCall, isBoundedCallTimeout } from './bounded-call.mjs';
import { evidenceProof, storedCause } from './seller-admission-transaction.mjs';

const READ_BOUNDS = Object.freeze({ timeoutMs: 10000, maxBytes: 1048576, maxItems: 256 });
const UNDETERMINED_CODE = 'context_compensation_undetermined';
const HASH = /^[0-9a-f]{64}$/;
// The states the effect boundary writes to a lane: `signed`, `signed-held`, `observed`, and each stage's started, withheld, unknown and acknowledged.
const STAGE_STATE = /^(dispatch|confirm|broadcast)-(started|withheld|unknown|acknowledged)$/;
const OTHER_STATES = new Set(['signed', 'signed-held', 'observed']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const undetermined = (message) => Object.assign(new Error(message), { code: UNDETERMINED_CODE, status: 503 });
const isIntent = (value) => isRecord(value) && typeof value.lane === 'string' && value.lane.length > 0 && HASH.test(value.artifactHash) && typeof value.signed === 'boolean';

// A returned reply larger than the byte limit, or one that cannot be measured, proves nothing. This runs after the source has
// returned, so it does not limit how much the source reads; a source limits its own read from the `maxBytes` it is given.
function assertWithinBytes(reply) {
  const text = JSON.stringify(reply);
  if (text !== undefined && Buffer.byteLength(text) > READ_BOUNDS.maxBytes) throw undetermined(`a source returned a reply of more than ${READ_BOUNDS.maxBytes} bytes`);
  return reply;
}

// One source read under its deadline; the signal is aborted when the deadline passes. The reply it returns must be within the byte limit.
async function readWithin(read) {
  const controller = new AbortController();
  const bounds = Object.freeze({ ...READ_BOUNDS, signal: controller.signal });
  try { return assertWithinBytes(await boundedCall(() => read(bounds), { timeoutMs: READ_BOUNDS.timeoutMs })); } catch (error) {
    if (isBoundedCallTimeout(error)) controller.abort();
    throw error;
  }
}

function retainedIntents(snapshot, journal) {
  if (snapshot?.complete !== true || !Array.isArray(snapshot.intents) || snapshot.intents.length > READ_BOUNDS.maxItems || !snapshot.intents.every(isIntent)) {
    throw undetermined(`the ${journal} journal answered an incomplete or malformed read`);
  }
  return snapshot.intents;
}

// The intents of both journals by exact signed bytes; one journal saying the bytes were signed is enough.
function mergeIntents(...lists) {
  const merged = new Map();
  for (const { lane, artifactHash, signed } of lists.flat()) {
    const key = `${lane}\n${artifactHash}`;
    merged.set(key, { lane, artifactHash, signed: signed || merged.get(key)?.signed === true });
  }
  return [...merged.values()];
}

async function isExecuted(address, sources) {
  const execution = await readWithin((bounds) => sources.executed(address, bounds));
  if (execution === null) return false;
  if (!isRecord(execution) || execution.address !== address || execution.finalized !== true || execution.verified !== true) throw undetermined('the chain readback is not a finalized, verified execution');
  return true;
}

// A lane record the effect boundary could have written; one that is not cannot be read as saying anything about a dispatch.
const isHistoryRecord = (record) => {
  if (!isRecord(record) || !Number.isSafeInteger(record.seq) || !HASH.test(record.artifactHash) || typeof record.state !== 'string') return false;
  if (!OTHER_STATES.has(record.state) && !STAGE_STATE.test(record.state)) return false;
  return !record.state.endsWith('-withheld') || Number.isSafeInteger(record.of);
};

// Whether the exact signed bytes may have reached the transport, from the whole history of their lane. A started record may have, unless a
// withheld record of its stage names it (the effect boundary writes started first, and withheld after the started record's checks refuse);
// an unknown, acknowledged or observed record may have whatever else the lane holds. A malformed or unknown record is undetermined.
async function mayHaveReachedTransport({ lane, artifactHash }, sources) {
  const history = await readWithin((bounds) => sources.history(lane, artifactHash, bounds));
  if (history?.complete !== true || !Array.isArray(history.records) || history.records.length > READ_BOUNDS.maxItems) throw undetermined('the dispatch history is incomplete or too long to read whole');
  if (!history.records.every(isHistoryRecord)) throw undetermined('the dispatch history holds a malformed or unknown record');
  const records = history.records.filter((record) => record.artifactHash === artifactHash);
  if (!records.some((record) => record.state === 'signed')) throw undetermined('the dispatch history holds no record of these signed bytes');
  const startedAt = new Set(records.filter((record) => record.state.endsWith('-started')).map((record) => `${record.state.replace('-started', '')}\n${record.seq}`));
  const withheld = new Set(records.filter((record) => record.state.endsWith('-withheld')).map((record) => `${record.state.replace('-withheld', '')}\n${record.of}`));
  if (![...withheld].every((key) => startedAt.has(key))) throw undetermined('a withheld record names no started record of its stage');
  return records.some((record) => {
    if (record.state === 'observed') return true;
    const [, stage, step] = STAGE_STATE.exec(record.state) ?? [];
    if (step === 'started') return !withheld.has(`${stage}\n${record.seq}`);
    return step === 'unknown' || step === 'acknowledged';
  });
}

// A sink's own proof that every dispatched artifact was retired. Only a sink with such a proof supplies the reader.
async function isRetired(address, artifactHashes, sources) {
  if (typeof sources.retirement !== 'function') return false;
  const retirement = await readWithin((bounds) => sources.retirement(address, bounds));
  if (retirement === null) return false;
  if (!isRecord(retirement) || retirement.address !== address || retirement.retired !== true || !Array.isArray(retirement.artifactHashes)) throw undetermined('the retirement proof is malformed');
  return artifactHashes.every((hash) => retirement.artifactHashes.includes(hash));
}

async function kindOf(address, sources) {
  const [anchor, wallet] = await Promise.all([readWithin((bounds) => sources.anchor(address, bounds)), readWithin((bounds) => sources.wallet(address, bounds))]);
  const intents = mergeIntents(retainedIntents(anchor, 'anchor'), retainedIntents(wallet, 'wallet'));
  if (intents.length === 0) return 'no-intent';
  const signed = intents.filter((intent) => intent.signed);
  if (signed.length === 0) return 'proven-unsigned';
  if (await isExecuted(address, sources)) return 'executed';
  const dispatched = [];
  for (const intent of signed) if (await mayHaveReachedTransport(intent, sources)) dispatched.push(intent.artifactHash);
  if (dispatched.length === 0) return 'never-dispatched';
  if (await isRetired(address, dispatched, sources)) return 'retired';
  throw undetermined('a signed CREATE may have been dispatched and nothing proves it was retired or not executed');
}

/**
 * Classifies one sink address from `sources`: `no-intent`, `proven-unsigned`, `never-dispatched`, `retired`, `executed` or `undetermined`.
 * Every read runs fresh under a 10,000 ms deadline, and a returned reply of more than 1 MiB or 256 items is not accepted. Each source is
 * given those limits to apply while it reads; the proof itself checks only the deadline and the reply it gets back. Resolves `{ address, kind, cause? }`; a read that throws, times out or
 * answers an incomplete or malformed result is `undetermined` with its stored cause. Never rejects.
 */
export async function classifyAddress(address, sources) {
  try { return Object.freeze({ address, kind: await kindOf(address, sources) }); } catch (error) {
    return Object.freeze({ address, kind: 'undetermined', cause: storedCause(error) });
  }
}

/**
 * The proof the two exact sink addresses give: `no-effect`, `effects-definite` (an execution, every other address clear) or `undetermined`.
 * Anything but two distinct non-empty strings is undetermined and reads nothing. Resolves `{ kind, evidence, cause }`, `cause` being null
 * unless `kind` is `undetermined`.
 */
export async function compensationProof(addresses, sources) {
  const exact = Array.isArray(addresses) && addresses.length === 2 && addresses.every((address) => typeof address === 'string' && address.length > 0) && addresses[0] !== addresses[1];
  if (!exact) return Object.freeze({ kind: 'undetermined', evidence: Object.freeze([]), cause: storedCause(undetermined('compensation needs the two distinct sink addresses')) });
  const evidence = Object.freeze(await Promise.all(addresses.map((address) => classifyAddress(address, sources))));
  const kind = evidenceProof(evidence.map((entry) => entry.kind)) ?? 'undetermined';
  const cause = kind === 'undetermined' ? evidence.find((entry) => entry.cause !== undefined).cause : null;
  return Object.freeze({ kind, evidence, cause });
}

/**
 * The `effectEvidence(privateRow)` port of the admission transaction over `sources`: one classification for each of the row's two retained
 * sink addresses, read fresh on every call. Rejects with `context_compensation_undetermined` 503 when the row does not carry two distinct
 * addresses.
 */
export function createContextEffectEvidence(sources) {
  return async (privateRow) => {
    const { buyer, seller } = privateRow?.vetAddresses ?? {};
    if (typeof buyer !== 'string' || typeof seller !== 'string' || buyer.length === 0 || seller.length === 0 || buyer === seller) throw undetermined('the row does not retain two distinct sink addresses');
    return Promise.all([buyer, seller].map((address) => classifyAddress(address, sources)));
  };
}
