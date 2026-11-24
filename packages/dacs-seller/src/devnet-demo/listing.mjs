import { canonicalize, contentHash, isAnchorReceipt, publishListingCore, sha256Hex } from '@kynesyslabs/dacs';
import { verifyComponent } from '../dacs/listing.mjs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { isSellerCreatePass } from './create-pass.mjs';
import { stopRequested, stopSignal } from './stop-request.mjs';
import { signRetainedInPass } from './wallet-signature-pass.mjs';

/**
 * Publish a signed Listing only after its signature verifies for the seller and fresh authenticated final readback; sign receives
 * its stop signal. The signature is made in a pass of `runCreate` (the wallet-session port's `runCreate`, or another runCreate
 * createSellerCreatePass issued) and retained on its own effect-history lane, `listing-signature-<sha256 of the signed message>`:
 * publishing the same draft again, also after a restart, reuses the retained signature without calling `sign`. Throws a
 * TypeError for a missing option or a runCreate the kit did not issue.
 */
export function createDevnetDemoListingPublisher({anchor,sign,scanOwnListings,loadRailResolution,runCreate}) {
  if(typeof sign!=='function' || typeof scanOwnListings!=='function' || typeof loadRailResolution!=='function' ||
      !['publish','read','verifyReceipt'].every(method=>typeof anchor?.[method]==='function')) throw new TypeError('listing publication requires signer, history, rail authority and authenticated native anchor operations');
  if(!isSellerCreatePass(runCreate)) throw new TypeError('runCreate must be a pass that createSellerCreatePass or the wallet-session port issued');
  const assertRunning=()=>{if(stopRequested()) throw new Error('the operator is stopping');};
  return async(draft)=>{
    assertKitOperationAdmitted('createDevnetDemoListingPublisher');
    assertRunning();
    const seller=draft.seller.identity.presentedBy;
    // This one publication's check: the signature's pass and the CREATE's pass ask it last before the signature and each
    // transmission, so a stop requested meanwhile signs and sends nothing more. A Listing has no job; its pass class is job-create.
    const currentAuthorization=()=>{assertRunning();return true;};
    let signedListing=null;
    const publication=await publishListingCore(draft,{
      sign:async(bytes)=>{
        // The stop checks and the verification run before the signature is retained.
        const signValue=async()=>{
          assertRunning();
          const signature=await sign(bytes,{signal:stopSignal});
          assertRunning();
          const value=typeof signature==='string'?signature:Buffer.from(signature).toString('base64url');
          if(!verifyComponent({signedBytes:bytes,signature:{algorithm:'ed25519',signer:seller,value}})) throw new Error('the wallet signature does not verify for the Listing seller');
          return value;
        };
        const operationId=`listing-signature-${sha256Hex(bytes)}`;
        return signRetainedInPass({runCreate,operationId,lane:operationId,operationClass:'job-create',currentAuthorization},signValue);
      },
      scanOwnAnchorsByNamePrefix:scanOwnListings,
      loadRailResolution,
      resolvePayloadVerificationCapability:async()=>({disposition:'not-applicable',reason:'storage-program delivery has no attested-payload method'}),
      writeArtifact:async(logicalAddress,value)=>{
        assertRunning();
        signedListing=structuredClone(value);
        const input={logicalAddress,artifact:value,artifactKind:'Listing',writer:value.seller.identity.presentedBy};
        const hash=contentHash(value);
        const authenticatedFinalReceipt=async(result)=>isAnchorReceipt(result?.receipt) && result.receipt.state==='finalized' &&
          result.receipt.observationDisposition==='established' && result.receipt.logicalAddress===logicalAddress &&
          result.receipt.writer===input.writer && result.receipt.contentHash===hash &&
          await anchor.verifyReceipt({...input,receipt:result.receipt,signedProjection:result.signedProjection,fresh:true})==='valid';
        // authorize runs before the intent is stored; authorizeSigning runs in the wallet as its approval answer returns.
        const running=()=>stopRequested()?'the operator is stopping':true;
        const written=await anchor.publish({...input,authorize:running,authorizeSigning:running,reaskDenied:true,operationClass:'job-create',currentAuthorization});
        if(written?.status!=='present' || !await authenticatedFinalReceipt(written)) throw new Error(written?.reason ?? 'native Listing publication has no authenticated finalized receipt');
        const resolved=await anchor.read({...input,fresh:true});
        if(resolved?.status!=='present' || !await authenticatedFinalReceipt(resolved) || canonicalize(resolved.artifact)!==canonicalize(value) ||
            resolved.receipt.nativeAddress!==written.receipt.nativeAddress || canonicalize(resolved.receipt.transactionRef)!==canonicalize(written.receipt.transactionRef)) throw new Error(resolved?.reason ?? 'native Listing independent readback differs');
        return {address:resolved.receipt.nativeAddress,txRef:resolved.receipt.transactionRef.value};
      },
    });
    return {...publication,listing:signedListing};
  };
}
