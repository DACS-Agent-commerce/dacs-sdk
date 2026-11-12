// The messages a Demos transaction signature may cover. The verifier builds them
// itself from the transaction hash and its own configured chain id; it never
// reads a message from the signer.
import { verifyDemosSignature } from './demos-claims.mjs';

const TRANSACTION_HASH = /^[0-9a-f]{64}$/;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNATURE_DOMAIN = 'demos-tx:v1';
const isChainId = (value) => typeof value === 'string' && CANONICAL_DECIMAL.test(value);

/**
 * Checks the `signatureChainId` option of a verifier: undefined (no chain-bound
 * signatures are accepted) or a canonical decimal string such as "7".
 * Throws TypeError for anything else.
 */
export function assertSignatureChainId(signatureChainId) {
  if (signatureChainId !== undefined && !isChainId(signatureChainId)) {
    throw new TypeError('signatureChainId must be the node\'s chain id as a decimal string, such as "7", or be left out');
  }
}

/**
 * True only for a valid Ed25519 signature by `address` over the bare transaction
 * `hash` or, when `signatureChainId` is given, over
 * `demos-tx:v1:<signatureChainId>:<hash>`. A hash that is not 64 lower-case hex
 * digits, or a chain id that is not a canonical decimal string, is false.
 * Never throws.
 */
export function verifyTransactionSignature({ address, hash, signature, signatureChainId }) {
  if (typeof hash !== 'string' || !TRANSACTION_HASH.test(hash)) return false;
  if (signatureChainId === undefined) return verifyDemosSignature({ address, message: hash, signature });
  if (!isChainId(signatureChainId)) return false;
  return [hash, `${SIGNATURE_DOMAIN}:${signatureChainId}:${hash}`].some((message) => verifyDemosSignature({ address, message, signature }));
}
