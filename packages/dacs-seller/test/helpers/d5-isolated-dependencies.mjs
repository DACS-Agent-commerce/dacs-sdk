// Explicit unit-test dependencies for modules whose import cuts belong to D1.
// Product files are loaded unchanged. Crypto, core primitives, SQLite and the
// policy/state implementations are real; only absent host/shared modules are fixtures.
import { registerHooks } from 'node:module';
const sources = {
  '/src/dacs/fixture-anchors.mjs': `export const verifyFixtureRecord=()=>{throw new Error('fixture anchor read not requested by this isolated test')};`,
  '/src/devnet-demo/stop-request.mjs': `export const stopRequested=()=>false; export const stopSignal=new AbortController().signal;`,
  '/src/wallet/demos-signature.mjs': `export const addressForClaim=c=>'0x'+c.slice('did:demos:agent:'.length); export const decodeSignature=s=>Buffer.from(s,/^(?:0x)?[a-f0-9]{128}$/i.test(s)?'hex':'base64url');`,
  '/src/wallet/durable-journal.mjs': `export const openDurableWalletJournal=()=>{throw new Error('D1 journal fixture cannot open journals')};`,
  '/src/public/portal/seller-session-limits.mjs': `export const assertSellerSessionLifetime=()=>{};`,
  '/public/portal/seller-session-limits.mjs': `export const assertSellerSessionLifetime=()=>{};`,
  '/src/dacs/seller-agent.mjs': `export class SellerAgentError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}`,
  '/src/dacs/agreement-context-consumer.mjs': `export const AGREEMENT_CONTEXT_SOURCE='d5-test-context/v1';`,
  '/src/dacs/listing.mjs': `import {canonicalize,contentHash} from '${new URL('../../../../dist/index.js', import.meta.url).href}';
    import {createPublicKey,verify} from 'node:crypto';
    export {canonicalize,contentHash}; export const DEM_RAIL={railId:'demos-native:DEM',railVersion:1};
    export const purchaseSupport=l=>({supported:true,payee:l.payee,price:l.price});
    export const verifyComponent=({signedBytes,signature})=>{try{return verify(null,signedBytes,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(signature.signer.slice(16),'hex')]),format:'der',type:'spki'}),Buffer.from(signature.value,'base64url'))}catch{return false}};`,
  '/src/dacs/purchase-protocol.mjs': `export const listingPin=l=>l.pin; export const protocolSupport=()=>({supported:true,phases:{payment:2}});`,
  '/src/mcp/seller-content.mjs': `export const sellerData=s=>({text:JSON.stringify({sellerData:s})});`,
  '/src/operations.mjs': `export class OperationError extends Error{constructor(code,message){super(message);this.code=code}}`,
  '/src/devnet-demo/buyer-access.mjs': `export const operatorBuyerAccessConfig=value=>value;`,
  '/src/dacs/native-dem-delivery-consumer.mjs': `export const isProvenUnsignedAbsence=value=>value?.provenUnsigned===true;`,
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
