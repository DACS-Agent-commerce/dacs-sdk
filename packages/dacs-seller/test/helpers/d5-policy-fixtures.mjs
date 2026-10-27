import { sellerRecordsPurchaseResolver } from '../../src/devnet-demo/seller-purchase-source.mjs';
// Exact seller write requests and node confirmations, written out by hand from
// the packaged wallet's request (sdk-provider.mjs devnetAgreementAnchorPlan and
// its sendTransaction approval) and Node 61b8e75's executed CREATE.
import {createHash} from 'node:crypto';
import {canonicalize,compositeVerificationAddress,contentHash,finalityCommitmentAddress,paymentEvidenceAddress} from '@kynesyslabs/dacs';
const sha=(value)=>createHash('sha256').update(value).digest('hex');
const address=`0x${'a'.repeat(64)}`,seller=`did:demos:agent:${'a'.repeat(64)}`,buyer=`did:demos:agent:${'1'.repeat(64)}`;
const pin={listingId:'policy-listing',version:1,contentHash:'b'.repeat(64)},agreementHash='e'.repeat(64);
const sourceBinding={source:'devnet-agreement-transport/v1',bindingVersion:'dacs-demos-network-binding/v1',bindingId:'c'.repeat(64),network:'demos-devnet',chainIdentity:'d'.repeat(64),endpoint:'https://node2.test.invalid/',pinVersion:'TEST-pin',transportAuthority:'TEST-owner'};
// The demo publication authority the host's source capability names.
const artifactAuthority='TEST-RUN-policy-fixture';
const T0=1_800_000_000_000,TX_HASH='9'.repeat(64);
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX','01ARZ3NDEKTSV4RRFFQ69G5FAY','01ARZ3NDEKTSV4RRFFQ69G5FAZ','01ARZ3NDEKTSV4RRFFQ69G5FB0','01ARZ3NDEKTSV4RRFFQ69G5FB1'];
const demOs=(dem)=>BigInt(dem.split('.')[0])*1_000_000_000n+BigInt((dem.split('.')[1]??'').padEnd(9,'0'));
const demString=(os)=>{const whole=os/1_000_000_000n,fraction=(os%1_000_000_000n).toString().padStart(9,'0').replace(/0+$/,'');return fraction?`${whole}.${fraction}`:`${whole}`;};
const signature=()=>({algorithm:'ed25519',signer:seller,value:'A'.repeat(86)});

// The seller's artifact of each kind, as DACS and the demo report define it.
function artifactFor(artifactKind,job,party,phase){
  if(artifactKind==='CompositeVerificationRecord')return{recordVersion:'1',jobId:job,evaluatedParty:party,bundleHash:'3'.repeat(64),requirementHash:'4'.repeat(64),
    freshness:[],supplementary:[],dealSpecific:[],overallDecision:'pass',generatedAt:T0,signature:signature()};
  if(artifactKind==='FinalityCommitmentRecord')return{finalityCommitmentVersion:'1',jobId:job,agreementHash,listingRef:{...pin},parties:[buyer,seller],pattern:'fixed-price',createdAt:T0,signature:signature()};
  if(artifactKind==='Deliverable')return{reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:job,agreementHash,listing:{...pin},title:'Policy report',
    settlementId:'demos:TEST',producer:seller,content:{mediaType:'text/plain; charset=utf-8',text:'Purchased bytes'}};
  if(phase==='pay-dem')return{evidenceVersion:'1',jobId:job,phase,outcome:'success',paymentTxRefs:[{kind:'demos',txHash:'5'.repeat(64),blockNumber:9}],
    paymentAmount:{amount:'1',currency:'DEM'},settlementFinality:{model:'bft-final',finalityObservedAt:T0},observedAt:T0,signature:signature()};
  return{evidenceVersion:'1',jobId:job,phase,outcome:'success',dacsSdkAuditSourceHash:'6'.repeat(64),deliverableContentHash:deliveredHashFor(job),
    deliverableAnchor:{kind:'storage-program',locator:`dacs4:deliverable:${job}`},observedAt:T0,signature:signature()};
}
// The payload hash of the job's fixture Deliverable, which its delivery evidence commits to.
const deliveredHashFor=(job)=>contentHash(artifactFor('Deliverable',job));
// The payment transaction the fixture's pay-dem evidence names, as a verified observer reading reports it.
const PAYMENT_TX_REF=Object.freeze({kind:'demos',txHash:'5'.repeat(64),blockNumber:9});

// One exact seller CREATE request as the packaged wallet shows it. artifact
// overrides top-level artifact members (undefined deletes one); editArtifact,
// editDeliveryBinding and editCreate change the artifact, the binding (in the
// request and the CREATE) or the CREATE before the request is derived from them.
function requestFor({artifactKind='Deliverable',job=JOBS[0],party=buyer,phase='deliver-storage-program',artifact:override={},editArtifact=()=>{},editDeliveryBinding=()=>{},editCreate=()=>{},logicalAddress:addressOverride,rpcFeeDem='1'}={}){
  const settlementKind=artifactKind==='SettlementEvidence'&&phase==='pay-dem';
  const artifact={...artifactFor(artifactKind,job,party,phase),...override};
  for(const [key,value] of Object.entries(override))if(value===undefined)delete artifact[key];
  editArtifact(artifact);
  const logicalAddress=addressOverride??(artifactKind==='Deliverable'?`dacs4:deliverable:${job}`:artifactKind==='CompositeVerificationRecord'?compositeVerificationAddress(job,artifact.evaluatedParty)
    :artifactKind==='FinalityCommitmentRecord'?finalityCommitmentAddress(job):settlementKind?paymentEvidenceAddress(job,'demos-native:DEM',2):`dacs4:evidence:${job}`);
  const stored=canonicalize(artifact),programName=logicalAddress.replace(/:/g,'%3A'),storageAddress=`stor-${sha(`${address}:${programName}:1:`).slice(0,40)}`;
  let deliveryBinding=null;
  if(artifactKind==='Deliverable'){
    deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:job,phase:'deliver-storage-program',phaseIndex:3,listing:{...pin},agreementHash,fulfilmentId:'TEST-fulfilment',purchaseAmount:{amount:'1',currency:'DEM'},payloadHash:contentHash(artifact)};
    editDeliveryBinding(deliveryBinding);
  }
  const metadata={logicalAddress,contentHash:contentHash(artifact),envelopeHash:sha(stored),artifactKind,networkBinding:sourceBinding,
    ...(settlementKind?{}:{artifactBinding:{version:'1',policy:'dacs-devnet-demo-artifacts/v1',authority:artifactAuthority,artifactKind,jobId:job,logicalAddress,writer:seller}}),
    ...(deliveryBinding?{deliveryBinding}:{})};
  const create={operation:'CREATE_STORAGE_PROGRAM',storageAddress,programName,encoding:'json',data:artifact,metadata,acl:{mode:'public'},salt:'',storageLocation:'onchain'};
  editCreate(create);
  const fees=['1','1','1',rpcFeeDem],totalOs=fees.reduce((sum,dem)=>sum+demOs(dem),0n);
  return{method:'sendTransaction',address,purpose:`Create immutable ${artifactKind} for job ${job}. Total debit ${demString(totalOs)} DEM.`,
    content:{kind:settlementKind?'devnet-settlement-evidence-storage-create':'devnet-demo-artifact-storage-create',action:'immutable DACS storage anchor CREATE',artifactKind,jobId:job,
      owner:seller,wallet:address,logicalAddress,storageAddress,programName,contentHash:contentHash(artifact),contentHashProfile:'SDK CF-1 signed scope (top-level signature/signatures omitted)',
      envelopeHash:sha(stored),...(deliveryBinding?{deliveryBinding:structuredClone(deliveryBinding)}:{}),storageBytes:Buffer.byteLength(stored),exactStorageBytes:stored,exactCreate:canonicalize(create),
      nonce:1,timestamp:7,debit:{storageFeeDem:'1',sellerAmountDem:'0',sdkGasDem:'1',networkFeeDem:'1',rpcFeeDem,additionalFeeDem:'0',totalDem:demString(totalOs),totalOs:totalOs.toString(),note:'Complete debit'},
      network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,networkBinding:sourceBinding,evidence:'TEST source',sending:'Send once'}};
}

// The node's executed CREATE for the request (Node 61b8e75): the signed
// transaction with its hash, exact content keys, its fees and the four sender
// edits in order. Native amounts are OS strings; legacy (pre-fork) amounts are
// whole-DEM numbers. executed: the hash-bound encodings the client reader also
// accepts (decimal-string nonce, timestamp and nonce step, a gas_operation).
function confirmationFor(r,{legacy=false,executed=false}={}){
  const c=r.content,op=JSON.parse(c.exactCreate),wire=(dem)=>legacy?Number(dem):demOs(dem).toString(),integer=(value)=>executed?String(value):value;
  const removal=(dem)=>({type:'balance',operation:'remove',isRollback:false,account:r.address,txhash:'',amount:wire(dem)});
  const fees={network_fee:wire(c.debit.networkFeeDem),rpc_fee:wire(c.debit.rpcFeeDem),additional_fee:wire(c.debit.additionalFeeDem)};
  return{result:200,response:{data:{valid:true,reference_block:9,message:'TEST valid',gas_operation:executed?{fees:{...fees}}:null,
    transaction:{signature:{type:'ed25519',data:`0x${'8'.repeat(128)}`},hash:TX_HASH,status:'',blockNumber:null,
      content:{type:'storageProgram',from:r.address,from_ed25519_address:r.address,to:c.storageAddress,amount:wire('0'),
        data:['storageProgram',op],nonce:integer(c.nonce),timestamp:integer(c.timestamp),network:c.network,chainIdentity:c.chainIdentity,
        transaction_fee:{...fees,rpc_address:null},
        gcr_edits:[removal(c.debit.storageFeeDem),
          {type:'storageProgram',target:c.storageAddress,isRollback:false,txhash:executed?TX_HASH:'',context:{operation:'CREATE_STORAGE_PROGRAM',sender:r.address,data:{variables:op,metadata:op.metadata}}},
          removal(c.debit.sdkGasDem),{type:'nonce',operation:'add',isRollback:false,account:r.address,txhash:'',amount:integer(1)}]}}}}};
}

export {address,seller,buyer,pin,agreementHash,sourceBinding,artifactAuthority,T0,JOBS,PAYMENT_TX_REF,deliveredHashFor,requestFor,confirmationFor};

export function realPurchaseResolver({buyerClaim=buyer}={}){
 const agreement={parties:[{role:'buyer',primaryClaim:buyerClaim},{role:'seller',primaryClaim:seller}],listingRef:pin,terms:{price:{amount:'1',currency:'DEM'}}};
 // Keep the fixture's Agreement hash consistent with the actual seller projection.
 return sellerRecordsPurchaseResolver({sessionOf:()=>({jobId:JOBS[0],agreement,agreementHash:contentHash(agreement),buyerBundle:{presentedBy:buyerClaim},agreementSignedProjection:{content:{network:sourceBinding.network,chainIdentity:sourceBinding.chainIdentity,data:['storageProgram',{metadata:{networkBinding:sourceBinding}}]}}}),buyerAccess:()=>({allowsWallet:()=>true}),now:()=>T0,
  observePayment:q=>({disposition:'absent',jobId:q.jobId,agreementHash:q.agreementHash,observedAt:q.observedAt})});
}

// The real seller projection of a job whose Agreement is still a proposal draft.
export function draftPurchaseResolver(){
 const draft={parties:[{role:'buyer',primaryClaim:buyer},{role:'seller',primaryClaim:seller}],listingRef:pin,terms:{price:{amount:'1',currency:'DEM'}}};
 return sellerRecordsPurchaseResolver({sessionOf:()=>({jobId:JOBS[0],proposal:{plan:{draft}},buyerBundle:{presentedBy:buyer}}),buyerAccess:()=>({allowsWallet:()=>true}),now:()=>T0,observePayment:()=>null});
}
