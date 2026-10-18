#!/usr/bin/env node
// Re-pin an explicitly staged package with reciprocal package-only controls.
// This tool never stages or commits.
//   node packages/dacs-client/scripts/pin-delta.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { publicationJson } from './publication-text.mjs';
import { git, pkg, prefix, blob } from './delta-map.mjs';
const record=JSON.parse(readFileSync(`${pkg}/HOLD.json`,'utf8'));
if(record.step1Freeze.schema!=='dacs-client-freeze/v3')throw new Error('expected the package-only v3 freeze record');
const files={};
for(const row of git('ls-files','--stage','--',prefix).split('\n')) {
  const match=/^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/.exec(row);
  if(!match)throw new Error(`not an ordinary staged file: ${row}`);
  const path=match[3].slice(prefix.length);
  if(blob(readFileSync(`${pkg}/${path}`))!==match[2])throw new Error(`${path}: stage the exact working bytes before re-pinning`);
  files[path]=path==='HOLD.json'?{control:'record'}:path==='scripts/check-hold.mjs'?{control:'gate',blob:'0'.repeat(40)}:{blob:match[2]};
}
record.step1Freeze.files=files;
if(process.argv.length!==2)throw new Error('package re-pin accepts no outside options');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=s=>createHash('sha256').update(s).digest('hex');
const normalizedBytes=publicationJson(record);
const gate=`${pkg}/scripts/check-hold.mjs`;
const text=readFileSync(gate,'utf8').replace(/holdSha256: "[a-f0-9]+"/,`holdSha256: "${hash(JSON.stringify(canonical(record)))}"`).replace(/holdBytesSha256: "[a-f0-9]+"/,`holdBytesSha256: "${hash(normalizedBytes)}"`);
writeFileSync(gate,text);
record.step1Freeze.files['scripts/check-hold.mjs'].blob=blob(Buffer.from(text));
writeFileSync(`${pkg}/HOLD.json`,publicationJson(record));
