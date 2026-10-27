import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSellerIssuanceJournals } from '../src/devnet-demo/seller-issuance.mjs';
import { parsePolicyLedger,SELLER_LEDGER_HEADER_FORMAT } from '../src/devnet-demo/operator-approval.mjs';
import { T0 } from './helpers/d5-policy-fixtures.mjs';

// An in-memory durable wallet journal opener with the opener contract
// ({path,mode,expectedJournalId} -> {journalId,close}).
function journalOpener(){
 const ids=new Map();
 return ({path,mode,expectedJournalId})=>{
  if(mode==='create'){if(ids.has(path))throw new Error('TEST journal exists');ids.set(path,(ids.size+1).toString(16).padStart(32,'0'));}
  else if(!ids.has(path)||(expectedJournalId!==undefined&&ids.get(path)!==expectedJournalId))throw new Error('TEST journal refused');
  return{journalId:ids.get(path),close(){}};
 };
}
async function stateDirectory(t){const root=await mkdtemp(join(tmpdir(),'TEST-seller-issuance-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
// One operator start and close: the journals it opened close, then the state lock is released.
async function start(directory,openJournal){
 const opened=[],journals=await openSellerIssuanceJournals({directory,openJournal,opened,now:()=>T0});
 for(const close of opened.reverse())close();
 return journals;
}
const ledgerPath=(directory)=>join(directory,'evidence','seller-approvals.jsonl');
const legacyRow=`${JSON.stringify({format:'dacs-node2-operator-approval-evidence/v1',decision:'rejected',approvalHash:'a'.repeat(64)})}`;
const firstLine=async(directory)=>JSON.parse((await readFile(ledgerPath(directory),'utf8')).split('\n')[0]);

test('journal opening refuses without a durable wallet journal opener before touching the state',async t=>{
 const directory=await stateDirectory(t);
 await assert.rejects(openSellerIssuanceJournals({directory,now:()=>T0}),TypeError);
 await assert.rejects(readFile(ledgerPath(directory)),{code:'ENOENT'});
});

test('a first start binds new journals under a ledger that starts with its header',async t=>{
 const directory=await stateDirectory(t),openJournal=journalOpener();
 const journals=await start(directory,openJournal);
 assert.equal(journals.length,3);assert.equal((await firstLine(directory)).format,SELLER_LEDGER_HEADER_FORMAT);
 assert.equal((await start(directory,openJournal)).length,3);
});

// Binding an existing ledger puts the header first, so the ledger still reads and every later start opens.
for(const [label,existing] of [
 ['a headerless ledger',`${legacyRow}\n`],
 ['a headerless ledger whose last line has no newline',legacyRow],
])test(`binding ${label} keeps its rows after the header and starts again`,async t=>{
 const directory=await stateDirectory(t),openJournal=journalOpener();
 await mkdir(join(directory,'evidence'),{recursive:true,mode:0o700});await writeFile(ledgerPath(directory),existing,{mode:0o600});
 await start(directory,openJournal);
 const text=await readFile(ledgerPath(directory),'utf8');
 assert.equal((await firstLine(directory)).format,SELLER_LEDGER_HEADER_FORMAT);assert.equal(text.split('\n')[1],legacyRow);assert(text.endsWith('\n'));
 assert.doesNotThrow(()=>parsePolicyLedger(text));
 assert.equal((await start(directory,openJournal)).length,3);
});

test('a torn header cut from a bound ledger is written whole before its rows and starts again',async t=>{
 const directory=await stateDirectory(t),openJournal=journalOpener();
 await start(directory,openJournal);
 const header=(await readFile(ledgerPath(directory),'utf8')).split('\n')[0];
 await writeFile(ledgerPath(directory),`${legacyRow}\n${header.slice(0,60)}`);
 await start(directory,openJournal);
 assert.equal((await readFile(ledgerPath(directory),'utf8')),`${header}\n${legacyRow}\n`);
 assert.equal((await start(directory,openJournal)).length,3);
});
