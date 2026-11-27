// The pins a node wallet takes from the SDK-approved TP-1 record, and the checks that run before anything is built from them.
import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { assertTp1Binding, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { OperationError } from '../client-errors.mjs';
import { admitPublicFactory, notAdmittedError } from '../public-admission.mjs';
import { settleOnAbort } from '../util/http.mjs';
import { withinAuthorityDeadline } from './node-observer.mjs';
import { DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE, DEVNET_NODE2_BLOCK_LAYOUT, TP1_REVIEWED_BLOCK_TWO_HASH } from './devnet-native-transport.mjs';

export const NODE_WALLET_NETWORK = TP1_APPROVED_IDENTITY_RECORD.network;
const IDENTITY_RECORD_DIGEST = createHash('sha256').update(canonicalize(TP1_APPROVED_IDENTITY_RECORD)).digest('hex');

/** Throws an `OperationError` whose code and message are `code`, with `cause` when one is given. */
export const fail = (code, cause) => { throw new OperationError(code, code, undefined, cause === undefined ? undefined : { cause }); };

export { withinAuthorityDeadline };

// Whether `value` is an object whose own members, hidden and symbol-keyed ones included, are exactly `keys`, each a plain data member.
export function hasOnlyDataMembers(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(name => own.includes(name))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
}

// The construction checks (admission shape, untrusted options, Node floor) run before anything is built or imported.
export const checkConstruction = admitPublicFactory(options => ({ options }), { purchase: true });

/**
 * Checks `binding` with the wire's binding check under the authority deadline (a late answer is discarded), then that the connection is still
 * the one checked. Rejects OperationError(profile_not_admitted, cause kept) or OperationError(tp1_local_binding_changed).
 */
export async function checkAdmission({ binding, currentLocal }, owner) {
  const local = owner.currentLocal(), checked = canonicalize(local);
  try { await withinAuthorityDeadline(({ signal }) => settleOnAbort(assertTp1Binding(binding, local), signal)); }
  catch (error) { throw notAdmittedError(error); }
  if (canonicalize(currentLocal()) !== checked || canonicalize(owner.currentLocal()) !== checked) fail('tp1_local_binding_changed');
}

// The pins come from the admitted binding alone, and only for the SDK-held approved record.
export function approvedPins(binding) {
  const { profile, local, recordDigest } = binding ?? {};
  if (recordDigest !== IDENTITY_RECORD_DIGEST || typeof profile?.chainIdentity !== 'string' || typeof profile.pinVersion !== 'string'
    || typeof local?.endpoint !== 'string' || typeof local.transportAuthority !== 'string') fail('admission_required');
  return { network: NODE_WALLET_NETWORK, chainIdentity: profile.chainIdentity, pinVersion: profile.pinVersion, endpoint: local.endpoint, transportAuthority: local.transportAuthority };
}

export function readExpectedPins(binding, owner) {
  const pins = approvedPins(binding);
  if (typeof owner?.fetchImpl !== 'function') fail('invalid_transport_owner');
  return pins;
}

// The block-zero fallback, block-one layout and block-two hash the transport reviews the SDK-approved record's node against.
export const approvedSourcePolicy = () => ({ fallback: { blockZeroUnavailable: 'literal-error', documentation: TP1_APPROVED_IDENTITY_RECORD.provenance.documentation },
  blockZeroErrorEnvelope: DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE, blockOneLayout: DEVNET_NODE2_BLOCK_LAYOUT, reviewedBlockTwoHash: TP1_REVIEWED_BLOCK_TWO_HASH });
