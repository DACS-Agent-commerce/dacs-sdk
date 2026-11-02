import * as core from '@kynesyslabs/dacs';
import { buyer, NOW } from './protocol-fixture.mjs';
import { buildStorageProgramCreatePayload, deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';

// The buyer-signed storage CREATE that anchors `agreement`, as an early
// commitment request carries it.
export function agreementCreateProjection(agreement) {
  const logicalAddress = core.fixedPriceAgreementLogicalAddress(agreement.jobId), programName = core.logicalToStorageProgramName(logicalAddress);
  const storageAddress = deriveStorageAddress(buyer.address, programName, 1, '');
  const tx = buildStorageProgramCreatePayload({ from: buyer.address, storageAddress, programName, logicalAddress, signedListing: agreement, nonce: 1, timestamp: NOW });
  tx.content.from_ed25519_address = buyer.address;
  Object.assign(tx.content.data[1].metadata, { artifactKind: 'Agreement', contentHash: core.contentHash(agreement), envelopeHash: core.sha256Hex(core.canonicalize(agreement)) });
  tx.hash = core.sha256Hex(JSON.stringify(tx.content));
  tx.signature = { type: 'ed25519', data: '0x' + buyer.signBytes(Buffer.from(tx.hash)).toString('hex') };
  return tx;
}
