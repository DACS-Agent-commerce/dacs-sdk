// Exact CREATE/confirmation fixtures adapted from #58's purchase-source tests.
import {createHash} from 'node:crypto';
import {canonicalize,compositeVerificationAddress,contentHash,finalityCommitmentAddress,paymentEvidenceAddress} from '@kynesyslabs/dacs';
const deriveStorageAddress=()=> '0x'+'9'.repeat(64);
const buildStorageProgramCreatePayload=({storageAddress,programName,logicalAddress,signedListing})=>({content:{data:['storageProgram',{operation:'CREATE_STORAGE_PROGRAM',storageAddress,programName,salt:'',data:signedListing,encoding:'json',acl:{mode:'public'},storageLocation:'onchain',metadata:{logicalAddress}}]}});
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const address=`0x${'a'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`,buyer=`did:demos:agent:${'1'.repeat(64)}`,buyerWallet=`0x${'1'.repeat(64)}`;
const outsider=`did:demos:agent:${'2'.repeat(64)}`;
const pin={listingId:'policy-listing',version:1,contentHash:'b'.repeat(64)},agreementHash='e'.repeat(64);
const sourceBinding={source:'devnet-agreement-transport/v1',bindingVersion:'dacs-demos-network-binding/v1',bindingId:'c'.repeat(64),network:'demos-devnet',chainIdentity:'d'.repeat(64),endpoint:'https://node2.test.invalid/',pinVersion:'TEST-pin',transportAuthority:'TEST-owner'};
const T0=1_800_000_000_000,DAY=86_400_000,OTHER_JOB='01ARZ3NDEKTSV4RRFFQ69G5FB2';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ','01ARZ3NDEKTSV4RRFFQ69G5FB0','01ARZ3NDEKTSV4RRFFQ69G5FB1'];
const demString=(os)=>{const whole=os/1_000_000_000n,fraction=(os%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:`${whole}`;};

// One exact seller CREATE request as the embedded wallet shows it (same shape
// as test/seller-policy-delivery-evidence.test.mjs).
function requestFor({artifactKind='Deliverable',job=JOBS[0],party=buyer,phase='deliver-storage-program',artifact:override={},logicalAddress:addressOverride,rpcFeeDem='1'}={}){
  const settlementKind=artifactKind==='SettlementEvidence'&&phase==='pay-dem';
  const artifact={...(artifactKind==='Deliverable'?{reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:job,agreementHash,listing:pin,title:'Policy report',settlementId:'demos:TEST',producer:seller,content:{mediaType:'text/plain; charset=utf-8',text:'Purchased bytes'}}
    :artifactKind==='CompositeVerificationRecord'?{recordVersion:'1',jobId:job,evaluatedParty:party,verifier:seller}
    :artifactKind==='FinalityCommitmentRecord'?{finalityCommitmentVersion:'1',jobId:job,pattern:'fixed-price',agreementHash}
    :{evidenceVersion:'1',jobId:job,phase,outcome:'success',...(settlementKind?{paymentAmount:{amount:'1',currency:'DEM'}}:{})}),...override};
  const logicalAddress=addressOverride??(artifactKind==='Deliverable'?`dacs4:deliverable:${job}`:artifactKind==='CompositeVerificationRecord'?compositeVerificationAddress(job,party)
    :artifactKind==='FinalityCommitmentRecord'?finalityCommitmentAddress(job):settlementKind?paymentEvidenceAddress(job,'demos-native:DEM',2):`dacs4:evidence:${job}`);
  const programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=deriveStorageAddress(address,programName,1);
  const tx=buildStorageProgramCreatePayload({from:address,storageAddress,programName,logicalAddress,signedListing:artifact,nonce:1,timestamp:7});
  const deliveryBinding=artifactKind==='Deliverable'?{version:'1',profile:'dacs-native-delivery-publication/v1',jobId:job,phase:'deliver-storage-program',phaseIndex:3,listing:pin,agreementHash,fulfilmentId:'TEST-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(artifact)}:null;
  if(deliveryBinding)tx.content.data[1].metadata.deliveryBinding=deliveryBinding;
  Object.assign(tx.content.data[1].metadata,{contentHash:contentHash(artifact),envelopeHash:sha(canonicalize(artifact)),artifactKind,networkBinding:sourceBinding});
  const fees=['1','1','1',rpcFeeDem],totalOs=fees.reduce((sum,dem)=>sum+BigInt(dem.split('.')[0])*1_000_000_000n+BigInt((dem.split('.')[1]??'').padEnd(9,'0')),0n);
  return{method:'sendTransaction',address,purpose:`Create immutable ${artifactKind} for this exact job`,content:{kind:settlementKind?'devnet-settlement-evidence-storage-create':'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind,jobId:job,owner:seller,wallet:address,logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',envelopeHash:sha(canonicalize(artifact)),...(deliveryBinding?{deliveryBinding}:{}),storageBytes:Buffer.byteLength(JSON.stringify(artifact)),exactStorageBytes:JSON.stringify(artifact),exactCreate:JSON.stringify(tx.content.data[1]),nonce:1,timestamp:7,debit:{storageFeeDem:'1',sellerAmountDem:'0',sdkGasDem:'1',networkFeeDem:'1',rpcFeeDem,additionalFeeDem:'0',totalDem:demString(totalOs),totalOs:totalOs.toString(),note:'Complete debit'},network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,networkBinding:sourceBinding,evidence:'TEST source',sending:'Send once'}};
}
function confirmationFor(r){
  return{result:200,response:{data:{valid:true,gas_operation:null,transaction:{content:{type:'storageProgram',amount:'0',from:r.address,nonce:r.content.nonce,timestamp:r.content.timestamp,data:['storageProgram',JSON.parse(r.content.exactCreate)],
    transaction_fee:{network_fee:'1000000000',rpc_fee:'1000000000',additional_fee:'0'},
    gcr_edits:[{type:'balance',operation:'remove',account:r.address,amount:'1000000000'},{type:'balance',operation:'remove',account:r.address,amount:'1000000000'}]}}}}};
}


export {address,seller,buyer,pin,sourceBinding,T0,JOBS,requestFor,confirmationFor};
