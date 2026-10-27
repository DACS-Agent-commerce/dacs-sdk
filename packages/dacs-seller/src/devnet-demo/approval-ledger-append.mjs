import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const syncPath=(path)=>{
  const descriptor=openSync(path,'r');
  try{fsyncSync(descriptor);}finally{closeSync(descriptor);}
};
/** Sync an existing approval ledger, its directory and that directory's entry in its parent; throws on any failure.
 * It keeps no state, so a retry in any process syncs all an earlier append may have left unsynced. */
export function syncApprovalLedger(evidencePath){
  const path=resolve(evidencePath),directory=dirname(path);
  for(const target of [path,directory,dirname(directory)])syncPath(target);
}
/** Append one JSON record synchronously, preserving its boundary and syncing its publication.
 * Creates at most the ledger's own private directory; a missing parent throws ENOENT before anything is created.
 * The caller serializes ledger transactions. Throws on read, write or sync failure. */
export function appendApprovalLedgerLine(evidencePath,row){
  const path=resolve(evidencePath);
  try{mkdirSync(dirname(path),{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
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
