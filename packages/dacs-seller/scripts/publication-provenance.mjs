#!/usr/bin/env node
// Re-pin publication copies without changing their original source identities.
// node packages/dacs-seller/scripts/publication-provenance.mjs --write
// node packages/dacs-seller/scripts/publication-provenance.mjs --check
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ROOT,PKG,git} from './delta-map.mjs';
import {publicPath,redactText} from './lib/publication-text.mjs';
export const PUBLICATION_BASE='38d6fd7eb527e9aa2110e1c8c6f860bf53bcaea1';
export const PUBLICATION_SUBJECT='docs(seller): redact source copies for public distribution';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function publicationPins(){
 const paths=git('ls-tree','-r','--name-only',PUBLICATION_BASE,'--',...['src','test','port-sources'].map(p=>PKG+'/'+p)).toString().trim().split('\n');
 const files=[];
 for(const beforePath of paths){
  const bytes=git('cat-file','blob',`${PUBLICATION_BASE}:${beforePath}`);
  const path=publicPath(beforePath),published=Buffer.from(redactText(bytes.toString()));
  if(path===beforePath&&published.equals(bytes))continue;
  if(!existsSync(join(ROOT,path))||!readFileSync(join(ROOT,path)).equals(published))throw new Error(path+': differs from the deterministic publication redaction');
  if(path!==beforePath&&existsSync(join(ROOT,beforePath)))throw new Error(path+': original filename remains');
  files.push({path,originalSha256:sha(bytes),sha256:sha(published),reason:'redacted for publication'});
 }
 return {date:'2026-10-18',base:PUBLICATION_BASE,commit:PUBLICATION_SUBJECT,rule:'scripts/lib/publication-text.mjs',files};
}
export function checkPublication(manifest,{pending=null}={}){
 const pins=publicationPins();
 if(JSON.stringify(manifest.publication)!==JSON.stringify(pins))throw new Error('publication hashes or source identities differ; run publication-provenance.mjs --write');
 const subjects=git('log','--format=%s',`${PUBLICATION_BASE}..HEAD`).toString().trim().split('\n');
 if(subjects.filter(s=>s===PUBLICATION_SUBJECT).length!==(pending===PUBLICATION_SUBJECT?0:1))throw new Error('publication commit subject is absent or ambiguous');
 const records=new Map(pins.files.map(e=>[e.path,e]));
 const history=git('log','--format=%s',`${PUBLICATION_BASE}..HEAD`,'--',...['src','test','port-sources'].map(p=>PKG+'/'+p)).toString().trim().split('\n').filter(Boolean);
 if(history.some(s=>s!==PUBLICATION_SUBJECT))throw new Error('unrecorded publication source history');
 if(pending===PUBLICATION_SUBJECT){
  for(const e of pins.files)if(sha(git('show',`:${e.path}`))!==e.sha256)throw new Error(e.path+': publication bytes are not staged');
 }
 for(const oldPath of git('ls-tree','-r','--name-only',PUBLICATION_BASE,'--',...['src','test','port-sources'].map(p=>PKG+'/'+p)).toString().trim().split('\n')){
  const path=publicPath(oldPath),actual=readFileSync(join(ROOT,path));
  const expected=records.get(path)?.sha256??sha(git('cat-file','blob',`${PUBLICATION_BASE}:${oldPath}`));
  if(sha(actual)!==expected)throw new Error(path+': unrecorded publication change');
 }
 return `publication: ${pins.files.length} redacted copies match original bytes after the recorded transformation`;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{
  const path=join(ROOT,PKG,'PROVENANCE.json'),manifest=JSON.parse(readFileSync(path,'utf8')),pins=publicationPins();
  if(process.argv.includes('--write')){manifest.publication=pins;writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');console.log(`publication: re-pinned ${pins.files.length} redacted copies`);}
  else if(process.argv.includes('--check')){if(JSON.stringify(manifest.publication)!==JSON.stringify(pins))throw new Error('publication pins differ');console.log(`publication: ${pins.files.length} redacted copies verified`);}
  else throw new Error('use --write or --check');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
