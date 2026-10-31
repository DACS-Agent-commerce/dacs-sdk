// Seller records: one process owns a seller state directory (its approval
// ledger, journal binding and issuance journals) for its whole lifetime.
// The lock file is published whole (a synced temporary file linked into
// place, so it is never seen partly written) and names its holder: host,
// boot, pid namespace, pid and that process's start time. A lock whose holder
// is provably gone on this host is taken over; any doubt refuses.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, readlinkSync, unlinkSync } from 'node:fs';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export const SELLER_STATE_LOCK_FILE='seller-state.lock';
const FORMAT='dacs-seller-state-lock/v1';
const FIELDS=['format','host','machineId','bootId','pidNamespace','pid','processStart','acquiredAt'];
export const SELLER_STATE_LOCK_REFUSALS=Object.freeze({
  held:'seller state directory is in use by another live operator process (seller-state.lock); nothing was read or written: stop that operator first, one operator per state directory',
  doubt:'seller state directory is locked by an operator process that cannot be proven gone on this host (seller-state.lock names another host, boot or pid namespace, or is unreadable); nothing was read or written: confirm that no operator uses this state directory on any host, then remove seller-state.lock by hand',
  takeover:'seller state directory lock is being taken over by another process, or a takeover was interrupted (seller-state.lock.takeover); nothing was read or written: confirm that no operator uses this state directory, then remove seller-state.lock.takeover by hand',
});

const readOptional=(read)=>{try{const value=read();return typeof value==='string'&&value.trim()?value.trim():null;}catch{return null;}};
// Field 22 of /proc/<pid>/stat: start time in clock ticks after boot. The
// command name (field 2) may hold spaces or parentheses, so count from the last ')'.
function processStart(pid){
  const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  const start=fields[19];
  if(!/^[0-9]+$/.test(start??''))throw new Error('process start time is unreadable');
  return start;
}
// Numeric proc paths are exit evidence only when procfs names this PID space.
function pidMappingKnown(){
  try{
    const ids=/^NSpid:\s*(.*)$/m.exec(readFileSync('/proc/self/status','utf8'))?.[1].trim().split(/\s+/);
    return ids?.length===1&&ids[0]===String(process.pid);
  }catch{return false;}
}
// True only when the kernel itself says no process has this PID (ESRCH). A PID
// that exists, or that this user may not signal (EPERM), is not absent.
function pidAbsent(pid){
  try{process.kill(pid,0);return false;}catch(error){return error?.code==='ESRCH';}
}
export function currentSellerStateHolder(at=Date.now()){
  return{format:FORMAT,host:hostname(),machineId:readOptional(()=>readFileSync('/etc/machine-id','utf8')),bootId:readOptional(()=>readFileSync('/proc/sys/kernel/random/boot_id','utf8')),
    pidNamespace:readOptional(()=>readlinkSync('/proc/self/ns/pid')),pid:process.pid,processStart:readOptional(()=>processStart('self')),acquiredAt:at};
}
const exactHolder=(value)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===FIELDS.length&&FIELDS.every(key=>Object.hasOwn(value,key))
  &&value.format===FORMAT&&Number.isSafeInteger(value.pid)&&value.pid>0&&Number.isSafeInteger(value.acquiredAt)
  &&['host','machineId','bootId','pidNamespace'].every(key=>value[key]===null||typeof value[key]==='string')
  &&(value.processStart===null||(typeof value.processStart==='string'&&/^\d{1,20}$/.test(value.processStart)));

// 'gone' only on proof; a live holder (this process included) is 'live';
// anything that cannot be decided is 'doubt'.
export function sellerStateHolderState(holder,self=currentSellerStateHolder(),{readStart=processStart,readPidMapping=pidMappingKnown,isPidAbsent=pidAbsent}={}){
  if(!exactHolder(holder))return 'doubt';
  // Proof needs the same machine: its name and identity, both known.
  if(!holder.machineId||holder.machineId!==self.machineId||holder.host!==self.host)return 'doubt';
  if(!holder.bootId||!self.bootId)return 'doubt';
  // A cloned machine can share machine identity and disk while still running.
  if(holder.bootId!==self.bootId)return 'doubt';
  if(!holder.pidNamespace||holder.pidNamespace!==self.pidNamespace||!holder.processStart)return 'doubt';
  let start;
  try{if(readPidMapping()!==true)return 'doubt';}catch{return 'doubt';}
  try{start=readStart(holder.pid);}
  // procfs mounted with hidepid hides another user's live process as ENOENT:
  // a missing entry is exit evidence only when the kernel agrees (ESRCH).
  catch(error){return error?.code==='ENOENT'&&isPidAbsent(holder.pid)?'gone':'doubt';}
  if(typeof start!=='string'||!/^\d{1,20}$/.test(start))return 'doubt';
  // The pid now names a later process: the holder is gone.
  return start===holder.processStart?'live':'gone';
}

const syncDirectory=async(path)=>{const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}};
async function temporaryWith(path,text){
  const temporary=`${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
  return temporary;
}
// Publishes text at path only if nothing is there (link never replaces).
async function publishExclusive(path,text){
  const temporary=await temporaryWith(path,text);
  try{await link(temporary,path);return true;}
  catch(error){if(error.code==='EEXIST')return false;throw error;}
  finally{await unlink(temporary).catch(()=>{});}
}
const refuse=(reason,cause)=>Object.assign(new Error(SELLER_STATE_LOCK_REFUSALS[reason],cause?{cause}:undefined),{code:'seller_state_locked',reason});

// Takes the lock or throws before anything else in the directory is read.
// Returns {release()}, which removes the lock only while it is still this one.
export async function acquireSellerStateLock(directory,{now=Date.now,holderState=sellerStateHolderState}={}){
  const path=join(directory,SELLER_STATE_LOCK_FILE),takeover=`${path}.takeover`;
  const text=`${JSON.stringify(currentSellerStateHolder(now()))}\n`;
  if(!await publishExclusive(path,text)){
    let found;
    try{found=await readFile(path,'utf8');}catch(error){throw refuse('doubt',error);}
    let holder=null;try{holder=JSON.parse(found);}catch{}
    const state=holderState(holder);
    if(state==='live')throw refuse('held');
    if(state!=='gone')throw refuse('doubt');
    // Takeover is exclusive: one process holds the takeover file, checks the
    // lock is still the one judged gone, and only then replaces it. A takeover
    // file left by a process that died is not judged and removed here: two
    // starts that both judged it gone could each remove the other's fresh one
    // and both take over. The operator removes it by hand (the refusal says so).
    if(!await publishExclusive(takeover,text))throw refuse('takeover');
    try{
      if(await readFile(path,'utf8').catch(()=>null)!==found)throw refuse('held');
      const temporary=await temporaryWith(path,text);
      try{await rename(temporary,path);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
    }finally{await unlink(takeover).catch(()=>{});}
  }
  await syncDirectory(dirname(path));
  // Synchronous, so that a close that does not wait still frees the lock
  // before the next start in the same process.
  let released=false;
  return Object.freeze({path,release:()=>{
    if(released)return;released=true;
    let current=null;try{current=readFileSync(path,'utf8');}catch{}
    if(current!==text)return;
    unlinkSync(path);
    const handle=openSync(dirname(path),'r');try{fsyncSync(handle);}finally{closeSync(handle);}
  }});
}
