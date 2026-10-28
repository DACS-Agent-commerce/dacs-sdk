// A TEST rail steward and its signed demos-native:DEM RailDefinition (PA-1,
// in-code), for the native seller profile's railAuthority option.
import { generateKeyPairSync, sign } from 'node:crypto';
import * as core from '@kynesyslabs/dacs';

export function railSteward() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const stewardPublicKey = publicKey.export({ format: 'jwk' }).x;
  const stewardClaim = `did:demos:agent:${Buffer.from(stewardPublicKey, 'base64url').toString('hex')}`;
  const signRail = (unsigned) => ({ ...unsigned, signature: { algorithm: 'ed25519', signer: stewardClaim,
    value: sign(null, Buffer.from(`dacs-rail:v1:${core.contentHash(unsigned)}`, 'ascii'), privateKey).toString('base64url') } });
  const unsignedRail = (changes = {}) => ({
    railVersion: 1, railId: 'demos-native:DEM', railType: 'demos-native',
    asset: { kind: 'native-dem', symbol: 'DEM', decimals: 9 }, network: { kind: 'demos' },
    phaseHandler: 'pay-dem', parameters: {}, availability: 'live',
    governance: { proposedBy: stewardClaim, acceptedAt: 1, anchoring: 'in-code' },
    ...changes,
  });
  // `changes` alter the signed definition; `authority` the surrounding config.
  const railAuthority = ({ changes = {}, authority = {} } = {}) => ({ rail: signRail(unsignedRail(changes)), stewardClaim, stewardPublicKey, railRegistryVersion: 1, production: false, ...authority });
  return { stewardClaim, stewardPublicKey, signRail, unsignedRail, railAuthority };
}
