// The seller key's real signing roles (openSellerKey over a key file of the protocol fixture's seller), with the
// cryptographic signatures each role makes counted on node:crypto's sign, the call under every KeyObject signature.
import { cryptoCalls, importSellerKey, keyFixture, openOptions } from './seller-key-fixture.mjs';

// The protocol fixture's seller is the wallet of seed byte 17.
const PROTOCOL_SELLER_SEED = 17;

/**
 * `{ key, effectSigner, integritySigner, readOnlyAnswerSigner, counts, effectBytes }`: `effectSigner` is the key's effect role,
 * `integritySigner` its integrity role and `readOnlyAnswerSigner` its read-only answer role, each counting into
 * `counts.effect`, `counts.integrity` or `counts.readOnly` the cryptographic signatures it made; `effectBytes` holds the bytes
 * of every effect signature made. The key closes after the test.
 */
export async function countedKeyRoles(t) {
  const { openSellerKey } = await importSellerKey();
  const key = await openSellerKey(openOptions(keyFixture(t, { seedByte: PROTOCOL_SELLER_SEED })));
  t.after(() => key.close());
  const counts = { effect: 0, integrity: 0, readOnly: 0 }, effectBytes = [];
  const counted = (role, sign, bytes) => {
    const before = cryptoCalls.signs;
    try { return sign(bytes); } finally { counts[role] += cryptoCalls.signs - before; }
  };
  // The read-only role's signer checks its authority asynchronously before its one synchronous signature.
  const countedAsync = async (role, sign, bytes) => {
    const before = cryptoCalls.signs;
    try { return await sign(bytes); } finally { counts[role] += cryptoCalls.signs - before; }
  };
  const readOnlyAnswerSigner = async (request) => {
    const signer = await key.readOnlyAnswerSigner(request);
    return Object.freeze({ claim: signer.claim, sign: (bytes) => countedAsync('readOnly', signer.sign, bytes) });
  };
  const effectSigner = Object.freeze({ claim: key.claim, sign(bytes) {
    const signature = counted('effect', key.sign, bytes);
    effectBytes.push(Buffer.from(bytes));
    return signature;
  } });
  const integritySigner = Object.freeze({ claim: key.claim, sign: (bytes) => counted('integrity', key.integritySigner.sign, bytes) });
  return { key, effectSigner, integritySigner, readOnlyAnswerSigner, counts, effectBytes };
}
