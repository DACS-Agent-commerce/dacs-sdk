// The message a Demos transaction signature covers is decided only by the node's own
// `getNetworkInfo` answer: the bare transaction hash while the node's signature-domain
// fork is inactive, `demos-tx:v1:<chain id>:<hash>` once it is active. An answer that
// cannot be read gives no domain, and no caller can name one.
const TRANSACTION_HASH = /^[0-9a-f]{64}$/;
const SIGNATURE_DOMAIN_PREFIX = 'demos-tx:v1';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Only domains read from a node answer verify anything.
const readFromNode = new WeakSet();

function unreadable(message) {
  return Object.assign(new Error(`the node's getNetworkInfo answer ${message}`), { code: 'signature_domain_unreadable' });
}

/**
 * The signature domain a node's `getNetworkInfo` answer selects: a frozen value to
 * give `transactionSignatureMessage`. An answer without a signature-domain fork, or
 * with one that is not active, selects the bare hash. An active fork selects the
 * chain-bound message and needs `chainId` to be a safe nonnegative integer.
 * Throws an error with code `signature_domain_unreadable` for any other answer.
 */
export function signatureDomainFromNetworkInfo(info) {
  if (!object(info) || !object(info.forks) || !object(info.forks.osDenomination) || typeof info.forks.osDenomination.activated !== 'boolean') {
    throw unreadable('is not a readable fork status');
  }
  const fork = info.forks.signatureDomain;
  if (fork !== undefined && (!object(fork) || typeof fork.activated !== 'boolean')) throw unreadable('has a signature-domain fork without an activated flag');
  let chainId = null;
  if (fork?.activated === true) {
    if (typeof info.chainId !== 'number' || !Number.isSafeInteger(info.chainId) || info.chainId < 0) throw unreadable('names an active signature-domain fork without a safe nonnegative chain id');
    chainId = info.chainId;
  }
  const domain = Object.freeze({ chainId });
  readFromNode.add(domain);
  return domain;
}

/**
 * The exact message a signature over transaction `hash` covers under `domain`, or
 * null when `domain` was not read from a node answer or `hash` is not 64 lower-case
 * hex digits.
 */
export function transactionSignatureMessage(domain, hash) {
  if (!readFromNode.has(domain) || typeof hash !== 'string' || !TRANSACTION_HASH.test(hash)) return null;
  return domain.chainId === null ? hash : `${SIGNATURE_DOMAIN_PREFIX}:${domain.chainId}:${hash}`;
}

/** Throws TypeError when `options` names a `signatureChainId`: the node's answer is the only source of the domain. */
export function assertNoCallerSignatureDomain(options) {
  if (options?.signatureChainId !== undefined) throw new TypeError('signatureChainId is not accepted: the signature domain is read from the node\'s getNetworkInfo answer');
}
