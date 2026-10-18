#!/usr/bin/env node
// Check a clean checkout using only published, reachable history. Historical
// preparation subjects are metadata, not invented ancestry requirements.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {ROOT,PKG,BASE,publishedBaseline,update} from './delta-map.mjs';
import {checkPublication} from './publication-provenance.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
try{
 if(process.argv.length>2)throw new Error('this check validates published source pins only; historical upstream verification requires check-step1-provenance.mjs and its original source snapshot');
 const manifest=JSON.parse(readFileSync(join(ROOT,PKG,'PROVENANCE.json')));
 console.log(checkPublication(manifest));
 const maintenance=JSON.parse(readFileSync(join(ROOT,PKG,'MAINTENANCE.json')));
 if(maintenance.baseline!==BASE)throw new Error('maintenance baseline differs');
 const changes=new Map();
 for(const entry of maintenance.files){
  if(!entry.path.startsWith(PKG+'/')||entry.path.split('/').includes('..')||changes.has(entry.path)||!entry.reason)throw new Error('malformed maintenance entry');
  changes.set(entry.path,entry);
 }
 const snapshots=new Map(publishedBaseline().files.map(e=>[e.path,e.sha256]));
 const baseline=[...snapshots.keys()];
 const actual=[];
 const walk=rel=>{for(const name of readdirSync(join(ROOT,rel))){const path=rel+'/'+name,st=lstatSync(join(ROOT,path));if(st.isDirectory())walk(path);else if(st.isFile())actual.push(path);else throw new Error(path+': nonregular source');}};
 for(const dir of ['src','test','port-sources'])walk(PKG+'/'+dir);
 for(const path of new Set([...baseline,...actual])){
  const before=snapshots.get(path)??null;
  const after=existsSync(join(ROOT,path))?sha(readFileSync(join(ROOT,path))):null;
  const entry=changes.get(path);
  if(before===after){if(entry)throw new Error(path+': unnecessary maintenance override');continue;}
  if(!entry||entry.originalSha256!==before||entry.sha256!==after)throw new Error(path+': missing or incorrect maintenance hash');
 }
 for(const path of changes.keys())if(!baseline.includes(path)&&!actual.includes(path))throw new Error(path+': extraneous maintenance entry');
 console.log(update({check:true}));
 console.log(`check-provenance: ${actual.length} source files; ${changes.size} explicit maintenance changes; ok`);
}catch(error){console.error('FAIL '+error.message);process.exitCode=1;}
