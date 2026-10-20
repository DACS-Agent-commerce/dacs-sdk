import { CounterpartyError, DacsError, faultCategory, FINALITY_COMMITMENT_SEPARATOR, isReadableFinalityCommitmentRecord, NotImplementedError, signedBytes, UnsupportedCapabilityError, contentHash } from '@kynesyslabs/dacs';
import { commitmentVerifier, listingPin } from '../dacs/purchase-protocol.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from '../dacs/seller-sr2-agreement-consumer.mjs';

export const DEVNET_NATIVE_COMMITMENT_MARKER='dacs-chatgpt-plugin/devnet-native-seller-commitment/v1';
const capabilities=new WeakMap();
export function createDevnetNativeCommitmentCapability({authority,anchor}) {
  if(typeof authority!=='string'||!/^TEST-RUN-[A-Za-z0-9._-]{8,80}$/.test(authority)||anchor?.authority!==authority||typeof anchor.readRetained!=='function'||typeof anchor.verifyReceipt!=='function') throw new TypeError('native commitment requires the exact run-scoped seller artifact reader');
  const value=Object.freeze({source:DEVNET_NATIVE_COMMITMENT_MARKER,authority,publicProjection:SELLER_SR2_PUBLIC_PROJECTION});capabilities.set(value,anchor);return value;
}
export function devnetNativeCommitmentConfig(value){if(value==null)return null;if(!capabilities.has(value))throw new TypeError('native seller commitment requires a constructed capability');return value;}


// the source change: a purchase ends rejected only on an authenticated contradiction. That
// is a signature the plugin's own verifier finds invalid (the SDK's
// CounterpartyError, for the commitment or the Agreement), or a permanent SDK
// fault together with a contradiction the plugin authenticated itself: its
// anchor answered the receipt proof invalid, which it answers only for a
// seller-signed record that contradicts the commitment (receiptContradicted),
// or the commitment's own signature verifies and it binds another job,
// Agreement, Listing pin, parties or pattern (recordContradicted, CA-3/CA-7).
// Everything else is indeterminate: substrate
// and transient faults, foreign or non-Error throws, the SDK's local capability
// boundaries, and its other permanent DacsErrors, which it raises on local
// input or before the record is authenticated.
export function commitmentContradicted(error,{receiptContradicted=false,recordContradicted=false}={}) {
  if(error instanceof CounterpartyError)return true;
  return (receiptContradicted===true||recordContradicted===true)&&error instanceof DacsError&&faultCategory(error)==='permanent'&&!(error instanceof UnsupportedCapabilityError)&&!(error instanceof NotImplementedError);
}
// The SDK checks the session binding (CA-3/CA-7) before the record's signature,
// so its fault alone proves nothing. Authenticated here: the record is a
// readable finality record, its own signature verifies under the session
// orchestrator, and it differs from the SDK's binding (recordMatchesBinding)
// derived from this purchase's Agreement and Listing: the job, Agreement hash,
// Listing pin, ordered buyer and seller claims, or fixed-price pattern. Any
// doubt (shape, signer, a verifier fault, an Agreement that does not bind its
// own Listing pin) is no contradiction.
export function commitmentRecordContradicts(record,{agreement,listing,session}) {
  try{
    if(!isReadableFinalityCommitmentRecord(record)||record.signature.algorithm!=='ed25519'||record.signature.signer!==session.orchestrator)return false;
    if(commitmentVerifier({signer:record.signature.signer,algorithm:'ed25519',value:record.signature.value,signedBytes:signedBytes(FINALITY_COMMITMENT_SEPARATOR,contentHash(record))})!=='valid')return false;
    const pin=listingPin(listing),samePin=(ref)=>ref?.listingId===pin.listingId&&ref.version===pin.version&&ref.contentHash===pin.contentHash;
    const parties=['buyer','seller'].map((role)=>agreement.parties.find((p)=>p.role===role)?.primaryClaim);
    if(!samePin(agreement.listingRef)||parties.some((claim)=>typeof claim!=='string'))return false;
    return record.jobId!==agreement.jobId||record.agreementHash!==contentHash(agreement)||!samePin(record.listingRef)
      ||record.parties.length!==parties.length||parties.some((claim,i)=>record.parties[i]!==claim)||record.pattern!=='fixed-price';
  }catch{return false;}
}
