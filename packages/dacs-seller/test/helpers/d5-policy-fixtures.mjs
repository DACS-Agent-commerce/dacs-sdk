import { sellerRecordsPurchaseResolver } from '../../src/devnet-demo/seller-purchase-source.mjs';
// Exact CREATE/confirmation fixtures adapted from #58's purchase-source tests.
import {createHash} from 'node:crypto';
import {canonicalize,compositeVerificationAddress,contentHash,finalityCommitmentAddress,paymentEvidenceAddress} from '@kynesyslabs/dacs';
import { deriveStorageAddress } from '../../src/dacs/wallet-transactions.mjs';
const buildStorageProgramCreatePayload=({storageAddress,programName,logicalAddress,signedListing})=>({content:{data:['storageProgram',{operation:'CREATE_STORAGE_PROGRAM',storageAddress,programName,salt:'',data:signedListing,encoding:'json',acl:{mode:'public'},storageLocation:'onchain',metadata:{logicalAddress}}]}});
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const address=`0x${'a'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`,buyer=`did:demos:agent:${'1'.repeat(64)}`,buyerWallet=`0x${'1'.repeat(64)}`;
const outsider=`did:demos:agent:${'2'.repeat(64)}`;
const pin={listingId:'policy-listing',version:1,contentHash:'b'.repeat(64)},agreementHash='e'.repeat(64);
const sourceBinding={source:'devnet-agreement-transport/v1',bindingVersion:'dacs-demos-network-binding/v1',bindingId:'c'.repeat(64),network:'demos-devnet',chainIdentity:'d'.repeat(64),endpoint:'https://node2.test.invalid/',pinVersion:'TEST-pin',transportAuthority:'TEST-owner'};
const T0=1_800_000_000_000,DAY=86_400_000,OTHER_JOB='01ARZ3NDEKTSV4RRFFQ69G5FB2';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ','01ARZ3NDEKTSV4RRFFQ69G5FB0','01ARZ3NDEKTSV4RRFFQ69G5FB1'];
const demOs=(dem)=>BigInt(dem.split('.')[0])*1_000_000_000n+BigInt((dem.split('.')[1]??'').padEnd(9,'0'));
const demString=(os)=>{const whole=os/1_000_000_000n,fraction=(os%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:`${whole}`;};

// One exact seller CREATE request as the embedded wallet shows it (same shape
// as test/seller-policy-delivery-evidence.test.mjs).
function requestFor({artifactKind='Deliverable',job=JOBS[0],party=buyer,phase='deliver-storage-program',artifact:override={},logicalAddress:addressOverride,rpcFeeDem='1'}={}){
  const settlementKind=artifactKind==='SettlementEvidence'&&phase==='pay-dem';
  const artifact={...(artifactKind==='Deliverable'?{reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:job,agreementHash,listing:pin,title:'Policy report',settlementId:'demos:TEST',producer:seller,content:{mediaType:'text/plain; charset=utf-8',text:'Purchased bytes'}}
    :artifactKind==='CompositeVerificationRecord'?{recordVersion:'1',jobId:job,evaluatedParty:party,verifier:seller}
    :artifactKind==='FinalityCommitmentRecord'?{finalityCommitmentVersion:'1',jobId:job,pattern:'fixed-price',agreementHash,listingRef:pin}
    :{evidenceVersion:'1',jobId:job,phase,outcome:'success',...(settlementKind?{paymentAmount:{amount:'1',currency:'DEM'}}:{})}),...override};
  for(const [key,value] of Object.entries(override))if(value===undefined)delete artifact[key];
  const logicalAddress=addressOverride??(artifactKind==='Deliverable'?`dacs4:deliverable:${job}`:artifactKind==='CompositeVerificationRecord'?compositeVerificationAddress(job,party)
    :artifactKind==='FinalityCommitmentRecord'?finalityCommitmentAddress(job):settlementKind?paymentEvidenceAddress(job,'demos-native:DEM',2):`dacs4:evidence:${job}`);
  const programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=deriveStorageAddress(address,programName,1);
  const tx=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce:1,timestamp:7});
  const deliveryBinding=artifactKind==='Deliverable'?{version:'1',profile:'dacs-native-delivery-publication/v1',jobId:job,phase:'deliver-storage-program',phaseIndex:3,listing:pin,agreementHash,fulfilmentId:'TEST-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(artifact)}:null;
  if(deliveryBinding)tx.content.data[1].metadata.deliveryBinding=deliveryBinding;
  Object.assign(tx.content.data[1].metadata,{contentHash:contentHash(artifact),envelopeHash:sha(canonicalize(artifact)),artifactKind,networkBinding:sourceBinding});
  const fees=['1','1','1',rpcFeeDem],totalOs=fees.reduce((sum,dem)=>sum+demOs(dem),0n);
  return{method:'sendTransaction',address,purpose:`Create immutable ${artifactKind} for this exact job`,content:{kind:settlementKind?'devnet-settlement-evidence-storage-create':'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind,jobId:job,owner:seller,wallet:address,logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',envelopeHash:sha(canonicalize(artifact)),...(deliveryBinding?{deliveryBinding}:{}),storageBytes:Buffer.byteLength(JSON.stringify(artifact)),exactStorageBytes:JSON.stringify(artifact),exactCreate:JSON.stringify(tx.content.data[1]),nonce:1,timestamp:7,debit:{storageFeeDem:'1',sellerAmountDem:'0',sdkGasDem:'1',networkFeeDem:'1',rpcFeeDem,additionalFeeDem:'0',totalDem:demString(totalOs),totalOs:totalOs.toString(),note:'Complete debit'},network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,networkBinding:sourceBinding,evidence:'TEST source',sending:'Send once'}};
}
// The node's executed CREATE for the request (Node 61b8e75): exact content
// keys, its fees, and the four sender edits in order. Native amounts are OS
// strings; legacy (pre-fork) amounts are whole-DEM numbers.
function confirmationFor(r,{legacy=false}={}){
  const c=r.content,op=JSON.parse(c.exactCreate),wire=(dem)=>legacy?Number(dem):demOs(dem).toString();
  const removal=(dem)=>({type:'balance',operation:'remove',isRollback:false,account:r.address,txhash:'',amount:wire(dem)});
  return{result:200,response:{data:{valid:true,gas_operation:null,transaction:{content:{type:'storageProgram',from:r.address,from_ed25519_address:r.address,to:c.storageAddress,amount:wire('0'),
    data:['storageProgram',op],nonce:c.nonce,timestamp:c.timestamp,network:c.network,chainIdentity:c.chainIdentity,
    transaction_fee:{network_fee:wire(c.debit.networkFeeDem),rpc_fee:wire(c.debit.rpcFeeDem),additional_fee:wire(c.debit.additionalFeeDem),rpc_address:null},
    gcr_edits:[removal(c.debit.storageFeeDem),
      {type:'storageProgram',target:c.storageAddress,isRollback:false,txhash:'',context:{operation:'CREATE_STORAGE_PROGRAM',sender:r.address,data:{variables:op,metadata:op.metadata}}},
      removal(c.debit.sdkGasDem),{type:'nonce',operation:'add',isRollback:false,account:r.address,txhash:'',amount:1}]}}}}};
}


export {address,seller,buyer,pin,sourceBinding,T0,JOBS,requestFor,confirmationFor};

export function realPurchaseResolver(){
 const agreement={parties:[{role:'buyer',primaryClaim:buyer},{role:'seller',primaryClaim:seller}],listingRef:pin,terms:{price:{amount:'1',currency:'DEM'}}};
 // Keep the fixture's Agreement hash consistent with the actual seller projection.
 return sellerRecordsPurchaseResolver({sessionOf:()=>({jobId:JOBS[0],agreement,agreementHash:contentHash(agreement),buyerBundle:{presentedBy:buyer},agreementSignedProjection:{content:{network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,data:['storageProgram',{metadata:{networkBinding:sourceBinding}}]}}}),buyerAccess:()=>({allowsWallet:()=>true}),now:()=>T0,
  observePayment:q=>({disposition:'absent',jobId:q.jobId,agreementHash:q.agreementHash,observedAt:q.observedAt})});
}
