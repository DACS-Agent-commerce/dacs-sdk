// Setup only: pack current sources and install a graph derived from the root lock.
import {createHash,randomBytes}from'node:crypto';
import {execFileSync}from'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync}from'node:fs';
import {basename,dirname,join,resolve}from'node:path';
import {fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const defaultSellerConsumer=join(root,'..','.fix-tmp','seller-consumer');
// Bind prepared artifacts to the exact source, built core and dependency lock.
export function sellerSourceFingerprint(){
 const manifest=json(join(root,'packages/dacs-seller/package.json')),files=['package.json','package-lock.json','packages/dacs-seller/test/helpers/installed-seller-host.mjs',...['package.json','README.md','LICENSE',...manifest.files].map(file=>'packages/dacs-seller/'+file)];
 const walk=dir=>{for(const entry of readdirSync(join(root,dir),{withFileTypes:true})){const file=dir+'/'+entry.name;if(entry.isDirectory())walk(file);else files.push(file);}};walk('dist');
 const hash=createHash('sha256');for(const file of files.sort())hash.update(file).update('\0').update(readFileSync(join(root,file)));return hash.digest('hex');
}
function required(node){return{...node.dependencies,...node.optionalDependencies,...Object.fromEntries(Object.entries(node.peerDependencies??{}).filter(([name])=>!node.peerDependenciesMeta?.[name]?.optional))};}
function packageEntry(manifest,pack){
 const entry={version:manifest.version,resolved:'file:'+pack.filename,integrity:pack.integrity};
 for(const key of ['license','dependencies','optionalDependencies','peerDependencies','peerDependenciesMeta','engines','bin'])if(manifest[key])entry[key]=manifest[key];return entry;
}
// Preserve exact versions, locations and integrity; never resolve a fresh range.
function consumerLock(lock,manifest,core,seller,corePack,sellerPack){
 const selected={'':{name:manifest.name,version:manifest.version,dependencies:manifest.dependencies},'node_modules/@kynesyslabs/dacs':packageEntry(core,corePack),'node_modules/@kynesyslabs/dacs-seller':packageEntry(seller,sellerPack)},queue=Object.keys(selected).filter(Boolean);
 for(let index=0;index<queue.length;index++){
  const parent=queue[index];for(const name of Object.keys(required(selected[parent]))){
   let at=parent,key;for(;;){const candidate=(at?at+'/':'')+'node_modules/'+name;if(selected[candidate]||lock.packages[candidate]){key=candidate;break;}const cut=at.lastIndexOf('/node_modules/');if(!at)break;at=cut<0?'':at.slice(0,cut);}
   if(!key)throw new Error('root lock lacks production dependency '+name+' of '+parent);
   if(selected[key])continue;
   const entry=structuredClone(lock.packages[key]);if(entry.link||!entry.integrity||!entry.resolved)throw new Error('production dependency is not pinned: '+key);
   delete entry.dev;delete entry.devOptional;delete entry.optional;selected[key]=entry;queue.push(key);
  }
 }
 return{name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages:Object.fromEntries(Object.entries(selected).sort(([a],[b])=>a.localeCompare(b)))};
}
// A finished setup for these exact sources and this exact lock.
function preparedAt(directory,fingerprint){
 try{const marker=json(join(directory,'prepared.json'));
  return marker.sourceFingerprint===fingerprint&&marker.lockDigest===digest(readFileSync(join(directory,'package-lock.json')))&&existsSync(join(directory,'run.mjs'))&&existsSync(join(directory,'node_modules/@kynesyslabs/dacs-seller/package.json'))&&existsSync(join(directory,'node_modules/@kynesyslabs/dacs/package.json'));}catch{return false;}
}
// A directory this script completed or was interrupted while preparing.
function ourSetup(directory){
 if(existsSync(join(directory,'prepared.json')))return true;
 try{return json(join(directory,'package.json')).name==='dacs-seller-locked-smoke';}catch{return false;}
}
function install(app,fingerprint){
 const cache=join(app,'.npm-cache'),env={...process.env,NPM_CONFIG_CACHE:cache,npm_config_cache:cache};
 const npm=(args,cwd)=>execFileSync('npm',args,{cwd,env,encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024});
 const core=json(join(root,'package.json')),seller=json(join(root,'packages/dacs-seller/package.json')),lock=json(join(root,'package-lock.json'));
 const [corePack]=JSON.parse(npm(['pack','--json','--ignore-scripts','--pack-destination',app],root));
 const [sellerPack]=JSON.parse(npm(['pack','--json','--ignore-scripts','--pack-destination',app,'--workspace',seller.name],root));
 const manifest={name:'dacs-seller-locked-smoke',version:'1.0.0',private:true,type:'module',dependencies:{[core.name]:'file:'+corePack.filename,[seller.name]:'file:'+sellerPack.filename}};
 writeFileSync(join(app,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 const text=JSON.stringify(consumerLock(lock,manifest,core,seller,corePack,sellerPack),null,2)+'\n';writeFileSync(join(app,'package-lock.json'),text);
 // Native dependency installation belongs to setup; scripts must run here.
 npm(['ci','--no-audit','--no-fund','--omit=optional','--foreground-scripts'],app);
 if(digest(readFileSync(join(app,'package-lock.json')))!==digest(text))throw new Error('consumer install changed the pinned graph');
 copyFileSync(join(root,'packages/dacs-seller/test/helpers/installed-seller-host.mjs'),join(app,'run.mjs'));
 writeFileSync(join(app,'prepared.json'),JSON.stringify({sourceFingerprint:fingerprint,lockDigest:digest(text),corePack,sellerPack},null,2)+'\n');
}
function prepare(directory){
 const app=resolve(directory??defaultSellerConsumer);mkdirSync(dirname(app),{recursive:true});
 const fingerprint=sellerSourceFingerprint(),reused='Prepared locked seller consumer: '+app+' (reused existing setup)\n';
 // Reuse a finished setup; never rebuild one that already matches these sources.
 if(preparedAt(app,fingerprint)){process.stdout.write(reused);return;}
 // Build beside the target, so a crash never leaves a directory that looks prepared.
 const staging=join(dirname(app),'.'+basename(app)+'.staging-'+process.pid+'-'+randomBytes(6).toString('hex'));
 mkdirSync(staging);
 try{
  install(staging,fingerprint);
  try{renameSync(staging,app);}
  catch(error){
   // Another run may have finished the same setup while this one was building.
   if(preparedAt(app,fingerprint)){rmSync(staging,{recursive:true,force:true});process.stdout.write(reused);return;}
   if(!ourSetup(app))throw new Error('refusing to replace '+app+': it exists and is not a seller consumer setup',{cause:error});
   // An interrupted or outdated setup of ours: swap in the complete one.
   const stale=staging+'.replaced';
   try{renameSync(app,stale);}catch(replaceError){if(preparedAt(app,fingerprint)){rmSync(staging,{recursive:true,force:true});process.stdout.write(reused);return;}throw replaceError;}
   try{renameSync(staging,app);}catch(inner){renameSync(stale,app);throw inner;}
   rmSync(stale,{recursive:true,force:true});
  }
 }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
 process.stdout.write('Prepared locked seller consumer: '+app+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))prepare(process.argv[2]);
