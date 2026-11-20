// Ed25519 inputs a verifier must refuse: a signature whose S is raised by the group order, public keys of small order or with
// y at or above the field prime, and the signature that verifies every message under the small-order identity key.
export const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

/** The same signature with S + L in place of S: the same scalar, no longer below the group order. */
export function raisedS(signature) {
  const bytes = Buffer.from(signature, 'base64url');
  const s = BigInt(`0x${Buffer.from(bytes.subarray(32)).reverse().toString('hex')}`) + GROUP_ORDER;
  Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse().copy(bytes, 32);
  return bytes.toString('base64url');
}

// Raw little-endian public keys. y = p + 3 is not small order once reduced, so a small-order check alone lets it through to the
// signature verifier.
export const BAD_KEYS = Object.freeze({
  'small-order y = 1': '01' + '00'.repeat(31),
  'small-order y = p - 1': 'ec' + 'ff'.repeat(30) + '7f',
  'y = p': 'ed' + 'ff'.repeat(30) + '7f',
  'y = p + 1': 'ee' + 'ff'.repeat(30) + '7f',
  'y = p + 3': 'f0' + 'ff'.repeat(30) + '7f',
});

/** R is the identity point and S is zero. */
export const IDENTITY_SIGNATURE = Buffer.from('01' + '00'.repeat(63), 'hex').toString('base64url');
