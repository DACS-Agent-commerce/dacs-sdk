// The message a Demos transaction signature covers is decided only by the node's own
// `getNetworkInfo` answer: the bare transaction hash while the node's signature-domain
// fork is inactive, `demos-tx:v1:<chain id>:<hash>` for a transaction included at or
// after the fork's `activationHeight`. A transaction in an earlier block, or one not
// yet included, is judged by that block number alone. An answer that cannot be read
// gives no domain, and no caller can name one.
const TRANSACTION_HASH = /^[0-9a-f]{64}$/;
const SIGNATURE_DOMAIN_PREFIX = 'demos-tx:v1';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeCount = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
// Only domains read from a node answer verify anything.
const readFromNode = new WeakSet();

function unreadable(message) {
  return Object.assign(new Error(`the node's getNetworkInfo answer ${message}`), { code: 'signature_domain_unreadable' });
}

/**
 * The signature domain a node's `getNetworkInfo` answer selects: a frozen value to
 * give `transactionSignatureMessage`. An answer without a signature-domain fork, or
 * with one that is not active, selects the bare hash. An active fork selects the
 * chain-bound message from its `activationHeight` on, and needs `chainId` and
 * `activationHeight` to be safe nonnegative integers.
 * Throws an error with code `signature_domain_unreadable` for any other answer.
 */
export function signatureDomainFromNetworkInfo(info) {
  if (!object(info) || !object(info.forks) || !object(info.forks.osDenomination) || typeof info.forks.osDenomination.activated !== 'boolean') {
    throw unreadable('is not a readable fork status');
  }
  const fork = info.forks.signatureDomain;
  if (fork !== undefined && (!object(fork) || typeof fork.activated !== 'boolean')) throw unreadable('has a signature-domain fork without an activated flag');
  let chainId = null, activationHeight = null;
  if (fork?.activated === true) {
    if (!safeCount(info.chainId)) throw unreadable('names an active signature-domain fork without a safe nonnegative chain id');
    if (!safeCount(fork.activationHeight)) throw unreadable('names an active signature-domain fork without a safe nonnegative activation height');
    chainId = info.chainId;
    activationHeight = fork.activationHeight;
  }
  const domain = Object.freeze({ chainId, activationHeight });
  readFromNode.add(domain);
  return domain;
}

/**
 * The exact message a signature over transaction `hash` covers under `domain`, or
 * null when `domain` was not read from a node answer, `hash` is not 64 lower-case
 * hex digits, or `blockNumber` is given and is not a safe nonnegative integer.
 * `blockNumber` is the block that includes the transaction: before the fork's
 * activation height the message is the bare hash. Leave it out for a transaction
 * that is not included yet, which will land after the fork's activation.
 */
export function transactionSignatureMessage(domain, hash, blockNumber) {
  if (!readFromNode.has(domain) || typeof hash !== 'string' || !TRANSACTION_HASH.test(hash)) return null;
  if (blockNumber !== undefined && !safeCount(blockNumber)) return null;
  if (domain.chainId === null || (blockNumber !== undefined && blockNumber < domain.activationHeight)) return hash;
  return `${SIGNATURE_DOMAIN_PREFIX}:${domain.chainId}:${hash}`;
}

/** Throws TypeError when `options` names a `signatureChainId`: the node's answer is the only source of the domain. */
export function assertNoCallerSignatureDomain(options) {
  if (options?.signatureChainId !== undefined) throw new TypeError('signatureChainId is not accepted: the signature domain is read from the node\'s getNetworkInfo answer');
}
