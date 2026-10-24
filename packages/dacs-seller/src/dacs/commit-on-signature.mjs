import { canonicalize, contentHash, finalizeFixedPriceAgreementContributions, logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { addressForClaim, verifyDemosSignature } from './demos-claims.mjs';
import { deriveStorageAddress } from './wallet-transactions.mjs';
const plainJson = value => JSON.parse(canonicalize(value));

export function commitOnSignatureConfig(value = false) {
  if (typeof value !== 'boolean') throw new TypeError('commitOnSignature must be boolean');
  return value;
}

export async function verifySignatureAgreement(agreement, session, verify) {
  if (!session.proposal || !session.sellerContribution) throw new Error('no retained Agreement proposal');
  const expected = await finalizeFixedPriceAgreementContributions(session.proposal.plan,
    [session.proposal.buyerContribution, session.sellerContribution], verify);
  if (contentHash(agreement) !== session.agreementHash || canonicalize(agreement) !== canonicalize(expected)) throw new Error('signed Agreement differs from the retained parties, terms, job or Listing');
  return plainJson(expected);
}

// Public signed CREATE evidence authorizes exact bytes, not broadcast or inclusion.
export function verifyAgreementCreateAuthorization(signed, agreement, logicalAddress, writer) {
  const c = signed?.content, op = c?.data?.[1], owner = addressForClaim(writer);
  const programName = logicalToStorageProgramName(logicalAddress);
  if (!c || !/^[0-9a-f]{64}$/.test(signed.hash) || sha256Hex(JSON.stringify(c)) !== signed.hash
    || signed.signature?.type !== 'ed25519' || !verifyDemosSignature({ address: owner, message: signed.hash, signature: signed.signature.data })
    || c.from !== owner || c.from_ed25519_address !== owner || c.type !== 'storageProgram'
    || !Number.isSafeInteger(c.nonce) || c.nonce < 1 || ![0, '0'].includes(c.amount)
    || c.data.length !== 2 || c.data[0] !== 'storageProgram' || op?.operation !== 'CREATE_STORAGE_PROGRAM'
    || op.programName !== programName || op.salt !== '' || op.encoding !== 'json' || op.storageLocation !== 'onchain'
    || op.acl?.mode !== 'public' || op.storageAddress !== deriveStorageAddress(owner, programName, c.nonce, '') || c.to !== op.storageAddress
    || canonicalize(op.data) !== canonicalize(agreement) || op.metadata?.logicalAddress !== logicalAddress
    || op.metadata?.artifactKind !== 'Agreement' || op.metadata?.contentHash !== contentHash(agreement)
    || op.metadata?.envelopeHash !== sha256Hex(canonicalize(agreement))) throw new Error('buyer has not authorized the exact Agreement CREATE');
}

export function signatureCommitmentAnchor(anchor, seller, enabled) {
  if (!enabled || typeof anchor.onCreateAuthorized !== 'function') return anchor;
  const { onCreateAuthorized, ...sdkAnchor } = anchor;
  return { ...sdkAnchor, async anchorAgreement(input) {
    // The broker invokes this only after retaining the approved signed CREATE.
    // It returns immediately so the buyer remains the sole broadcaster.
    onCreateAuthorized(input, signedProjection => {
      void Promise.resolve().then(() => seller.commitOnSignature(input.artifact.jobId, plainJson(input.artifact), structuredClone(signedProjection))).catch(() => null);
    });
    return anchor.anchorAgreement(input);
  } };
}
