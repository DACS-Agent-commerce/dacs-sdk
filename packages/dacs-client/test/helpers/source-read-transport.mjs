// The real Agreement source transport, pinned to the SDK-approved TP-1 record on a
// queued owner, for the source-read and crash tests. No node is reached unless the
// owner's fetchImpl reaches one. Tests only.
import { TP1_APPROVED_IDENTITY_RECORD as record } from '@kynesyslabs/dacs/wire';
import { createDevnetAgreementTransport } from '../../src/wallet/devnet-native-transport.mjs';

export const SOURCE_FALLBACK = Object.freeze({ blockZeroUnavailable: 'literal-error', documentation: record.provenance.documentation });

/** Builds the transport over `journal` and `owner`; extra options (a reviewed layout, say) pass through. */
export function sourceReadTransport({ journal, owner, ...options }) {
  const { endpoint, transportAuthority } = owner.local;
  return createDevnetAgreementTransport({
    expected: { network: record.network, chainIdentity: record.chainIdentity, pinVersion: record.pinVersion, endpoint, transportAuthority },
    transportOwner: owner, journal, fetchImpl: (...args) => owner.fetchImpl(...args), fallback: SOURCE_FALLBACK, ...options,
  });
}

/** The journal lock key a source read takes. */
export const sourceReadLockKey = transport => `devnet/source-read/${transport.profile('https://node-wallet.invalid').transportBinding.bindingId}`;
