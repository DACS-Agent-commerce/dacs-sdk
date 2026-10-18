#!/usr/bin/env node
// Re-pin an explicitly staged package with step 1's reciprocal v2 controls.
// This tool never stages or commits. Outside pins require a separate review.
//   node packages/dacs-client/scripts/pin-delta.mjs [--outside <reviewed path> ...] [--outside-base <commit>]
// Only explicitly named, already-pinned outside paths may be refreshed.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { publicationJson } from './publication-text.mjs';
import { git, pkg, prefix, blob } from './delta-map.mjs';
const record=JSON.parse(readFileSync(`${pkg}/HOLD.json`,'utf8'));
if(record.step1Freeze.schema!=='dacs-client-freeze/v2')throw new Error('expected the converged v2 freeze record');
const files={};
for(const row of git('ls-files','--stage','--',prefix).split('\n')) {
  const match=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(row);
  if(!match)throw new Error(`not an ordinary staged file: ${row}`);
  const path=match[3].slice(prefix.length);
  if(blob(readFileSync(`${pkg}/${path}`))!==match[2])throw new Error(`${path}: stage the exact working bytes before re-pinning`);
  files[path]=path==='HOLD.json'?{control:'record'}:path==='scripts/check-hold.mjs'?{control:'gate',blob:'0'.repeat(40)}:{blob:match[2]};
}
record.step1Freeze.files=files;
const args=process.argv.slice(2);
let outsideBase=null;
for(let i=0;i<args.length;i+=2) {
  const path=args[i+1];
  if(args[i]==='--outside-base') { outsideBase=git('rev-parse','--verify',`${path}^{commit}`); continue; }
  if(args[i]!=='--outside'||!Object.hasOwn(record.step1Freeze.outside.files,path))throw new Error('name an existing reviewed outside pin with --outside');
  const row=git('ls-files','--stage','--',path);
  const match=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(row);
  if(!match||match[3]!==path||blob(readFileSync(`${pkg}/../../${path}`))!==match[2])throw new Error(`${path}: stage the exact ordinary working file before re-pinning`);
  record.step1Freeze.outside.files[path].blob=match[2];
}
// A new citation head must contain the complete already-reviewed outside pins.
if(outsideBase!==null) {
  const snapshot={};
  for(const row of git('ls-tree','-r',outsideBase).split('\n')) {
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    const path=row.slice(row.indexOf('\t')+1);
    if(path.startsWith(prefix))continue;
    if(!match)throw new Error(`${path}: outside base contains a non-ordinary file`);
    snapshot[path]=match[2];
  }
  const pins=Object.fromEntries(Object.entries(record.step1Freeze.outside.files).map(([path,pin])=>[path,pin.blob]));
  if(JSON.stringify(Object.entries(snapshot).sort())!==JSON.stringify(Object.entries(pins).sort()))throw new Error('outside base must match the complete reviewed outside inventory');
  record.step1Freeze.outside.pinnedAt=outsideBase;
}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=s=>createHash('sha256').update(s).digest('hex');
const normalizedBytes=publicationJson(record);
const gate=`${pkg}/scripts/check-hold.mjs`;
const text=readFileSync(gate,'utf8').replace(/holdSha256: "[a-f0-9]+"/,`holdSha256: "${hash(JSON.stringify(canonical(record)))}"`).replace(/holdBytesSha256: "[a-f0-9]+"/,`holdBytesSha256: "${hash(normalizedBytes)}"`);
writeFileSync(gate,text);
record.step1Freeze.files['scripts/check-hold.mjs'].blob=blob(Buffer.from(text));
writeFileSync(`${pkg}/HOLD.json`,publicationJson(record));
