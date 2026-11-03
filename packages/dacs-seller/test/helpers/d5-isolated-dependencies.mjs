// Explicit unit-test dependencies for the D5 vectors. Product files are loaded
// unchanged. Crypto, core primitives, SQLite, the policy/state implementations,
// claim and signature decoding, Listing signature verification, the stop flag
// and the session lifetime limit are the package's own modules. The fixtures
// left are collaborators these vectors isolate on purpose: fixture-shaped
// Listing terms and pins, the test anchor authority, the operator journal and
// buyer-access capabilities (not part of the package), the seller agent behind
// the route, the context source label and the seller-data envelope text.
import { registerHooks } from 'node:module';
const listing = new URL('../../src/dacs/listing.mjs', import.meta.url).href;
const sources = {
  '/src/dacs/fixture-anchors.mjs': `export {verifyFixtureRecord} from '${new URL('./local-anchor-fixture.mjs',import.meta.url).href}';`,
  '/src/wallet/durable-journal.mjs': `export const openDurableWalletJournal=()=>{throw new Error('D1 journal fixture cannot open journals')};`,
  '/src/dacs/seller-agent.mjs': `export class SellerAgentError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}`,
  '/src/dacs/agreement-context-consumer.mjs': `export const AGREEMENT_CONTEXT_SOURCE='d5-test-context/v1';`,
  '/src/dacs/listing.mjs': `export {canonicalize,contentHash,DEM_RAIL,verifyComponent} from '${listing}';
    export const purchaseSupport=l=>({supported:true,payee:l.payee,price:l.price});`,
  '/src/dacs/purchase-protocol.mjs': `export const listingPin=l=>l.pin; export const protocolSupport=()=>({supported:true,phases:{payment:2}});`,
  '/src/mcp/seller-content.mjs': `export const sellerData=s=>({text:JSON.stringify({sellerData:s})});`,
  '/src/devnet-demo/buyer-access.mjs': `export const operatorBuyerAccessConfig=value=>value;`,
  '/src/dacs/native-dem-delivery-consumer.mjs': `export const isProvenUnsignedAbsence=value=>value?.provenUnsigned===true; export const createNativeDemDeliveryCapability=value=>value;`,
};
const prefix = new URL('../../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if(specifier==='@kynesyslabs/dacs'&&context.parentURL?.endsWith('/src/devnet-demo/agreement-context.mjs')&&globalThis.__d5PartyVet){
      const source=`export * from '${new URL('../../../../dist/index.js',import.meta.url).href}'; export const partyVetCore=(...a)=>globalThis.__d5PartyVet(...a); export const verifyCompositeVerificationRecord=(...a)=>globalThis.__d5Strict(...a);`;
      return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
    }
    if (context.parentURL?.startsWith(prefix) && specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL).href;
      const entry = Object.entries(sources).find(([suffix])=>url.endsWith(suffix));
      if (entry) return {url:'data:text/javascript,'+encodeURIComponent(entry[1]),shortCircuit:true};
    }
    return next(specifier, context);
  },
});
