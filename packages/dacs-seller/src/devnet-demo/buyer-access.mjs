// Run-time port of http-mcp/src/devnet-demo/buyer-access.mjs at DACS-Agent-commerce/frontend
// 15fdf23: lines 1-51.
// Left out: the operator relay, resend log and approval wrappers.
import { OperationError } from '../operations.mjs';
import { claimForAddress } from '../dacs/demos-claims.mjs';

const capabilities=new WeakSet();
const claimOrNull=(wallet)=>{try{return claimForAddress(wallet);}catch{return null;}};

// buyerLookupReady is false until the operator's purchase store is attached:
// a job's buyer cannot be told yet, so jobAccess says 'unknown' (and the
// seller checks refuse, as buyerForJob has nothing to return).
export function createOperatorBuyerAccess({openBuyerAccess,custodyBuyer,custodySeller=null,paymentObserved=()=>false,buyerForJob=()=>null,buyerLookupReady=()=>true}){
  if(openBuyerAccess!==true&&!/^did:demos:agent:[0-9a-f]{64}$/.test(custodyBuyer??''))throw new TypeError('closed buyer access requires the configured custody buyer');
  const allowsWallet=(wallet)=>{
    // A malformed wallet never becomes an allowed identity, even in open mode.
    const claim=claimOrNull(wallet);
    return claim!==null&&(openBuyerAccess===true||claim===custodyBuyer);
  };
  const assertWallet=(wallet)=>{
    if(claimOrNull(wallet)===null)throw new OperationError('buyer_access_closed','the supplied wallet is not a well-formed Demos address; nothing was prepared, signed or sent');
    if(!allowsWallet(wallet))throw new OperationError('buyer_access_closed','this operator accepts only its configured custody buyer while openBuyerAccess is off; nothing was prepared, signed or sent');
  };
  // A seller job names one retained buyer; no other wallet may act for it, not even
  // the custody wallet. A missing lookup or buyer leaves that join unavailable.
  const refuse=()=>{throw new OperationError('buyer_access_closed','the seller job has no retained buyer matching this wallet; nothing was prepared, signed or sent');};
  const retainedBuyer=(jobId)=>buyerLookupReady()===true?claimOrNull(buyerForJob(jobId)):null;
  const capability=Object.freeze({allowsWallet,assertWallet,assertRelayWallet(wallet){
    // A public relay acts only for buyers. The custody seller's own wallet
    // traffic is carried in-process (seller-relay.mjs), so a request naming
    // its address is refused in every access mode: an address proves nothing.
    if(custodySeller&&claimOrNull(wallet)===custodySeller)throw new OperationError('seller_wallet_in_process','this relay never acts for the operator custody seller; nothing was read, signed or sent');
    assertWallet(wallet);
  },assertSellerJob(jobId){
    if(openBuyerAccess===true)return;
    const wallet=buyerForJob(jobId);
    if(!wallet)throw new OperationError('buyer_access_closed','the seller job has no retained authorized buyer');
    capability.assertSellerWallet(wallet,jobId);
  },assertSellerWallet(wallet,jobId){
    if(openBuyerAccess===true){assertWallet(wallet);return;}
    const buyer=retainedBuyer(jobId);
    if(!buyer||claimOrNull(wallet)!==buyer)refuse();
    if(!allowsWallet(wallet)&&paymentObserved(jobId)!==true)refuse();
  },jobAccess(jobId){
    // 'open'; 'custody' (the custody buyer's job); 'outside' (any other or no
    // retained buyer, paid or not); 'unknown' (the lookup is not attached yet).
    if(openBuyerAccess===true)return 'open';
    if(buyerLookupReady()!==true)return 'unknown';
    const wallet=buyerForJob(jobId);
    return wallet&&allowsWallet(wallet)?'custody':'outside';
  },sellerNotice(wallet,jobId){
    if(openBuyerAccess===true){assertWallet(wallet);return null;}
    capability.assertSellerWallet(wallet,jobId);
    return allowsWallet(wallet)?null:'This buyer is outside closed access. Payment was already observed. Approve this exact seller transaction manually to continue delivery.';
  }});
  capabilities.add(capability);return capability;
}

export function operatorBuyerAccessConfig(value){
  if(value==null)return null;
  if(!capabilities.has(value))throw new TypeError('buyerAccess requires a constructed operator capability');
  return value;
}
