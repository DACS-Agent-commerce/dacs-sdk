import { closeSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const NEWLINE=0x0a;
// Whether a non-empty ledger of `size` bytes ends without a newline, read from its last byte alone.
const endsMidLine=(descriptor,size)=>{
  if(size===0)return false;
  const last=Buffer.alloc(1);
  if(readSync(descriptor,last,0,1,size-1)!==1)throw new Error('approval ledger last byte was not read');
  return last[0]!==NEWLINE;
};

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
 * The caller serializes ledger transactions. Throws on read, write or sync failure: a failed write leaves
 * the ledger as it was, a failed sync leaves the complete line for a retry to sync. */
export function appendApprovalLedgerLine(evidencePath,row){
  const path=resolve(evidencePath);
  try{mkdirSync(dirname(path),{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const descriptor=openSync(path,'a+',0o600);
  try{
    const size=fstatSync(descriptor).size;
    const bytes=Buffer.from(`${endsMidLine(descriptor,size)?'\n':''}${JSON.stringify(row)}\n`);
    // Nothing else appends under the caller's lock, so a failed write is undone to
    // the size it started at: the caller sees the original error and the ledger
    // holds no partial line. Should the undo itself fail, the original error
    // carries it as rollbackError and a restart's torn-line cut recovers. A
    // complete line whose file sync fails is kept, not undone: whether it is
    // durable is unknown, and an exact retry finds it and syncs it.
    try{
      for(let done=0;done<bytes.length;){
        const written=writeSync(descriptor,bytes,done,bytes.length-done);
        if(!(written>0))throw new Error('approval ledger line was not written');
        done+=written;
      }
    }catch(error){
      try{ftruncateSync(descriptor,size);fsyncSync(descriptor);}catch(rollbackError){if(error!==null&&typeof error==='object')error.rollbackError=rollbackError;}
      throw error;
    }
    fsyncSync(descriptor);
  }finally{closeSync(descriptor);}
  syncApprovalLedger(path);
}
