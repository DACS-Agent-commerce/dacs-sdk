import { publishListingCore } from '@kynesyslabs/dacs';
import { stopRequested } from './stop-request.mjs';

export function createDevnetDemoListingPublisher({anchor,sign,scanOwnListings,loadRailResolution}) {
  if(typeof sign!=='function' || typeof scanOwnListings!=='function' || typeof loadRailResolution!=='function' || typeof anchor?.publish!=='function') throw new TypeError('listing publication requires real signer, history, rail authority, and native anchor operations');
  return async(draft)=>{let signedListing=null;const publication=await publishListingCore(draft,{
    sign,
    scanOwnAnchorsByNamePrefix:scanOwnListings,
    loadRailResolution,
    resolvePayloadVerificationCapability:async()=>({disposition:'not-applicable',reason:'storage-program delivery has no attested-payload method'}),
    writeArtifact:async(logicalAddress,value)=>{
      signedListing=structuredClone(value);
      // A stop before the CREATE intent is journaled withdraws the publication;
      // a later stop declines its APPROVE prompt, so the wallet refuses before
      // signing (denied). Either way the next start asks for approval again
      // (reaskDenied) instead of holding the Listing.
      const written=await anchor.publish({logicalAddress,artifact:value,artifactKind:'Listing',authorize:()=>stopRequested()?'the operator is stopping':true,reaskDenied:true});
      if(written.status!=='present') throw new Error(written.reason ?? 'native Listing publication is indeterminate');
      return {address:written.receipt.nativeAddress,txRef:written.receipt.transactionRef.value};
    },
  });return{...publication,listing:signedListing};};
}
