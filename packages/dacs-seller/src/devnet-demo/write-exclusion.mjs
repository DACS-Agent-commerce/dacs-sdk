// Whether the node can no longer include a seller storage CREATE it confirmed.
// The node confirms a CREATE against a reference block R and includes it in
// block R+1 or R+2 or never. The transport keeps the R of the latest validated
// confirmation of the exact signed bytes (a recovery that reconfirms the same
// bytes replaces it) and hands it back on each pending readback. That R is the
// only one used: never a height the seller observed itself. A write whose R is
// missing or malformed is never proven excluded.
import { boundedResolutionValue, resolveWithDeadline } from '../util/bounded-resolution.mjs';

// Each node reply has a byte cap the source applies before decoding, a deadline,
// and decoded JSON budgets enforced here. A block lists at most this many hashes.
const BLOCK_READ_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, timeoutMs: 10_000, maxValues: 65_536, maxDepth: 16, maxListEntries: 16_384 });
const STATUS_READ_LIMITS = Object.freeze({ maxBytes: 4096, timeoutMs: 10_000, maxValues: 64, maxDepth: 8, maxListEntries: 16 });

async function nodeRead(readRpc, message, data, limits) {
  const answer = boundedResolutionValue(await resolveWithDeadline((bounds) => readRpc('/', { method: 'nodeCall', params: [{ message, data }] }, bounds), limits), limits);
  return answer?.result === 200 ? answer.response : null;
}

// The hashes a confirmed block lists, or null when the node has no confirmed block at that number.
async function confirmedBlockHashes(readRpc, number) {
  const block = await nodeRead(readRpc, 'getBlockByNumber', { blockNumber: number }, BLOCK_READ_LIMITS);
  const listed = block?.content?.ordered_transactions;
  return block?.number === number && block.status === 'confirmed' && Array.isArray(listed) && listed.every((hash) => typeof hash === 'string') ? listed : null;
}

const forgotten = (status) => status !== null && typeof status === 'object' && status.state === 'unknown' && Object.keys(status).length === 1;

/**
 * Creates the exclusion rule for one signed storage CREATE: its `hash` and signed `nonce`. `readRpc` is the source's
 * bounded node read; `readAccountNonce` answers the seller's `{nonce, blockHeight}` or throws.
 *
 * Returns a check that takes a pending readback and answers why the node can no longer include the write, or null
 * while that is not proven. Exclusion needs all of: the readback names this hash and carries a safe reference block R;
 * the node has confirmed block R+2; neither block R+1 nor block R+2 lists the hash; the account nonce has not reached
 * the write's nonce; and a last status read, made after every other read, answers exactly `{state:'unknown'}`. A block
 * listing the hash, a used nonce or a status of `included` or `failed` is remembered, and the check never answers
 * exclusion again. A read that fails, times out, is oversized or malformed proves nothing (null); the check never throws.
 */
export function createWriteExclusionRule({ hash, nonce, readRpc, readAccountNonce }) {
  let mayBeIncluded = false;
  return async (readback) => {
    const reference = readback?.hash === hash ? readback.referenceBlock : null;
    if (mayBeIncluded || !Number.isSafeInteger(nonce) || !Number.isSafeInteger(reference) || reference < 0 || reference > Number.MAX_SAFE_INTEGER - 2) return null;
    try {
      const last = await confirmedBlockHashes(readRpc, reference + 2);
      if (last === null) return null;
      const next = await confirmedBlockHashes(readRpc, reference + 1);
      if (next === null) return null;
      if (next.includes(hash) || last.includes(hash)) { mayBeIncluded = true; return null; }
      const account = await readAccountNonce();
      if (account.nonce >= nonce) { mayBeIncluded = true; return null; }
      if (account.blockHeight !== null && account.blockHeight < reference + 2) return null;
      const status = await nodeRead(readRpc, 'getTransactionStatus', { hash }, STATUS_READ_LIMITS);
      if (status?.state === 'included' || status?.state === 'failed') { mayBeIncluded = true; return null; }
      if (!forgotten(status)) return null;
      return `the node can no longer include it: blocks ${reference + 1} and ${reference + 2} do not list it, the account nonce ${account.nonce} has not reached its nonce ${nonce} and the node no longer knows it`;
    } catch {
      return null;
    }
  };
}
