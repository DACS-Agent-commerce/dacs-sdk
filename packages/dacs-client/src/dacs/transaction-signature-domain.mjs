// What a Demos transaction signature covers. While the node's signatureDomain
// fork is inactive, or the node does not report it, the sender signs the UTF-8
// transaction hash. Once it is active, the sender signs
// `demos-tx:v1:<chainId>:<hash>`, with the node's chain id in decimal. The node
// reports both in getNetworkInfo.
const SIGNATURE_DOMAIN_TAG = 'demos-tx:v1';
const height = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Reads the signature domain of the node behind `nodeCall` (the caller's bounded
 * node reader, called as `nodeCall('getNetworkInfo', {})`) and returns what the
 * signature of a transaction included at block `inclusionHeight` puts before
 * the hash: '' for the bare hash, `demos-tx:v1:<chainId>:` for the domain form.
 *
 * The answer counts only when `forks.osDenomination.activated` is a boolean, as
 * for the Demos SDK that signs. With no `forks.signatureDomain`, or with the
 * fork not active, the form is the bare hash. With the fork active, a
 * transaction included below its `activationHeight` is in the bare hash, and one
 * included at or above it is in the domain form.
 *
 * Returns null for any other answer: no usable `forks.osDenomination`, a
 * `signatureDomain` without a boolean `activated`, or an active fork without a
 * safe non-negative integer `chainId` and `activationHeight`. Also null when
 * the fork is active and `inclusionHeight` is not a safe non-negative integer.
 * Errors thrown by `nodeCall` propagate unchanged.
 */
export async function readTransactionSignaturePrefix(nodeCall, inclusionHeight) {
  const info = await nodeCall('getNetworkInfo', {});
  if (typeof info?.forks?.osDenomination?.activated !== 'boolean') return null;
  const fork = info.forks.signatureDomain;
  if (fork === undefined) return '';
  if (typeof fork?.activated !== 'boolean') return null;
  if (!fork.activated) return '';
  if (!height(info.chainId) || !height(fork.activationHeight) || !height(inclusionHeight)) return null;
  return inclusionHeight < fork.activationHeight ? '' : `${SIGNATURE_DOMAIN_TAG}:${info.chainId}:`;
}
