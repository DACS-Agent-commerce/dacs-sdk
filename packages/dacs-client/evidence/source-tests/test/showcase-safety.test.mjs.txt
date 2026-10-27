import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runShowcase } from '../scripts/showcase-safety.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { directoryBinding, fixture, temporaryJournal } from './helpers/showcase-safety-fixture.mjs';
import { restartScenario } from './helpers/showcase-safety-restart.mjs';

// Linux binds through /proc/self/fd; elsewhere, or with
// DACS_SHOWCASE_DIRECTORY_BINDING=path, the fixture uses path checks only.
const descriptor=directoryBinding()==='descriptor';

function withTmpdir(path,work) {
  const previous=process.env.TMPDIR;
  process.env.TMPDIR=path;
  try{return work();}
  finally{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;}
}

// Runs swap() once, inside the first matching call to any named node:fs
// function, so every check the fixture made before that call has already
// returned. Returns a restorer.
function swapBefore(names,swap,matches=()=>true) {
  const saved=names.map(name=>[name,fs[name]]);let pending=true;
  for(const [name,real] of saved)fs[name]=function(...args){
    if(pending&&matches(...args)){pending=false;swap();}
    return Reflect.apply(real,this,args);
  };
  syncBuiltinESMExports();
  return ()=>{for(const [name,real] of saved)fs[name]=real;syncBuiltinESMExports();};
}

// Replaces node:fs functions with wrap(real,...args) until restored.
function interceptFs(wrappers) {
  const saved=Object.keys(wrappers).map(name=>[name,fs[name]]);
  for(const [name,real] of saved)fs[name]=function(...args){return wrappers[name]((...a)=>Reflect.apply(real,this,a),...args);};
  syncBuiltinESMExports();
  return ()=>{for(const [name,real] of saved)fs[name]=real;syncBuiltinESMExports();};
}

// Runs hook(db) once, inside SQLite's first exec after `new DatabaseSync()`
// returned and before the journal's WAL pragma opens -wal/-shm.
function onFirstExec(hook) {
  const exec=DatabaseSync.prototype.exec;let pending=true;
  DatabaseSync.prototype.exec=function(...args){if(pending){pending=false;hook(this);}return Reflect.apply(exec,this,args);};
  return ()=>{DatabaseSync.prototype.exec=exec;};
}

const showcaseDirectories=()=>readdirSync(tmpdir()).filter(name=>name.startsWith('showcase-safety-'));

test('temporary journal refuses non-sticky writable TMPDIR and ancestors',()=>{
  const sandbox=mkdtempSync(join(tmpdir(),'showcase-path-test-'));
  try{
    for(const mode of [0o770,0o777]){
      const unsafe=join(sandbox,String(mode));mkdirSync(unsafe,{mode:0o700});chmodSync(unsafe,mode);
      const nested=join(unsafe,'private');mkdirSync(nested,{mode:0o700});
      for(const path of [unsafe,nested])withTmpdir(path,()=>{
        let allocated;
        try{assert.throws(()=>{allocated=temporaryJournal();},/group\/world writable/);}
        finally{allocated?.close();}
      });
    }
  }finally{rmSync(sandbox,{recursive:true,force:true});}
});

test('temporary journal refuses symlinked TMPDIR components',()=>{
  const sandbox=mkdtempSync(join(tmpdir(),'showcase-path-test-'));
  try{
    const real=join(sandbox,'real');mkdirSync(real,{mode:0o700});mkdirSync(join(real,'nested'),{mode:0o700});
    const link=join(sandbox,'link');symlinkSync(real,link);
    for(const path of [link,join(link,'nested')])withTmpdir(path,()=>{
      let allocated;
      try{assert.throws(()=>{allocated=temporaryJournal();},/symbolic link/);}
      finally{allocated?.close();}
    });
  }finally{rmSync(sandbox,{recursive:true,force:true});}
});

test('temporary journal refuses a TMPDIR owned by another user',t=>{
  // Model another invoking user without needing privileged chown in this suite.
  const uid=process.getuid();t.mock.method(process,'getuid',()=>uid+1);
  assert.throws(()=>temporaryJournal(),/unsafe owner/);
});

test('temporary journal accepts a trusted sticky writable ancestor',()=>{
  const sandbox=mkdtempSync(join(tmpdir(),'showcase-path-test-'));
  try{
    chmodSync(sandbox,0o1777);
    withTmpdir(sandbox,()=>{
      const temp=temporaryJournal();temp.close();temp.close();
      assert.equal(existsSync(dirname(temp.path)),false);
    });
  }finally{rmSync(sandbox,{recursive:true,force:true});}
});

test('temporary journal refuses a replaced directory before SQLite reopen',async()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
  let reopened;
  try{
    const original=fixture({path:temp.path,directoryIdentity:temp.identity});
    await original.journal.put('showcase/sentinel',{original:true});await original.close();
    renameSync(root,moved);cpSync(moved,root,{recursive:true});chmodSync(root,0o700);
    assert.throws(()=>{reopened=fixture({path:temp.path,mode:'open',directoryIdentity:temp.identity});},/directory identity changed/);
  }finally{
    await reopened?.close();rmSync(root,{recursive:true,force:true});
    if(existsSync(moved))renameSync(moved,root);temp.close();
  }
});

test('temporary journal refuses recursive cleanup of a replaced directory',()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
  try{
    writeFileSync(join(root,'original.txt'),'original must survive');
    renameSync(root,moved);mkdirSync(root,{mode:0o700});
    const marker=join(root,'keep.txt');writeFileSync(marker,'replacement must survive');
    assert.throws(()=>temp.close(),/directory identity changed/);
    assert.equal(readFileSync(marker,'utf8'),'replacement must survive');
    assert.equal(readFileSync(join(moved,'original.txt'),'utf8'),'original must survive');
  }finally{
    rmSync(root,{recursive:true,force:true});
    if(existsSync(moved))renameSync(moved,root);temp.close();
  }
});

test('temporary journal refuses a symlink replacement before open and cleanup',async()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
  try{
    const original=fixture({path:temp.path,directoryIdentity:temp.identity});
    await original.journal.put('showcase/sentinel',{original:true});await original.close();
    const marker=join(root,'keep.txt');writeFileSync(marker,'original must survive');
    renameSync(root,moved);symlinkSync(moved,root);
    assert.throws(()=>fixture({path:temp.path,mode:'open',directoryIdentity:temp.identity}),/symbolic link/);
    assert.throws(()=>temp.close(),/symbolic link/);
    assert.equal(readFileSync(join(moved,'keep.txt'),'utf8'),'original must survive');
  }finally{
    rmSync(root,{recursive:true,force:true});
    if(existsSync(moved))renameSync(moved,root);temp.close();
  }
});

// The replacement is a byte copy (same journal ID) with one extra record.
async function replacementCopy(temp,copyRoot) {
  const original=fixture({path:temp.path,directoryIdentity:temp.identity});
  await original.journal.put('showcase/sentinel',{original:true});await original.close();
  cpSync(dirname(temp.path),copyRoot,{recursive:true});chmodSync(copyRoot,0o700);
  const copied=openDurableWalletJournal({path:join(copyRoot,'public.sqlite'),mode:'open'});
  await copied.put('showcase/replacement',{replacement:true});copied.close();
  return readFileSync(join(copyRoot,'public.sqlite'));
}

test(`temporary journal ${descriptor?'opens the checked directory':'opens the path (fallback)'}, then refuses, when it is swapped just before SQLite opens`,async()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original',copyRoot=root+'-copy';
  let reopened,restore,restoreExec,opened;
  try{
    const replacementBytes=await replacementCopy(temp,copyRoot);
    // The journal's existence probe is its last step before `new DatabaseSync()`.
    restore=swapBefore(['existsSync'],()=>{renameSync(root,moved);renameSync(copyRoot,root);},path=>String(path).endsWith('/public.sqlite'));
    restoreExec=onFirstExec(db=>{opened=db.prepare('PRAGMA database_list').all()[0].file;});
    assert.throws(()=>{reopened=fixture({path:temp.path,mode:'open',directoryIdentity:temp.identity});},/directory identity changed/);
    restore();restore=undefined;restoreExec();restoreExec=undefined;
    // Descriptor binding opens the original; the path fallback opens the
    // replacement, which only the check after the open refuses (see Limits).
    assert.equal(opened,join(descriptor?moved:root,basename(temp.path)));
    if(descriptor){
      assert.deepEqual(readdirSync(root),['public.sqlite']);
      assert.deepEqual(readFileSync(join(root,'public.sqlite')),replacementBytes);
    }
  }finally{
    restore?.();restoreExec?.();await reopened?.close();
    rmSync(copyRoot,{recursive:true,force:true});
    if(existsSync(moved)){rmSync(root,{recursive:true,force:true});renameSync(moved,root);}
    temp.close();
  }
});

test('temporary journal refuses a directory swapped after SQLite opens, before its WAL files',async()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original',copyRoot=root+'-copy';
  let reopened,restoreExec;
  try{
    await replacementCopy(temp,copyRoot);
    // SQLite opens -wal/-shm by text path at the first statements after the open.
    restoreExec=onFirstExec(()=>{renameSync(root,moved);renameSync(copyRoot,root);});
    assert.throws(()=>{reopened=fixture({path:temp.path,mode:'open',directoryIdentity:temp.identity});},/directory identity changed/);
    restoreExec();restoreExec=undefined;
    const original=openDurableWalletJournal({path:join(moved,'public.sqlite'),mode:'open'});
    try{assert.deepEqual(await original.get('showcase/sentinel'),{original:true});assert.equal(await original.get('showcase/replacement'),undefined);}
    finally{original.close();}
  }finally{
    restoreExec?.();await reopened?.close();
    rmSync(copyRoot,{recursive:true,force:true});
    if(existsSync(moved)){rmSync(root,{recursive:true,force:true});renameSync(moved,root);}
    temp.close();
  }
});

// The non-empty replacement holds a decoy with the journal's own file name.
// The swap fires at the first entry removal, between cleanup's two checks.
for(const [label,contents] of [['a non-empty',['public.sqlite']],['an empty',[]]]){
  test(`temporary journal cleanup refuses ${label} directory swapped in while entries are removed`,async()=>{
    const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
    let restore;
    try{
      await fixture({path:temp.path,directoryIdentity:temp.identity}).close();
      restore=swapBefore(['rmSync','rmdirSync','unlinkSync'],()=>{
        renameSync(root,moved);mkdirSync(root,{mode:0o700});
        for(const name of contents)writeFileSync(join(root,name),'replacement must survive');
      });
      assert.throws(()=>temp.close(),/directory identity changed/);
      restore();restore=undefined;
      assert.equal(existsSync(root),true);assert.equal(existsSync(moved),true);
      // The path fallback removes entries by name, so the decoy goes (see Limits).
      for(const name of contents)if(descriptor)assert.equal(readFileSync(join(root,name),'utf8'),'replacement must survive');
      else assert.equal(existsSync(join(root,name)),false);
    }finally{
      restore?.();
      if(existsSync(moved)){rmSync(root,{recursive:true,force:true});renameSync(moved,root);}
      temp.close();
    }
  });
}

// The swap fires inside the final rmdir, after both checks have returned.
test('temporary journal cleanup cannot tell an empty directory swapped in at the final rmdir (documented limit)',async()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
  let restore;
  try{
    await fixture({path:temp.path,directoryIdentity:temp.identity}).close();
    restore=swapBefore(['rmdirSync'],()=>{renameSync(root,moved);mkdirSync(root,{mode:0o700});},path=>path===root);
    temp.close();
    restore();restore=undefined;
    assert.equal(existsSync(root),false);
    assert.deepEqual(readdirSync(moved),[]);
  }finally{
    restore?.();
    if(existsSync(moved)){rmSync(root,{recursive:true,force:true});rmdirSync(moved);}
    temp.close();
  }
});

test('temporary journal cleanup keeps a non-empty directory swapped in at the final rmdir and closes its descriptor',async()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
  let restore;const closed=[];
  try{
    await fixture({path:temp.path,directoryIdentity:temp.identity}).close();
    restore=swapBefore(['rmdirSync'],()=>{
      renameSync(root,moved);mkdirSync(root,{mode:0o700});writeFileSync(join(root,'keep.txt'),'replacement must survive');
    },path=>path===root);
    const restoreClose=interceptFs({closeSync:(real,fd)=>{closed.push(fd);return real(fd);}});
    try{assert.throws(()=>temp.close(),{code:'ENOTEMPTY'});}finally{restoreClose();}
    restore();restore=undefined;
    assert.equal(closed.length,1);
    assert.equal(readFileSync(join(root,'keep.txt'),'utf8'),'replacement must survive');
    // A retry after the original is back binds a fresh descriptor and succeeds.
    rmSync(root,{recursive:true,force:true});renameSync(moved,root);
    temp.close();
    assert.equal(existsSync(root),false);
  }finally{
    restore?.();
    if(existsSync(moved)){rmSync(root,{recursive:true,force:true});renameSync(moved,root);}
    temp.close();
  }
});

test('temporary journal removes its new directory when binding it fails',()=>{
  const before=showcaseDirectories();
  const restore=swapBefore(['openSync'],()=>{throw new Error('TEST bind failure');},path=>basename(String(path)).startsWith('showcase-safety-'));
  try{assert.throws(()=>temporaryJournal(),/TEST bind failure/);}finally{restore();}
  assert.deepEqual(showcaseDirectories(),before);
});

test('temporary journal refuses a FIFO swapped in just before the directory is opened, without blocking',()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
  let restore,writer;
  try{
    restore=swapBefore(['openSync'],()=>{
      renameSync(root,moved);
      assert.equal(spawnSync('mkfifo',['-m','600',root]).status,0,'mkfifo');
      // A writer keeps a regression (no O_DIRECTORY) from blocking the test.
      writer=openSync(root,constants.O_RDWR|constants.O_NONBLOCK);
    },path=>path===root);
    assert.throws(()=>fixture({path:temp.path,directoryIdentity:temp.identity}),{code:'ENOTDIR'});
    restore();restore=undefined;
    assert.deepEqual(readdirSync(moved),[]);
  }finally{
    restore?.();if(writer!==undefined)closeSync(writer);
    if(existsSync(moved)){rmSync(root,{force:true});renameSync(moved,root);}
    temp.close();
  }
});

test('directory binding is descriptor or path, and DACS_SHOWCASE_DIRECTORY_BINDING=path forces the fallback',()=>{
  const previous=process.env.DACS_SHOWCASE_DIRECTORY_BINDING;
  try{
    assert.match(directoryBinding(),/^(descriptor|path)$/);
    process.env.DACS_SHOWCASE_DIRECTORY_BINDING='path';assert.equal(directoryBinding(),'path');
    process.env.DACS_SHOWCASE_DIRECTORY_BINDING='descriptor';assert.throws(()=>directoryBinding(),/must be unset or path/);
  }finally{if(previous===undefined)delete process.env.DACS_SHOWCASE_DIRECTORY_BINDING;else process.env.DACS_SHOWCASE_DIRECTORY_BINDING=previous;}
});

// Emulates a platform without /proc (macOS) on any host.
test('without /proc/self/fd the driver falls back to path checks and leaves nothing behind',async()=>{
  const before=showcaseDirectories(),missing=path=>{if(String(path).startsWith('/proc/'))throw Object.assign(new Error(`ENOENT: ${path}`),{code:'ENOENT'});};
  const restore=interceptFs(Object.fromEntries(['statSync','readdirSync','rmSync'].map(name=>[name,(real,path,...rest)=>{missing(path);return real(path,...rest);}])));
  try{
    assert.equal(directoryBinding(),'path');
    const lines=[];
    const [unavailable]=await runShowcase('unavailable',line=>lines.push(line));
    assert.equal(unavailable.status,'unknown');
    assert.match(lines.join('\n'),/path checks only \(no \/proc\/self\/fd\)/);
    const [lost]=await runShowcase('lost-payment',()=>{});
    assert.equal(lost.hash,lost.recoveredHash);assert.equal(lost.broadcasts,1);
  }finally{restore();}
  assert.deepEqual(showcaseDirectories(),before);
});

test('driver reports a scenario error, not a later cleanup failure',async()=>{
  const before=showcaseDirectories();let opens=0;
  const ours=path=>basename(String(path)).startsWith('showcase-safety-')||String(path).startsWith('/proc/self/fd/');
  const restore=interceptFs({
    // The first open binds the new directory; the fixture's open is the scenario's.
    openSync:(real,path,...rest)=>{if(ours(path)&&++opens===2)throw new Error('TEST scenario failure');return real(path,...rest);},
    readdirSync:(real,path,...rest)=>{if(ours(path))throw new Error('TEST cleanup failure');return real(path,...rest);},
  });
  try{
    await assert.rejects(runShowcase('unavailable',()=>{}),error=>{
      assert.equal(error.message,'TEST scenario failure');assert.equal(error.suppressed?.message,'TEST cleanup failure');return true;
    });
  }finally{
    restore();
    for(const name of showcaseDirectories())if(!before.includes(name))rmSync(join(tmpdir(),name),{recursive:true,force:true});
  }
});

test('temporary journal refuses a symlink swapped in just before the directory is opened',()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original';
  let restore;
  try{
    restore=swapBefore(['openSync'],()=>{renameSync(root,moved);symlinkSync(moved,root);},path=>path===root);
    // With O_NOFOLLOW|O_DIRECTORY, Linux reports a trailing symlink as ENOTDIR.
    assert.throws(()=>fixture({path:temp.path,directoryIdentity:temp.identity}),error=>['ELOOP','ENOTDIR'].includes(error.code));
    restore();restore=undefined;
    assert.deepEqual(readdirSync(moved),[]);
  }finally{
    restore?.();
    if(existsSync(moved)){rmSync(root,{force:true});renameSync(moved,root);}
    temp.close();
  }
});

// Each change below is undone inside SQLite's first statement, so only the
// descriptor check before the open can refuse it.
test('temporary journal refuses a directory that is no longer private, even if restored after the open',async()=>{
  const temp=temporaryJournal();
  let opened,restoreExec;
  try{
    chmodSync(dirname(temp.path),0o750);
    restoreExec=onFirstExec(()=>chmodSync(dirname(temp.path),0o700));
    assert.throws(()=>{opened=fixture({path:temp.path,directoryIdentity:temp.identity});},/must stay private/);
  }finally{restoreExec?.();await opened?.close();chmodSync(dirname(temp.path),0o700);temp.close();}
});

test('temporary journal refuses a directory swapped in before it is opened, even if swapped back after the open',async()=>{
  const temp=temporaryJournal(),root=dirname(temp.path),moved=root+'-original',copyRoot=root+'-copy';
  let reopened,restore,restoreExec;
  try{
    await replacementCopy(temp,copyRoot);
    restore=swapBefore(['openSync'],()=>{renameSync(root,moved);renameSync(copyRoot,root);},path=>path===root);
    restoreExec=onFirstExec(()=>{renameSync(root,copyRoot);renameSync(moved,root);});
    assert.throws(()=>{reopened=fixture({path:temp.path,mode:'open',directoryIdentity:temp.identity});},/directory identity changed/);
  }finally{
    restore?.();restoreExec?.();await reopened?.close();
    if(existsSync(moved)){rmSync(root,{recursive:true,force:true});renameSync(moved,root);}
    rmSync(copyRoot,{recursive:true,force:true});
    temp.close();
  }
});

test('restart reopen refuses a different journal placed in the checked directory',{timeout:15000},async()=>{
  const temp=temporaryJournal();
  try{
    await assert.rejects(restartScenario(temp.path,'journal',temp.identity,{afterKill:()=>{
      for(const suffix of ['','-wal','-shm'])rmSync(temp.path+suffix,{force:true});
      openDurableWalletJournal({path:temp.path,mode:'create'}).close();
    }}),{code:'journal-integrity',message:/differs from the expected journal/});
  }finally{temp.close();}
});

test('offline transcript and documentation describe network isolation and local restart IPC',async()=>{
  const lines=[];await runShowcase('recipient',line=>lines.push(line));
  const doc=readFileSync(new URL('../docs/SHOWCASE-SAFETY.md',import.meta.url),'utf8');
  assert.match(lines[0],/no network sockets or external requests/);
  assert.match(doc,/no network sockets or external requests/);
  assert.match(doc,/local parent-child IPC channel/);
  assert.doesNotMatch(lines.join('\n')+'\n'+doc,/no sockets|never opens a socket/);
});

test('recipient substitution refuses the reviewed payment before authorization/signing: zero broadcasts',async()=>{
  const [result]=await runShowcase('recipient',()=>{});
  assert.equal(result.signatures,0);assert.equal(result.broadcasts,0);
});
test('unavailable evidence stays unknown, with the raw unavailable reader result: zero broadcasts',async()=>{
  const [result]=await runShowcase('unavailable',()=>{});
  assert.equal(result.status,'unknown');assert.equal(result.observation.status,'unavailable');assert.equal(result.broadcasts,0);
});
test('lost payment acknowledgement reconciles the original operation by readback: exactly one broadcast',async()=>{
  const [result]=await runShowcase('lost-payment',()=>{});
  assert.equal(result.hash,result.recoveredHash);assert.equal(result.broadcasts,1);
});
test('SIGKILL after journal retention inside broadcast survives restart: same hash, exactly one broadcast',{timeout:15000},async()=>{
  const [result]=await runShowcase('restart',()=>{});
  assert.equal(result.hash,result.recoveredHash);assert.equal(result.disposition,'included');assert.equal(result.broadcasts,1);
});
test('SIGKILL between journal and transport handoff stays readback-only: same hash, zero broadcasts',{timeout:15000},async()=>{
  const [result]=await runShowcase('restart-before-broadcast',()=>{});
  assert.equal(result.hash,result.recoveredHash);assert.equal(result.disposition,'pending');assert.equal(result.broadcasts,0);
});
test('delayed, missing and unavailable output never completes or implies a refund: exactly one broadcast',async()=>{
  const [result]=await runShowcase('delivery',()=>{});
  assert.deepEqual(result.states.map(({state})=>state),['delayed','missing','read-failed']);
  for(const state of result.states){assert.equal(state.disposition,'indeterminate');assert.equal(state.stage,'payment-evidenced');}
  assert.equal(result.broadcasts,1);
});
test('scenario wallet signs fresh RPC auth for every request, and the transport refuses it replayed or stale',async()=>{
  const temp=temporaryJournal();
  try{
    const h=fixture({path:temp.path,directoryIdentity:temp.identity});
    try{
      const before=Date.now(),prepared=await h.prepare();await prepared.send();
      assert.equal(prepared.auth.length,2);
      const [confirm,broadcast]=prepared.auth;
      assert.ok(Number(confirm.timestamp)<Number(broadcast.timestamp));
      for(const {timestamp} of prepared.auth)assert.ok(Number(timestamp)>=before&&Number(timestamp)<=Date.now()+1);
      assert.equal(await h.broadcastCount(),1);
      const reconfirm=(headers)=>h.capability.rpc({method:'execute',params:[{extra:'confirmTx',data:prepared.tx}]},headers);
      for(const headers of prepared.auth)await assert.rejects(reconfirm(headers),{code:'wallet_auth_replayed'});
      // The fixed stamp this fixture once reused for every request.
      const stale=String(prepared.tx.content.timestamp);
      assert.ok(Math.abs(Number(stale)-Date.now())>120000);
      await assert.rejects(reconfirm(prepared.signAuth(stale)),{code:'wallet_auth_stale'});
      assert.equal(await h.broadcastCount(),1);
    }finally{await h.close();}
  }finally{temp.close();}
});
test('driver prints labelled transcripts and refuses unknown scenarios',async()=>{
  const lines=[];await runShowcase('recipient',line=>lines.push(line));
  assert.match(lines.join('\n'),/OFFLINE SAFETY SHOWCASE.*\n\[recipient\]/s);
  assert.match(lines.join('\n'),/Signatures: 0; broadcasts: 0/);
  await assert.rejects(runShowcase('live',()=>{}),/choose all or/);
});
