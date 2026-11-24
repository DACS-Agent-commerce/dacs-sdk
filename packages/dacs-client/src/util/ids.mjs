import { randomBytes, createHash } from 'node:crypto';

export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

// newId('pur'): 12 random bytes are 16 base64url characters.
const PURCHASE_OPERATION_ID = /^pur_[A-Za-z0-9_-]{16}$/;
/** isPurchaseOperationId(value) returns true exactly for a purchase id the operations adapter mints. It never throws. */
export function isPurchaseOperationId(value) {
  return typeof value === 'string' && PURCHASE_OPERATION_ID.test(value);
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}
