// Checks one entry of a node `getStorageProof` answer against a storage root: whether the root commits the entry's
// record at its storage address, or commits nothing there. The tree is the node's compressed sparse Merkle tree:
// key = SHA-256(UTF-8 address), bits most significant first; siblings run from the root down and fold in reverse;
// empty subtree = 32 zero bytes; leaf = SHA-256(0x02 || key || valueHash); inner = SHA-256(0x01 || left || right);
// a record's valueHash = SHA-256(0x00 || UTF-8 canonical JSON of the record).
// The root must already be authenticated by the caller. `absent` covers this one address only: a marker can sit at
// another nonce's address, so it never proves that a Listing is not revoked.
import { createHash } from 'node:crypto';
import { nodeCanonicalJson } from './revocation-proof-encoding.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_SIBLINGS = 256;
const VALUE_TAG = Buffer.of(0x00);
const INNER_TAG = Buffer.of(0x01);
const LEAF_TAG = Buffer.of(0x02);
const EMPTY_SUBTREE = Buffer.alloc(32);
const INVALID = Object.freeze({ status: 'invalid' });
const ABSENT = Object.freeze({ status: 'absent' });

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const isHex64 = (value) => typeof value === 'string' && HEX64.test(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isPlainObject = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const bitAt = (bytes, index) => (bytes[index >> 3] >> (7 - (index & 7))) & 1;
const leafHash = (key, valueHash) => sha256(LEAF_TAG, key, valueHash);

/** The record's value hash, or null when the record has no canonical JSON form. */
function recordValueHash(record) {
  try {
    return sha256(VALUE_TAG, Buffer.from(nodeCanonicalJson(record), 'utf8'));
  } catch {
    return null;
  }
}

/** The siblings as 32-byte buffers, or null when the list is not at most 256 lower-case 64-hex strings. */
function parseSiblings(siblings) {
  if (!Array.isArray(siblings) || siblings.length > MAX_SIBLINGS || !siblings.every(isHex64)) return null;
  return siblings.map((sibling) => Buffer.from(sibling, 'hex'));
}

/** `{kind:'empty'}`, a leaf with its key and value hash as buffers, or null for any other terminal. */
function parseTerminal(terminal) {
  if (!isPlainObject(terminal)) return null;
  if (terminal.kind === 'empty') return { kind: 'empty' };
  if (terminal.kind !== 'leaf' || !isHex64(terminal.key) || !isHex64(terminal.valueHash)) return null;
  return { kind: 'leaf', key: Buffer.from(terminal.key, 'hex'), valueHash: Buffer.from(terminal.valueHash, 'hex') };
}

function foldRoot(key, terminalHash, siblings) {
  let hash = terminalHash;
  for (let depth = siblings.length - 1; depth >= 0; depth -= 1) {
    hash = bitAt(key, depth) ? sha256(INNER_TAG, siblings[depth], hash) : sha256(INNER_TAG, hash, siblings[depth]);
  }
  return hash;
}

/** Whether two keys agree on every path bit above `depth`. */
function sharesPath(a, b, depth) {
  for (let index = 0; index < depth; index += 1) if (bitAt(a, index) !== bitAt(b, index)) return false;
  return true;
}

function provePresent({ key, record, valueHash, siblings, terminal, root }) {
  if (terminal.kind !== 'leaf' || !terminal.key.equals(key) || !terminal.valueHash.equals(valueHash)) return INVALID;
  return foldRoot(key, leafHash(key, valueHash), siblings).equals(root) ? Object.freeze({ status: 'present', record }) : INVALID;
}

function proveAbsent({ key, siblings, terminal, root }) {
  let terminalHash = EMPTY_SUBTREE;
  if (terminal.kind === 'leaf') {
    if (terminal.key.equals(key) || !sharesPath(terminal.key, key, siblings.length)) return INVALID;
    terminalHash = leafHash(terminal.key, terminal.valueHash);
  }
  return foldRoot(key, terminalHash, siblings).equals(root) ? ABSENT : INVALID;
}

/**
 * Checks one node `StorageProofEntry` `{storageAddress, record, siblings, terminal}` against an authenticated
 * `storageRoot` (lower-case 64-hex). `expectedAddress` must equal the entry's `storageAddress` exactly. Reads only
 * those members and never throws.
 * @returns {{status: 'present', record: object} | {status: 'absent'} | {status: 'invalid'}} `present` carries the
 * entry's own record object, whose `storageAddress` equals the entry's; `absent` means no record at this one address;
 * `invalid` is every malformed, mismatched or uncommitted input.
 */
export function verifyRevocationStorage(entry, options) {
  if (!isPlainObject(entry) || !isPlainObject(options)) return INVALID;
  const { storageAddress, record } = entry;
  if (!isNonEmptyString(storageAddress) || storageAddress !== options.expectedAddress) return INVALID;
  if (!isHex64(options.storageRoot)) return INVALID;
  const siblings = parseSiblings(entry.siblings);
  const terminal = parseTerminal(entry.terminal);
  if (!siblings || !terminal) return INVALID;
  const key = sha256(Buffer.from(storageAddress, 'utf8'));
  const root = Buffer.from(options.storageRoot, 'hex');
  if (record === null) return proveAbsent({ key, siblings, terminal, root });
  const valueHash = isPlainObject(record) ? recordValueHash(record) : null;
  if (!valueHash || record.storageAddress !== storageAddress) return INVALID;
  return provePresent({ key, record, valueHash, siblings, terminal, root });
}
