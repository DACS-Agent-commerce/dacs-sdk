import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { publishFileExclusive, syncDirectory } from './durable-file.mjs';
import { createSdkWalletSession, createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { claimForAddress } from '../wallet/demos-signature.mjs';
import { OPERATOR_CLOSING } from './operator-approval.mjs';

const FORMAT='dacs-node2-test-wallet/v1';
const SECRET_FORMAT='dacs-node2-operator-secret/v1';
const FILES=Object.freeze({buyer:'buyer-wallet.json',seller:'seller-wallet.json'});
const checkRole=(role)=>{if(!Object.hasOwn(FILES,role))throw new TypeError('wallet role must be buyer or seller');return role;};

async function privateDirectory(path){
  path=resolve(path);await mkdir(path,{recursive:true,mode:0o700});
  path=await realpath(path);const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new Error('operator custody directory must be a private real mode-0700 directory owned by this process user');
  // A prior attempt or another caller may have created private entries without
  // syncing them. Include their first non-private parent: mode-0700 mkdir cannot
  // have created that ancestor, so its own parent entry is outside this creation.
  for(let parent=dirname(path);;parent=dirname(parent)){
    await syncDirectory(parent);
    if(((await lstat(parent)).mode&0o077)!==0||dirname(parent)===parent)break;
  }
  return path;
}
async function exactPrivateFile(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid())||(await realpath(path))!==path)throw new Error('operator wallet files must be private real mode-0600 files owned by this process user');}

async function runtime(publicOrigin){
  globalThis.window??=globalThis;
  globalThis.document??={baseURI:`${publicOrigin}/portal/assets/embedded-wallet/`,currentScript:null,cookie:''};
  if(typeof globalThis.document.cookie!=='string')globalThis.document.cookie='';
  globalThis.location=new URL(publicOrigin);
  return import('../../public/portal/embedded-wallet/demos-runtime.mjs');
}

// The reservation is releasable through all read-only wallet checks. Once
// issuance starts, only verified inclusion or a definite refusal ends the hold.
// An approval that a shutdown ended (OPERATOR_CLOSING) was asked before
// anything was signed; the wallet reports any thrown approval as
// internal_error, so that request's answer becomes OPERATOR_CLOSING instead,
// which the caller keeps askable.
export function createOperatorApprovalAttempt(approve){
  const scope=new AsyncLocalStorage();
  return{
    approve:typeof approve==='function'?async(request)=>{
      let accepted;
      try{accepted=await approve(request);}
      catch(error){if(error?.code===OPERATOR_CLOSING){const attempt=scope.getStore();if(attempt)attempt.closing=true;}throw error;}
      if(accepted&&approve.settle)scope.getStore()?.requests.push(request);return accepted;
    }:approve,
    issuing(value){if(value?.stage==='broadcast-started'){const attempt=scope.getStore();if(attempt)attempt.sent=true;}},
    run(work){return scope.run({sent:false,closing:false,requests:[]},async()=>{
      const attempt=scope.getStore();let result;
      try{
        result=await work();
        if(attempt.closing&&!attempt.sent&&result?.success===false&&result.error?.code==='internal_error')
          return{success:false,data:null,error:{code:OPERATOR_CLOSING,message:'the operator is closing: the approval was not decided and nothing was signed'}};
        return result;
      }
      finally{
        const outcome=!attempt.sent?'released':result?.data?.writeProof?.disposition==='included'||result?.error?.code==='broadcast_rejected'?'spent':'unknown';
        for(const request of attempt.requests){
          try{await approve.settle(request,outcome);}
          catch(error){
            // Missing completion evidence keeps the hold. Preserve the wallet
            // outcome even if the operator's existing stderr channel also fails.
            try{process.stderr.write(`devnet-operator-approval-error:${error?.code??'failed'}:${String(error?.message??error).slice(0,200)}\n`);}catch{}
          }
        }
      }
    });},
  };
}

// Returns the record of a role file, or null when there is none. Throws when
// the file is not private or is not a whole record of this role.
async function readWalletRecord(path,role){
  let text;
  try{await exactPrivateFile(path);text=await readFile(path,'utf8');}
  catch(error){if(error?.code==='ENOENT')return null;throw error;}
  let record;
  try{record=JSON.parse(text);}catch(cause){throw new Error(`the ${role} custody record is malformed`,{cause});}
  if(record?.format!==FORMAT||record.role!==role||typeof record.address!=='string'||typeof record.mnemonic!=='string')throw new Error(`the ${role} custody record is malformed`);
  return record;
}
// A zero-byte role file holds no secret: only the earlier bootstrap, which wrote in place, left one.
async function removeEmptyFile(path){
  const info=await lstat(path).catch((error)=>{if(error?.code==='ENOENT')return null;throw error;});
  if(info?.isFile()&&info.size===0)await unlink(path);
}
async function generateWallet(Demos,role){
  const mnemonic=new Demos().newMnemonic(256);const wallet=new Demos();await wallet.connectWallet(mnemonic,{algorithm:'ed25519'});
  const address=String(wallet.getAddress()).toLowerCase();wallet.disconnect();
  return{address,text:`${JSON.stringify({format:FORMAT,role,address,mnemonic,createdAt:new Date().toISOString()})}\n`};
}
// Keeps the role's whole file, or publishes a new one whole. When another
// writer published first, that file wins and is read back.
async function ensureWallet({directory,role,Demos}){
  const path=join(directory,FILES[role]);
  await removeEmptyFile(path);
  let address=(await readWalletRecord(path,role))?.address;
  if(address===undefined){
    const generated=await generateWallet(Demos,role);
    address=await publishFileExclusive(path,generated.text)?generated.address:(await readWalletRecord(path,role))?.address;
    if(address===undefined)throw new Error(`the ${role} custody record disappeared during bootstrap`);
  }
  return Object.freeze({role,address,claim:claimForAddress(address),path});
}

/**
 * Makes the buyer and seller test wallet files in a private custody directory.
 * Each file is published whole (synced temporary file, then a link) and the
 * directory, its private ancestors and their containing parent are synced before
 * this returns. A role file that is already there is kept as it is, so a run
 * that stopped between the two files, or a repeat, ends
 * with the same pair and never replaces a mnemonic. Returns the directory and
 * both wallets (role, address, claim, path); recovery phrases are not returned.
 * Throws on directory sync failure or when a role file exists but is not a
 * private, whole record of its role.
 */
export async function bootstrapTestWalletCustody({directory,publicOrigin}){
  directory=await privateDirectory(directory);const {Demos}=await runtime(publicOrigin);const wallets=[];
  for(const role of ['buyer','seller'])wallets.push(await ensureWallet({directory,role,Demos}));
  await syncDirectory(directory);
  return Object.freeze({directory,wallets,note:'Recovery phrases remain only in the named mode-0600 files and were not returned.'});
}

// inProcessRelay(address), optional, returns {run(work)}: every request of
// this wallet runs inside it (the operator seller's in-process source relay).
// Private custody ancestors and their parent are synced before opening; failures throw.
export async function openTestWalletCustody({directory,role,publicOrigin,transactionTransport,anchorJournal,approve,inProcessRelay=null}){
  role=checkRole(role);directory=await privateDirectory(directory);const path=join(directory,FILES[role]);await exactPrivateFile(path);
  const record=await readWalletRecord(path,role);
  if(record===null)throw new Error(`the ${role} custody record is missing`);
  const {Demos,Identities,validateMnemonic}=await runtime(publicOrigin);
  let mnemonic=record.mnemonic;const probe=new Demos();await probe.connectWallet(mnemonic,{algorithm:'ed25519'});const address=String(probe.getAddress()).toLowerCase();
  const privateBytes=Buffer.from(probe.keypair.privateKey);probe.disconnect();
  if(address!==record.address||privateBytes.length<32)throw new Error(`the ${role} custody public account differs from its retained record`);
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),privateBytes.subarray(0,32)]),format:'der',type:'pkcs8'});privateBytes.fill(0);
  const signer=Object.freeze({address,claim:claimForAddress(address),signBytes:(bytes)=>sign(null,Buffer.from(bytes),key)});
  let wallet=null,walletFactory=null,session=null;
  if(transactionTransport){
    const journalShape=(candidate)=>candidate&&['get','put','withWalletLock'].every((name)=>typeof candidate[name]==='function');
    const defaultJournal=journalShape(anchorJournal)?anchorJournal:null;
    const journalRoute=new AsyncLocalStorage(),approvalAttempt=createOperatorApprovalAttempt(approve);let requestTail=Promise.resolve();
    const relay=inProcessRelay?inProcessRelay(address):null,routed=(work)=>relay?relay.run(work):work();
    const route=()=>{const current=journalRoute.getStore()??defaultJournal;if(!current)throw new Error(`${role} packaged wallet journal route is not attached`);return current;};
    const routedJournal=defaultJournal?{
      get:(key)=>route().get(key),
      put:(key,value)=>{
        // From this durable issuance marker onward a write may reach the node.
        // Earlier failures, including nonce/network checks, provably sent nothing.
        approvalAttempt.issuing(value);
        return route().put(key,value);
      },
      withWalletLock:(key,work)=>route().withWalletLock(key,work),
    }:undefined;
    session=createSdkWalletSession({DemosCtor:Demos,IdentitiesCtor:Identities,validateMnemonic,transactionTransport:createDevnetAgreementWalletTransport(transactionTransport),anchorJournal:routedJournal,approve:approvalAttempt.approve});
    await session.importMnemonic(mnemonic);if(session.getPublicAccount()?.address!==address)throw new Error(`${role} packaged wallet address differs from custody`);
    const facade=(selectedJournal)=>Object.freeze({
      getPublicAccount:()=>session.getPublicAccount(),
      getWriteProfile:()=>session.getWriteProfile(),
      request:(input)=>{
        const run=requestTail.then(()=>journalRoute.run(selectedJournal,()=>routed(()=>approvalAttempt.run(()=>session.request(input)))));
        requestTail=run.then(()=>undefined,()=>undefined);return run;
      },
      lock:()=>session.lock(),
      isLocked:()=>session.isLocked(),
    });
    wallet=facade(defaultJournal);
    if(defaultJournal)walletFactory=({anchorJournal:next}={})=>{if(!journalShape(next))throw new TypeError('packaged wallet factory requires an explicit atomic anchor journal');return facade(next);};
  }
  mnemonic=null;record.mnemonic=null;
  return Object.freeze({role,path,signer,wallet,walletFactory,close(){session?.lock();}});
}

// Returns the stored cookie key, or null when there is no secret file yet.
async function readOperatorSecret(path){
  try{await exactPrivateFile(path);const value=JSON.parse(await readFile(path,'utf8'));if(value?.format!==SECRET_FORMAT||typeof value.cookieKey!=='string'||value.cookieKey.length<43)throw new Error('operator secret record is malformed');return value.cookieKey;}
  catch(error){if(error.code!=='ENOENT')throw error;return null;}
}

/**
 * Returns the operator's cookie key from `app-secret.json` in the custody directory,
 * creating the file first when it is missing. A new file is published whole and synced
 * with its directory before the key is returned; when another writer publishes first,
 * that writer's key is returned. Throws when the stored record is not private or is malformed.
 * Private custody ancestors and their parent are synced on every call, including
 * repeats; an open or sync failure throws.
 */
export async function ensureOperatorSecret({directory}){
  directory=await privateDirectory(directory);const path=join(directory,'app-secret.json');
  const stored=await readOperatorSecret(path);if(stored!==null)return stored;
  const value={format:SECRET_FORMAT,cookieKey:randomBytes(32).toString('base64url')};
  if(await publishFileExclusive(path,`${JSON.stringify(value)}\n`))return value.cookieKey;
  const winner=await readOperatorSecret(path);
  if(winner===null)throw new Error('operator secret disappeared during initialization');
  return winner;
}
