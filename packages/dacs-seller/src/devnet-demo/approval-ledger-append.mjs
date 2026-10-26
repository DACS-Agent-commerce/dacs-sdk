import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const publicationRoots=new Map();
const syncPath=(path)=>{
  const descriptor=openSync(path,'r');
  try{fsyncSync(descriptor);}finally{closeSync(descriptor);}
};
/** Sync an existing approval ledger and its publication directories; throws on any failure. */
export function syncApprovalLedger(evidencePath){
  const path=resolve(evidencePath),directory=dirname(path);
  const root=publicationRoots.get(path)??dirname(directory);
  syncPath(path);
  for(let current=directory;;current=dirname(current)){
    syncPath(current);
    if(current===root)break;
  }
  publicationRoots.delete(path);
}
/** Append one JSON record synchronously, preserving its boundary and syncing its publication.
 * The caller serializes ledger transactions. Throws on read, write or sync failure. */
export function appendApprovalLedgerLine(evidencePath,row){
  const path=resolve(evidencePath),directory=dirname(path);
  const created=mkdirSync(directory,{recursive:true,mode:0o700});
  if(created&&!publicationRoots.has(path))publicationRoots.set(path,dirname(created));
  let text='';
  try{text=readFileSync(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const bytes=Buffer.from(`${text.length&&!text.endsWith('\n')?'\n':''}${JSON.stringify(row)}\n`);
  const descriptor=openSync(path,'a',0o600);
  try{
    for(let done=0;done<bytes.length;){
      const written=writeSync(descriptor,bytes,done,bytes.length-done);
      if(!(written>0))throw new Error('approval ledger line was not written');
      done+=written;
    }
    fsyncSync(descriptor);
  }finally{closeSync(descriptor);}
  syncApprovalLedger(path);
}
