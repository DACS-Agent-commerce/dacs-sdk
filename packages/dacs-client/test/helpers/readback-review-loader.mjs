// Test-only transport substitutions; module.register works at both engine floors.
const moduleAt=name=>new URL('../../src/'+name,import.meta.url).href;
const fake=source=>({url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true});
export async function resolve(specifier,context,next){
 // Exercise retained-state reducers behind the unconditional production action
 // hold. The separate sweep-contracts tests pin that real hold and zero effects.
 if(specifier.endsWith('/action-admission.mjs'))return fake('export const assertPurchaseActionsAdmitted=()=>{};');
  if(specifier.endsWith('/demos-sr2-adapter.mjs') && !context.parentURL?.endsWith('readback-review-decisions.test.mjs'))return fake(`export * from ${JSON.stringify(moduleAt('dacs/demos-sr2-adapter.mjs')+'?actual')}; export const createDemosSr2Adapter=()=>globalThis[Symbol.for('d15.review.readers')].adapter;`);
  if(specifier.endsWith('/seller-http.mjs') && context.parentURL===moduleAt('dacs/protocol-purchases.mjs'))return fake(`export * from ${JSON.stringify(moduleAt('dacs/seller-http.mjs')+'?actual')}; export const createSellerAgentClient=()=>globalThis[Symbol.for('d15.review.readers')].seller;`);
  if(specifier.endsWith('/purchase-protocol.mjs') && context.parentURL===moduleAt('dacs/protocol-purchases.mjs'))return fake(`export * from ${JSON.stringify(moduleAt('dacs/purchase-protocol.mjs')+'?actual')}; export const exchangeAgreement=async()=>globalThis[Symbol.for('d15.review.readers')].anchored;`);
  if(specifier.endsWith('/dacs/chain.mjs') && context.parentURL===moduleAt('wallet/devnet-native-transport.mjs'))return fake(`export * from ${JSON.stringify(moduleAt('dacs/chain.mjs')+'?actual')}; export const createDemosChainReader=()=>({observeTransfer:async hash=>globalThis[Symbol.for('d15.review.readers')].observeTransfer(hash)});`);
  if(specifier==='@kynesyslabs/dacs' && context.parentURL===moduleAt('dacs/native-payment-evidence-consumer.mjs')){
    const real=await next(specifier,context);
    return fake(`export * from ${JSON.stringify(real.url)}; export const verifySettlementEvidence=async()=>({decision:'pass'});`);
  }
  return next(specifier,context);
}
