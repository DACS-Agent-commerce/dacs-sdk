#!/usr/bin/env node
// The step-1 manifest is immutable. D5 hashes, source ranges and named commits
// extend it; changing the old hashes cannot legitimize a changed copy.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {ROOT,PKG,BASE,git,update} from './delta-map.mjs';
import {originalPath,redactText} from './lib/publication-text.mjs';
import {PUBLICATION_BASE,checkPublication} from './publication-provenance.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const failures=[];const fail=m=>failures.push(m);
let source=null,pending=null;
for(let i=2;i<process.argv.length;i++){const arg=process.argv[i];if(arg==='--source')source=process.argv[++i];else if(arg==='--pending')pending=process.argv[++i];else throw new Error('unknown argument '+arg);}
try{
 const baseline=JSON.parse(git('show',`${BASE}:${PKG}/PROVENANCE.json`));
 const current=JSON.parse(readFileSync(join(ROOT,PKG,'PROVENANCE.json'),'utf8'));
 const {deltas,publication,...pinned}=current;
 const publishedBaseline=JSON.parse(redactText(JSON.stringify(baseline)));
 const publicHashes=new Map((publication?.files??[]).map(e=>[e.path,e.sha256]));
 process.stdout.write(checkPublication(current,{pending})+'\n');
 const originalDeltas=JSON.parse(redactText(git('show',`${PUBLICATION_BASE}:${PKG}/PROVENANCE.json`).toString())).deltas;
 if(JSON.stringify(deltas)!==JSON.stringify(originalDeltas))fail('original D5 records changed beyond publication redactions');
 if(JSON.stringify(pinned)!==JSON.stringify(publishedBaseline))fail('step-1 pinned manifest records changed');
 if(deltas?.baseline!==git('rev-parse',BASE).toString().trim())fail('D5 baseline differs from step 1');
 // Run the original exact-copy and source-plan check against the actual step-1 git tree.
 const scratch=mkdtempSync(join(tmpdir(),'dacs-step1-'));
 try{
  const put=(path,bytes)=>{mkdirSync(dirname(join(scratch,path)),{recursive:true});writeFileSync(join(scratch,path),bytes)};
  put(`${PKG}/PROVENANCE.json`,JSON.stringify(baseline));
  for(const e of baseline.files)put(e.path,git('cat-file','blob',`${BASE}:${e.path}`));
  const args=[join(ROOT,PKG,'scripts/check-step1-provenance.mjs'),'--root',scratch,...(source?['--source',source]:[])];
  const result=execFileSync(process.execPath,args,{encoding:'utf8',maxBuffer:16*1024*1024});process.stdout.write('step1 @ '+git('rev-parse',BASE).toString().trim()+'\n'+result);
 }finally{rmSync(scratch,{recursive:true,force:true})}
 const changes=new Map();
 const subjects=new Map((deltas?.commits??[]).map(c=>[c.id,c.subject]));
 if(new Set(subjects.values()).size!==subjects.size)fail('duplicate commit subjects');
 const commitSubjects=git('log','--format=%s',`${BASE}..${PUBLICATION_BASE}`).toString().split('\n');
 if(pending&&commitSubjects.includes(pending))fail('--pending must name a new commit, not an existing subject');
 for(const subject of subjects.values()){
  const count=commitSubjects.filter(s=>s===subject).length;
  if(count!==1&&!(count===0&&pending===subject))fail('delta commit subject is absent or ambiguous: '+subject);
 }

 for(const e of deltas?.files??[]){
  if(changes.has(e.path))fail(e.path+': duplicate D5 entry');changes.set(e.path,e);
  if(!e.path.startsWith(PKG+'/')||e.path.split('/').includes('..')||!e.reason||e.delta!=='D5')fail(e.path+': malformed D5 entry');
  const listed=(e.commits??[]).map(id=>subjects.get(id));if(listed.some(s=>!s?.startsWith('delta(seller): D5')))fail(e.path+': unnamed delta commit');
  const history=git('log','--format=%H%x09%s',`${BASE}..${PUBLICATION_BASE}`,'--',originalPath(e.path)).toString().trim().split('\n').filter(Boolean);
  for(const row of history){const [hash,subject]=row.split('\t');if(!listed.includes(subject))fail(`${e.path}: change ${hash} is not enumerated`);}
  const atHead=(()=>{try{return sha(execFileSync('git',['-C',ROOT,'cat-file','blob',`HEAD:${e.path}`],{stdio:['ignore','pipe','pipe']}))}catch{return null}})();
  const actual=existsSync(join(ROOT,e.path))?sha(readFileSync(join(ROOT,e.path))):null;
  if(e.deleted?actual!==null:actual!==(publicHashes.get(e.path)??e.sha256))fail(e.path+': current hash differs from D5 record');
  if(actual!==atHead){
   if(!pending||!(listed.includes(pending)||(publicHashes.has(e.path)&&pending===publication.commit)))fail(e.path+': uncommitted change lacks --pending named commit');
   else {try{if(sha(git('show',`:${e.path}`))!==actual)fail(e.path+': pending bytes are not staged')}catch{if(!e.deleted)fail(e.path+': pending file is not staged')}}
  }
  for(const supplied of e.supplied??[]){
   if(supplied.sourcePath){
    if(!source){if(!/^[a-f0-9]{40}$/.test(supplied.sourceCommit)||!/^[a-f0-9]{40}$/.test(supplied.sourceBlob))fail(e.path+': malformed supplemental source identity');continue;}
    const external=execFileSync('git',['-C',source,'cat-file','blob',supplied.sourceCommit+':'+originalPath(supplied.sourcePath)]);
    const blob=execFileSync('git',['-C',source,'rev-parse',supplied.sourceCommit+':'+originalPath(supplied.sourcePath)],{encoding:'utf8'}).trim();
    const target=readFileSync(join(ROOT,e.path),'utf8').split('\n'),[a,b]=supplied.lines,[x,y]=supplied.target;
    if(blob!==supplied.sourceBlob||redactText(external.toString()).split('\n').slice(a-1,b).join('\n')!==target.slice(x-1,y).join('\n'))fail(e.path+': supplemental source range differs');
    continue;
   }
   const origin=publishedBaseline.files.find(b=>b.path===supplied.path&&b.role==='port-source');
   if(!origin) {fail(e.path+': supplied file is not a pinned port source');continue;}
   const bytes=redactText(git('cat-file','blob',`${BASE}:${originalPath(origin.path)}`).toString()).split('\n'),target=readFileSync(join(ROOT,e.path),'utf8').split('\n');
   const [a,b]=supplied.lines,[x,y]=supplied.target;
   if(![a,b,x,y].every(Number.isSafeInteger)||a<1||b<a||x<1||y<x||b>bytes.length||y>target.length||bytes.slice(a-1,b).join('\n')!==target.slice(x-1,y).join('\n'))fail(e.path+': supplied lines do not match pinned source');
  }
 }
 const listed=new Set([...publishedBaseline.files.map(e=>e.path),...changes.keys()]);let hashes=0;
 for(const e of publishedBaseline.files){
  if(changes.has(e.path))continue;
  if(!existsSync(join(ROOT,e.path))||!lstatSync(join(ROOT,e.path)).isFile()||sha(readFileSync(join(ROOT,e.path)))!==(publicHashes.get(e.path)??e.sha256))fail(e.path+': original changed without a named delta');else hashes++;
  const history=git('log','--format=%H',`${BASE}..${PUBLICATION_BASE}`,'--',originalPath(e.path)).toString().trim();if(history)fail(e.path+': history changed without a named delta');
 }
 function walk(dir){for(const name of readdirSync(join(ROOT,dir))){const p=dir+'/'+name,st=lstatSync(join(ROOT,p));if(st.isDirectory())walk(p);else if(!st.isFile()||!listed.has(p))fail(p+': unlisted or non-regular file');}}
 for(const dir of ['src','test','port-sources'])walk(PKG+'/'+dir);
 process.stdout.write(`current: ${hashes} original pins outside D5; ${changes.size} enumerated D5 files\n`);
 process.stdout.write(update({check:true})+'\n');
 process.stdout.write(execFileSync(process.execPath,[join(ROOT,PKG,'scripts/superseded-tests.mjs'),'--check'],{encoding:'utf8'}));
 if(failures.length)throw new Error(failures.join('\n'));
 if(!source)console.log('supplemental source ranges: not checked (use --source); pinned port-source ranges match');
 console.log('delta history: every copied-file change is in its named commit; supplied ranges match');console.log('check-provenance: ok');
}catch(error){console.error('FAIL '+error.message);process.exitCode=1;}
