// Checks a Demos transaction signature against the one message the node's signature
// domain allows (signature-domain.mjs). The verifier builds the message itself from
// the transaction hash; it never reads a message from the signer.
import { verifyDemosSignature } from './demos-claims.mjs';
import { transactionSignatureMessage } from './signature-domain.mjs';

/**
 * True only for a valid Ed25519 signature by `address` over the message `domain`
 * (read from the node by `signatureDomainFromNetworkInfo`) gives for the
 * transaction `hash` included in block `blockNumber` (omitted: not included yet).
 * A domain not read from a node answer, or a hash that is not 64 lower-case hex
 * digits, is false. Never throws.
 */
export function verifyTransactionSignature({ address, hash, signature, domain, blockNumber }) {
  const message = transactionSignatureMessage(domain, hash, blockNumber);
  return message !== null && verifyDemosSignature({ address, message, signature });
}
