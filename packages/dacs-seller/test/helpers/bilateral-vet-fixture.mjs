import { productionFixture, recordFor as makeRecord } from './vet-production-fixture.mjs';
import { buyer, seller, NOW } from './protocol-fixture.mjs';
import { createDevnetDemoAgreementContextProvider } from '../../src/devnet-demo/agreement-context.mjs';
export const T=NOW,JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
export const recordFor=(input,signer,decision)=>makeRecord(input,{...signer,signBytes:signer.signBytes??signer.sign},decision);
export function fixture(options={}){
 const f=productionFixture(options);
 return {...f,buyer:{...buyer,sign:buyer.signBytes},seller:{...seller,sign:seller.signBytes},store:f.base,records:f.local.rows,
  provider:()=>{const p=createDevnetDemoAgreementContextProvider(f.config);return{...p,resolveBuyer:(input,options={writable:()=>true})=>p.resolveBuyer(input,options)};},input:(jobId=JOBS[0])=>f.input(jobId)};
}
