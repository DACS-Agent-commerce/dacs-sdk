#!/usr/bin/env node
// Validate the published source snapshot from reachable repository history.
// Original upstream identities remain immutable in PROVENANCE.json.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ROOT,PKG,BASE,BASELINE_SHA256,publishedBaseline} from './delta-map.mjs';
export const PUBLICATION_BASE=BASE;
const sha=b=>createHash('sha256').update(b).digest('hex');
export function checkPublication(manifest){
 if(sha(readFileSync(join(ROOT,PKG,'PUBLISHED-BASELINE.json')))!==BASELINE_SHA256)throw new Error('published baseline pins changed');
 const baseline=publishedBaseline();
 if(baseline.publishedCommit!==BASE)throw new Error('published baseline commit differs');
 if(sha(readFileSync(join(ROOT,PKG,'PROVENANCE.json')))!==baseline.originalManifestSha256)throw new Error('original source manifest was changed');
 const pins=new Map(manifest.files.map(e=>[e.path,e.sha256]));
 for(const e of manifest.deltas.files) {if(e.deleted)pins.delete(e.path);else pins.set(e.path,e.sha256);}
 for(const e of manifest.publication.files)pins.set(e.path,e.sha256);
 const snapshots=new Map(baseline.files.map(e=>[e.path,e.sha256]));
 if(snapshots.size!==pins.size)throw new Error('published baseline file set differs');
 for(const [path,hash] of pins)if(snapshots.get(path)!==hash)throw new Error(path+': published baseline hash differs');
 return `publication: ${pins.size} published hashes verified at ${BASE}; original upstream pins retained`;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(!process.argv.includes('--check'))throw new Error('use --check; original publication pins are immutable');console.log(checkPublication(JSON.parse(readFileSync(join(ROOT,PKG,'PROVENANCE.json')))));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
