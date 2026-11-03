import { fixture } from './showcase-safety-fixture.mjs';

const [path,stopAt,identity]=process.argv.slice(2);
const h=fixture({path,directoryIdentity:JSON.parse(identity),boundary:async(stage,transaction)=>{
  if(stage!==stopAt)return;
  await new Promise((resolve,reject)=>process.send({stage,hash:transaction.hash,address:transaction.content.from,journalId:h.journal.journalId},error=>error?reject(error):resolve()));
  await new Promise(()=>{});
}});
// IPC keeps the process alive until the parent observes the exact boundary.
process.on('message',()=>{});
try{const prepared=await h.prepare();await prepared.send();throw new Error('TEST kill boundary not reached');}
catch(error){process.send({error:error.message});await h.close();process.exitCode=1;process.disconnect();}
