// A real child process holds crypto.sign at the check/sign boundary. No key
// material crosses IPC; only the resulting signature and control messages do.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs, { existsSync, readFileSync } from 'node:fs';

const [fixturePath,mode]=process.argv.slice(2);
const {directory,operation,time,release,keyFile,retiredFile}=JSON.parse(readFileSync(fixturePath,'utf8'));
let checkMarker=false;
function pause(message){
  process.send(message);
  const limit=Date.now()+10000,sleep=new Int32Array(new SharedArrayBuffer(4));
  while(!existsSync(release)){
    if(Date.now()>limit)throw new Error('worker release timeout');
    Atomics.wait(sleep,0,0,10);
  }
}
if(mode==='sign'){
  const sign=crypto.sign;let paused=false;
  crypto.sign=(...args)=>{
    if(!paused){
      paused=true;pause({signEntered:true});
    }
    return sign(...args);
  };
  syncBuiltinESMExports();
}
if(mode==='sweep-pause-unlink'){
  const unlink=fs.unlinkSync;
  fs.unlinkSync=(path)=>{if(path===keyFile)pause({unlinkEntered:true});return unlink(path);};
  syncBuiltinESMExports();
}
if(mode==='sign-pause-marker'){
  const lstat=fs.lstatSync;
  fs.lstatSync=(path)=>{
    try{return lstat(path);}
    catch(error){
      if(checkMarker&&path===retiredFile&&error.code==='ENOENT'){checkMarker=false;pause({markerChecked:true});}
      throw error;
    }
  };
  syncBuiltinESMExports();
}
const {createOperatorSellerSessions}=await import('../../src/devnet-demo/operator-sessions.mjs');
const store=createOperatorSellerSessions({directory,now:()=>time});
const signer=mode.startsWith('sign')?store.signerFor(operation):null;
process.on('message',command=>{
  try{
    if(command==='sign'){checkMarker=mode==='sign-pause-marker';process.send({signature:signer.sign(Buffer.from('race request')).toString('hex')});}
    else if(command==='sweep')process.send(store.sweep(()=>operation));
  }catch(error){process.send({error:error.code??error.message});}
});
process.send({ready:true});
