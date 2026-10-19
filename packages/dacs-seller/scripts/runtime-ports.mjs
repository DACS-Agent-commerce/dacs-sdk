#!/usr/bin/env node
// Run-time ports from the plugin seller kit (RUNTIME-PORTS.json). Each port is
// a generated header plus the listed source lines, unchanged and in order,
// after the listed import replacements (each must apply exactly once) and,
// where a port sets publicationText, the repository's publication wording.
//   --source <http-mcp directory> --write   regenerate the ports and their pins
//   --source <http-mcp directory> --check   exit 1 unless every port regenerates exactly
//   (no arguments)                          exit 1 unless every port matches its pinned hash
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {redactText} from './lib/publication-text.mjs';
const PKG=resolve(dirname(fileURLToPath(import.meta.url)),'..'),SPEC=join(PKG,'RUNTIME-PORTS.json');
const sha=b=>createHash('sha256').update(b).digest('hex');
const ranges=lines=>lines==='all'?'the whole file':(lines.length===1&&lines[0][0]===lines[0][1]?'line ':'lines ')+lines.map(([a,b])=>a===b?a:`${a}-${b}`).join(', ');
// Header comment lines of at most 100 characters.
const comment=text=>text.split(' ').reduce((out,word)=>{const last=out.at(-1);if(last.length+word.length+1>97&&last.length>3)out.push('// '+word);else out[out.length-1]=last+(last.length>3?' ':'')+word;return out;},['// ']);
export function render(spec,port,source){
 const all=source.split('\n');
 let body=port.lines==='all'?source:port.lines.map(([a,b])=>{if(!(a>=1&&b>=a&&b<=all.length))throw new Error(`${port.target}: bad range ${a}-${b}`);return all.slice(a-1,b).join('\n')+'\n';}).join('');
 for(const [from,to] of port.replace){
  if(body.split(from).length!==2)throw new Error(`${port.target}: replacement must apply once: ${from}`);
  body=body.replace(from,()=>to);
 }
 if(port.publicationText){const published=redactText(body);if(published===body)throw new Error(`${port.target}: publication wording changes nothing`);body=published;}
 const changed=[...(port.replace.length?['import paths']:[]),...(port.publicationText?['publication wording']:[])];
 const header=[...comment(`Run-time port of http-mcp/${port.source} at ${spec.sourceRepository} ${spec.sourceCommit}: ${ranges(port.lines)}.`),
  `// The source lines below are unchanged${changed.length?` except ${changed.join(' and ')}`:''} (RUNTIME-PORTS.json).`,
  ...(port.omitted?comment(`Left out: ${port.omitted}.`):[])];
 return header.join('\n')+'\n'+body;
}
function main(){
 const args=process.argv.slice(2),at=args.indexOf('--source'),source=at>=0?resolve(args[at+1]??''):null;
 const write=args.includes('--write'),check=args.includes('--check');
 if((source===null)!==(!write&&!check)||(write&&check))throw new Error('usage: runtime-ports.mjs [--source <http-mcp directory> (--write|--check)]');
 const spec=JSON.parse(readFileSync(SPEC,'utf8'));
 for(const port of spec.ports){
  const target=join(PKG,port.target);
  if(source===null){
   if(!existsSync(target)||sha(readFileSync(target))!==port.sha256)throw new Error(`${port.target}: differs from its pinned hash`);
   continue;
  }
  const text=readFileSync(join(source,port.source),'utf8'),next=render(spec,port,text);
  if(write){mkdirSync(dirname(target),{recursive:true});writeFileSync(target,next);port.sourceSha256=sha(text);port.sha256=sha(next);continue;}
  if(sha(text)!==port.sourceSha256)throw new Error(`${port.source}: source differs from the pinned source hash`);
  if(!existsSync(target)||readFileSync(target,'utf8')!==next||sha(next)!==port.sha256)throw new Error(`${port.target}: does not regenerate exactly`);
 }
 if(write)writeFileSync(SPEC,JSON.stringify(spec,null,2)+'\n');
 return `runtime-ports: ${spec.ports.length} ports ${write?'written':source?'regenerate exactly':'match their pins'}`;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){try{console.log(main());}catch(error){console.error('FAIL '+error.message);process.exitCode=1;}}
