// The seller key's real signing roles (openSellerKey over a key file of the protocol fixture's seller), with the
// cryptographic signatures each role makes counted on node:crypto's sign, the call under every KeyObject signature.
import { cryptoCalls, importSellerKey, keyFixture, openOptions } from './seller-key-fixture.mjs';

// The protocol fixture's seller is the wallet of seed byte 17.
const PROTOCOL_SELLER_SEED = 17;

/**
 * `{ key, effectSigner, integritySigner, counts, effectBytes }`: `effectSigner` is the key's effect role and
 * `integritySigner` its integrity role, each counting into `counts.effect` or `counts.integrity` the cryptographic
 * signatures it made; `effectBytes` holds the bytes of every effect signature made. The key closes after the test.
 */
export async function countedKeyRoles(t) {
  const { openSellerKey } = await importSellerKey();
  const key = await openSellerKey(openOptions(keyFixture(t, { seedByte: PROTOCOL_SELLER_SEED })));
  t.after(() => key.close());
  const counts = { effect: 0, integrity: 0 }, effectBytes = [];
  const counted = (role, sign, bytes) => {
    const before = cryptoCalls.signs;
    try { return sign(bytes); } finally { counts[role] += cryptoCalls.signs - before; }
  };
  const effectSigner = Object.freeze({ claim: key.claim, sign(bytes) {
    const signature = counted('effect', key.sign, bytes);
    effectBytes.push(Buffer.from(bytes));
    return signature;
  } });
  const integritySigner = Object.freeze({ claim: key.claim, sign: (bytes) => counted('integrity', key.integritySigner.sign, bytes) });
  return { key, effectSigner, integritySigner, counts, effectBytes };
}
