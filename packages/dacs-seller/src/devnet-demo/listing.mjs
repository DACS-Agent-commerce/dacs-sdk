import { canonicalize, contentHash, isAnchorReceipt, publishListingCore } from '@kynesyslabs/dacs';
import { stopRequested, stopSignal } from './stop-request.mjs';

/** Publish a signed Listing only after fresh authenticated final readback; sign receives its stop signal. */
export function createDevnetDemoListingPublisher({anchor,sign,scanOwnListings,loadRailResolution}) {
  if(typeof sign!=='function' || typeof scanOwnListings!=='function' || typeof loadRailResolution!=='function' ||
      !['publish','read','verifyReceipt'].every(method=>typeof anchor?.[method]==='function')) throw new TypeError('listing publication requires signer, history, rail authority and authenticated native anchor operations');
  const assertRunning=()=>{if(stopRequested()) throw new Error('the operator is stopping');};
  return async(draft)=>{
    assertRunning();
    let signedListing=null;
    const publication=await publishListingCore(draft,{
      sign:async(bytes)=>{
        assertRunning();
        const signature=await sign(bytes,{signal:stopSignal});
        assertRunning();
        return signature;
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
        const written=await anchor.publish({...input,authorize:()=>stopRequested()?'the operator is stopping':true,reaskDenied:true,stopSignal});
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
