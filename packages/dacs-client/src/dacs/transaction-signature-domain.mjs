// What a Demos transaction signature covers. While the node's signatureDomain
// fork is inactive, the sender signs the UTF-8 transaction hash. Once it is
// active, the sender signs `demos-tx:v1:<chainId>:<hash>`, with the node's
// chain id in decimal. The node reports both in getNetworkInfo.
const SIGNATURE_DOMAIN_TAG = 'demos-tx:v1';

/**
 * Reads the signature domain of the node behind `nodeCall` (the caller's bounded
 * node reader, called as `nodeCall('getNetworkInfo', {})`) and returns what a
 * transaction signature puts before the hash: '' while the fork is inactive,
 * `demos-tx:v1:<chainId>:` once it is active. Returns null when the answer has
 * no boolean `forks.signatureDomain.activated`, or is active without a safe
 * non-negative integer `chainId`. Errors thrown by `nodeCall` propagate unchanged.
 */
export async function readTransactionSignaturePrefix(nodeCall) {
  const info = await nodeCall('getNetworkInfo', {});
  const activated = info?.forks?.signatureDomain?.activated;
  if (activated === false) return '';
  if (activated !== true || !Number.isSafeInteger(info.chainId) || info.chainId < 0) return null;
  return `${SIGNATURE_DOMAIN_TAG}:${info.chainId}:`;
}
