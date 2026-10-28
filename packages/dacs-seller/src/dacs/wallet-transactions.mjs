// Run-time port of http-mcp/src/dacs/wallet-transactions.mjs at DACS-Agent-commerce/frontend
// 15fdf23: lines 18, 20-22, 27-31, 69-100.
// Left out: the native-send payload, amount encoding, payload hash and the application
// coordinate store.
import { createHash } from 'node:crypto';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

export function deriveStorageAddress(owner, programName, nonce, salt = '') {
  return `stor-${sha256Hex(`${owner}:${programName}:${nonce}:${salt}`).slice(0, 40)}`;
}

const ZERO_FEE = Object.freeze({ network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null });

export function buildStorageProgramCreatePayload({ from, storageAddress, programName, logicalAddress, signedListing, nonce, timestamp }) {
  return {
    content: {
      type: 'storageProgram',
      from,
      to: storageAddress,
      amount: 0,
      data: [
        'storageProgram',
        {
          operation: 'CREATE_STORAGE_PROGRAM',
          storageAddress,
          programName,
          encoding: 'json',
          data: signedListing,
          metadata: { logicalAddress },
          acl: { mode: 'public' },
          salt: '',
          storageLocation: 'onchain',
        },
      ],
      nonce,
      timestamp,
      transaction_fee: { ...ZERO_FEE },
    },
    signature: null,
    hash: '',
    status: '',
    blockNumber: null,
  };
}
