// Run-time port of http-mcp/src/dacs/fixture-anchors.mjs at DACS-Agent-commerce/frontend
// 15fdf23: lines 13, 15-16, 18-21, 23-80, 134-139.
// Left out: the loopback fixture substrate HTTP client (createFixtureAnchorClient); this package
// ships no fixture substrate.
import { canonicalize, contentHash, sha256Hex, storAddress, isAnchorReceipt } from '@kynesyslabs/dacs';
import { verifyComponent } from './listing.mjs';
import { decodeSignature } from './demos-claims.mjs';

export const FIXTURE_SUBSTRATE = 'dacs-chatgpt-plugin:loopback-sr2-fixture';
export const FIXTURE_FINALITY = 'fixture-immediate-no-chain';
export const FIXTURE_WRITE_PREFIX = 'dacs-chatgpt-plugin/fixture-sr2-write/v1:';

// The exact message a writer's wallet signs to authorize one fixture write.
export function anchorWriteMessage(logicalAddress, hash) {
  return `${FIXTURE_WRITE_PREFIX}${logicalAddress}:${hash}`;
}

export function fixtureWriteHash({ logicalAddress, contentHash: hash, writer, writerSignature }) {
  return sha256Hex(canonicalize({ logicalAddress, contentHash: hash, writer, writerSignature }));
}

// AttestationRef for an artifact at a logical address (locator = logical address).
export function fixtureRef(logicalAddress, hash) {
  return { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: hash };
}

// Canonical base64url of a signature given as base64url (DACS wire form) or
// hex (wallet form, optionally 0x-prefixed). Exact 86-character base64url is
// decoded first: the wallet helper strips a leading "0x", which is also a
// valid base64url prefix, so it would corrupt such a value.
export function canonicalSignature(value) {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value)) {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length === 64 && bytes.toString('base64url') === value) return value;
  }
  return decodeSignature(value).toString('base64url');
}

// Full receipt authentication for the fixture substrate: exact SDK receipt
// shape, fixture profile, finalized/established, the logical and derived
// native address, the artifact's content hash, the expected writer, the
// write hash and the writer's signature. Returns 'valid' | 'invalid'.
export function verifyFixtureReceipt({ receipt, logicalAddress, hash, expectedWriter }) {
  if (!isAnchorReceipt(receipt)) return 'invalid';
  if (receipt.substrate !== FIXTURE_SUBSTRATE || receipt.finalityProfile !== FIXTURE_FINALITY) return 'invalid';
  if (receipt.state !== 'finalized' || receipt.observationDisposition !== 'established') return 'invalid';
  if (receipt.logicalAddress !== logicalAddress || receipt.nativeAddress !== storAddress(logicalAddress)) return 'invalid';
  if (receipt.contentHash !== hash || receipt.writer !== expectedWriter) return 'invalid';
  if (receipt.evidence?.kind !== 'fixture-writer-signature' || receipt.transactionRef?.kind !== 'fixture-sr2-write') return 'invalid';
  if (receipt.transactionRef.value !== fixtureWriteHash({ logicalAddress, contentHash: hash, writer: expectedWriter, writerSignature: receipt.evidence.value })) return 'invalid';
  if (!Number.isSafeInteger(receipt.blockRef?.timestamp)) return 'invalid';
  const ok = verifyComponent({
    signedBytes: Buffer.from(anchorWriteMessage(logicalAddress, hash), 'utf8'),
    signature: { algorithm: 'ed25519', signer: expectedWriter, value: receipt.evidence.value },
  });
  return ok ? 'valid' : 'invalid';
}

// One anchored record read back and authenticated against its own address.
export function verifyFixtureRecord(record, { logicalAddress, expectedWriter }) {
  if (!record || record.status !== 'present') return 'invalid';
  return verifyFixtureReceipt({ receipt: record.receipt, logicalAddress, hash: contentHash(record.artifact), expectedWriter });
}

// The commitment gate's ChainTxRef for a fixture write.
export function fixtureTxRef(receipt) {
  return { kind: 'storage-program', address: receipt.nativeAddress, writeTxHash: receipt.transactionRef.value };
}


// Local signer helper: a writer authorization from raw signing bytes, in the
// wallet's 0x-hex form (unambiguous for every signature decoder here).
export function signAnchorWrite(signBytes, logicalAddress, hash) {
  return `0x${Buffer.from(signBytes(Buffer.from(anchorWriteMessage(logicalAddress, hash), 'utf8'))).toString('hex')}`;
}
