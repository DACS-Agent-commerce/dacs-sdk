#!/usr/bin/env node
// Render the per-file delta table from pinned git blobs and the current tree.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {originalPath,redactText} from './lib/publication-text.mjs';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const PKG='packages/dacs-seller';
export const BASE='28d27ed';
export const git=(...args)=>execFileSync('git',['-C',ROOT,...args],{maxBuffer:64*1024*1024});
const code=s=>'`'+String(s).replaceAll('`',"'").replaceAll('|','\\|')+'`';
function coordinates(entry) {
 const anchors = {
  'seller-transport-auth.mjs': ['issueContextChallenge(', 'attemptContextPresentation(', 'reserve(p,', 'const reclaimable'],
  'seller-context-route.mjs': ['challenge:', 'reserve:', 'store.classify(request, body, { admit:', 'async reconcile(', 'resume:'],
  'seller-http.mjs': ['export function createSellerHttpHandler', 'if (contextChallenge)', "answer?.code !== 'party_vet_non_pass'"],
  'agreement-context.mjs': ['const SELLER_REQUIREMENT', 'const nonPass', 'async function produce', 'async function recoverBuyer', 'async function resumableBuyer'],
  'operator-approval.mjs': ['export function composeSellerApproval', 'export function createSellerContextAdmission'],
  'seller-proposal-time.mjs': ['export function proposalTimeProblem'],
  'artifact-anchor.mjs': ['async function closingAbsence'],
  'seller-issuance.mjs': ['export async function sellerJournalIssuance', 'export async function openSellerIssuanceJournals'],
  'seller-purchase-source.mjs': ['export function sellerRecordsPurchaseResolver', 'export function sellerHeldEvidenceJobs'],
  'seller-state-lock.mjs': ['export async function acquireSellerStateLock'],
  'seller-agent.mjs': ['proposalTimeProblem({ generatedAt,', 'durableSessionOf:'],
 };
 const text = existsSync(join(ROOT, entry.path)) ? readFileSync(join(ROOT, entry.path), 'utf8').split('\n') : [];
 const name = entry.path.split('/').at(-1), needles = anchors[name];
 let lines = name.endsWith('.test.mjs') ? [text.findIndex(line => /\btest\(/.test(line)) + 1].filter(n => n > 0) : needles?.map(needle => text.findIndex(line => line.includes(needle)) + 1).filter(n => n > 0);
 if (!lines?.length) {
  const index = text.findIndex(line => /^(export (async )?function|export const|test\(|async function|function |const |let |class |## )/.test(line.trimStart()));
  lines = [index >= 0 ? index + 1 : 1];
 }
 return lines.map(line => code(entry.path.replace(PKG+'/', '')+':'+line)).join('<br>');
}
export function render(manifest){
 const baseline=JSON.parse(redactText(git('show',`${BASE}:${PKG}/PROVENANCE.json`).toString()));
 const delta=new Map((manifest.deltas?.files??[]).map(e=>[e.path,e]));
 const supplies=new Map();
 for(const entry of delta.values())for(const s of entry.supplied??[]){if(!s.path)continue;const targets=supplies.get(s.path)??[];targets.push(`${entry.path.replace(PKG+'/','')}:${s.target.join('-')} ← ${s.lines.join('-')}`);supplies.set(s.path,targets);}
 const rows=['<!-- BEGIN GENERATED: scripts/delta-map.mjs -->','| D5 file:line | Change and reason | Named commits |','| --- | --- | --- |',...[(manifest.deltas?.files??[]),(manifest.deltas?.support??[])].flat().map(e=>`| ${coordinates(e)} | ${e.reason} | ${(e.commits??['port']).join(', ')} |`),'',
 '| File | Source path @ commit | Source blob | Status | Current blob | Supplied lines (target ← source) |',
 '| --- | --- | --- | --- | --- | --- |'];
 for(const e of baseline.files){
  const d=delta.get(e.path),sourceBlob=git('rev-parse',`${BASE}:${originalPath(e.path)}`).toString().trim(),current=existsSync(join(ROOT,e.path))?git('hash-object','--',e.path).toString().trim():'deleted';
  const uses=supplies.get(e.path)??[];
  const status=(manifest.publication?.files??[]).some(p=>p.path===e.path)?'redacted for publication; original source pin retained':d?.deleted?'deleted by D5':d?'changed by D5':uses.length?'merged into src/ or test/ by D5':'unchanged';
  rows.push(`| ${code(e.path.replace(PKG+'/',''))} | ${code(e.sourcePath+' @ '+e.sourceCommit)} | ${code(sourceBlob)} | ${status} | ${code(current)} | ${uses.map(code).join('<br>')||'—'} |`);
 }
 for(const e of delta.values())if(!baseline.files.some(b=>b.path===e.path)){
  const current=existsSync(join(ROOT,e.path))?git('hash-object','--',e.path).toString().trim():'deleted';
  rows.push(`| ${code(e.path.replace(PKG+'/',''))} | D5 addition; sources above | — | ${e.deleted?'deleted':'added'} by D5 | ${code(current)} | ${(e.supplied??[]).map(s=>code((s.path?.replace(PKG+'/','')??s.sourcePath+' @ '+s.sourceCommit+' blob '+s.sourceBlob)+':'+s.lines.join('-')+' → '+s.target.join('-'))).join('<br>')||'D5 original'} |`);
 }
 rows.push('<!-- END GENERATED -->');return rows.join('\n');
}
export function update({check=false}={}){
 const path=join(ROOT,PKG,'DELTA-MAP.md'),text=readFileSync(path,'utf8'),manifest=JSON.parse(readFileSync(join(ROOT,PKG,'PROVENANCE.json'),'utf8'));
 const begin=text.indexOf('<!-- BEGIN GENERATED:'),end=text.indexOf('<!-- END GENERATED -->',begin);
 if(begin<0||end<0)throw new Error('delta map markers missing');
 const next=text.slice(0,begin)+render(manifest)+text.slice(end+'<!-- END GENERATED -->'.length);
 if(check&&next!==text)throw new Error('DELTA-MAP.md is stale');if(!check)writeFileSync(path,next);
 return `delta-map: ${manifest.files.length} pinned files, ${manifest.deltas?.files.length??0} D5 files; ok`;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){try{console.log(update({check:process.argv.includes('--check')}))}catch(e){console.error(e.message);process.exitCode=1;}}
