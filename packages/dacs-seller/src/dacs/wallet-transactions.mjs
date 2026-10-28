// Run-time port of http-mcp/src/dacs/wallet-transactions.mjs at DACS-Agent-commerce/frontend
// 15fdf23: lines 18, 20-22, 27-31, 69-100.
// Left out: the native-send payload, amount encoding, payload hash and the application
// coordinate store.
import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

export function deriveStorageAddress(owner, programName, nonce, salt = '') {
  return `stor-${sha256Hex(`${owner}:${programName}:${nonce}:${salt}`).slice(0, 40)}`;
}

/** The largest canonical artifact one storage CREATE carries, in UTF-8 bytes. */
export const MAX_STORAGE_ARTIFACT_BYTES = 16_384;
const MAX_STORAGE_JSON_DEPTH = 64;

function assertStorageJsonDepth(value, depth = 1) {
  if (depth > MAX_STORAGE_JSON_DEPTH) throw new TypeError('storage JSON nesting depth exceeds 64 levels');
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) assertStorageJsonDepth(child, depth + 1);
  }
}

const ZERO_FEE = Object.freeze({ network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null });

export function buildStorageProgramCreatePayload({ from, storageAddress, programName, logicalAddress, signedListing, nonce, timestamp, salt = '' }) {
  if (typeof from !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(from) ||
      typeof programName !== 'string' || !programName.trim() || programName.includes(':') ||
      !Number.isSafeInteger(nonce) || nonce < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
      typeof logicalAddress !== 'string' || !logicalAddress.trim() || typeof salt !== 'string' ||
      !signedListing || typeof signedListing !== 'object' || Array.isArray(signedListing) ||
      storageAddress !== deriveStorageAddress(from, programName, nonce, salt)) {
    throw new TypeError('storage CREATE requires a valid owner, program name, nonce, timestamp, logical address, artifact and matching storage address');
  }
  const canonical = canonicalize(signedListing);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_STORAGE_ARTIFACT_BYTES) throw new TypeError('canonical listing exceeds the storage byte limit');
  const snapshot = JSON.parse(canonical);
  assertStorageJsonDepth(snapshot);
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
          data: snapshot,
          metadata: { logicalAddress },
          acl: { mode: 'public' },
          salt,
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
