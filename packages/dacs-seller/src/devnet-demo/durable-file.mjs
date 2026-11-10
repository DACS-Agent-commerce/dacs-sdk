import { randomBytes } from 'node:crypto';
import { link, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const PRIVATE_FILE_MODE=0o600;
const TEMPORARY_SUFFIX_BYTES=6;

async function syncPath(path){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}

/** Flushes the entries of a directory to disk. Throws if it cannot be opened or synced. */
export const syncDirectory=syncPath;

/** Flushes the contents of an existing file to disk without changing it. Throws if it cannot be opened or synced. */
export const syncFile=syncPath;

/**
 * The sync steps durable publishing takes: `file(handle, path)` for a file written through `handle`,
 * `directory(path)` for the entries of a directory. A caller may pass its own to observe or fail them.
 */
export const DURABLE_SYNC=Object.freeze({file:(handle)=>handle.sync(),directory:syncDirectory});

/**
 * Writes `text` to a new file at `path`, exactly mode 0600 whatever the umask, so that the file is there whole or not at all.
 * The text goes to a synced temporary file next to `path`, which is linked into place (a link
 * never replaces a file, so an existing mnemonic or secret is never overwritten), and the
 * directory is synced before this returns. Each sync goes through `sync` (DURABLE_SYNC by default).
 * Returns true when the file was published, false when a file already exists at `path`
 * (left unchanged). Any other error is thrown; the temporary file is removed in every case
 * except a crash, which leaves it unpublished and never read.
 */
export async function publishFileExclusive(path,text,sync=DURABLE_SYNC){
  const temporary=`${path}.${process.pid}.${randomBytes(TEMPORARY_SUFFIX_BYTES).toString('hex')}.tmp`;
  let published=false;
  try{
    const handle=await open(temporary,'wx',PRIVATE_FILE_MODE);
    try{await handle.chmod(PRIVATE_FILE_MODE);await handle.writeFile(text,{encoding:'utf8'});await sync.file(handle,temporary);}finally{await handle.close();}
    try{await link(temporary,path);published=true;}
    catch(error){if(error?.code!=='EEXIST')throw error;}
  }finally{await unlink(temporary).catch(()=>{});}
  if(published)await sync.directory(dirname(path));
  return published;
}
