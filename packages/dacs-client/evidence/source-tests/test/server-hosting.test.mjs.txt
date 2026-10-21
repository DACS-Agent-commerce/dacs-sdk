import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { checkLayout, checkPortThreshold, groupWarnings, OPERATOR_ENV_SWITCHES, preflight } from '../deploy/v\u0070s/preflight.mjs';
import { backupOnline, checkSpace, openStateFile } from '../deploy/v\u0070s/backup.mjs';
import { restoreState, verifyBackup } from '../deploy/scripts/state-backup.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';

// The kit targets Ubuntu. These run on Linux (CI, the server) and are unrun elsewhere.
const LINUX_ONLY=(why)=>process.platform==='linux'?false:`Linux-only: ${why}; unrun on ${process.platform}`;

const SERVER_DIRECTORY = ['v', 'ps'].join('');
const kit=fileURLToPath(new URL(`../deploy/${SERVER_DIRECTORY}/`,import.meta.url));
const read=name=>readFileSync(join(kit,name),'utf8');
function work(t){const path=mkdtempSync(join(tmpdir(),'dacs-server-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
const config=()=>({format:'dacs-node2-demo-operator/v1',sellerApproval:{mode:'policy'},publicOrigin:'http://127.0.0.1:987',sellerOrigin:'https://127.0.0.1:990',directoryOrigin:'http://127.0.0.1:991',externalOrigin:'https://dacs.example.com',stateDirectory:'/var/lib/dacs-operator/state',custodyDirectory:'/var/lib/dacs-operator/custody',networkAdmissionPath:'/etc/dacs-operator/admission.json',sellerTls:{keyPath:'/etc/dacs-operator/seller-key.pem',certificatePath:'/etc/dacs-operator/seller-cert.pem'}});
const env={DACS_PUBLIC_ORIGIN:'https://dacs.example.com',HOST:'127.0.0.1',PORT:'987'};

test('unit restricts privilege, writes, resources and listener authority',()=>{
  const unit=read('dacs-operator.service');
  for(const key of ['User=dacs-operator','Group=dacs-operator','Restart=on-failure','KillMode=mixed','KillSignal=SIGTERM','TimeoutStopSec=5min','EnvironmentFile=/etc/dacs-operator/dacs.env','NoNewPrivileges=yes','ProtectSystem=strict','ProtectHome=yes','PrivateTmp=yes','ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectKernelLogs=yes','RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6','CapabilityBoundingSet=CAP_NET_BIND_SERVICE','AmbientCapabilities=CAP_NET_BIND_SERVICE','PrivateIPC=yes','TemporaryFileSystem=/dev/shm','SystemCallFilter=@system-service','SystemCallErrorNumber=EPERM','RestrictNamespaces=yes','InaccessiblePaths=/var/lib/dacs-operator/backups','LockPersonality=yes','MemoryMax=2G','CPUQuota=200%','TasksMax=256','LimitCORE=0','RuntimeDirectoryMode=0700','LogNamespace=dacs-operator'])assert.ok(unit.split('\n').includes(key),key);
  assert.match(unit,/Environment=HOST=127\.0\.0\.1 PORT=987/);
  // EnvironmentFile= overrides Environment=, so dacs.env cannot change NODE_ENV only if the command line pins it.
  assert.ok(unit.split('\n').includes('ExecStart=/usr/bin/env NODE_ENV=production /bin/bash deploy/v\u0070s/console.sh'),'NODE_ENV is pinned on the command line');
  assert.match(unit,/ExecStartPre=.*preflight\.mjs \/etc\/dacs-operator\/operator\.json/);
  assert.equal(unit.match(/^ReadWritePaths=(.*)$/m)[1],'/var/lib/dacs-operator/state /run/dacs-operator');
  assert.match(unit,/# Node.*JIT.*WASM.*\nMemoryDenyWriteExecute=no/);
  assert.match(read('dacs-operator-health.service'),/deploy\/healthcheck\.mjs --ready/);
  assert.match(read('dacs-operator-backup.timer'),/Persistent=true/);
  assert.match(read('journald-retention.conf'),/SystemMaxUse=200M/);
  assert.match(read('Caddyfile.example'),/\{\$DACS_DOMAIN\}.*reverse_proxy 127\.0\.0\.1:987/s);
  const caddy=read('Caddyfile.example');
  assert.match(caddy,/handle @public/);assert.match(caddy,/handle \{\s+respond 404/);
  assert.doesNotMatch(caddy,/\/health|@public path .* \/\*/);
  for(const path of ['/mcp','/oauth/*','/.well-known/oauth-protected-resource/mcp','/portal/link','/portal/authorize/*','/portal/api/*','/portal/assets/*'])assert.ok(caddy.includes(path),path);
  for(const name of ['dacs-operator-backup.service','dacs-operator-health.service'])assert.match(read(name),/^InaccessiblePaths=\/var\/lib\/dacs-operator\/custody \/etc\/dacs-operator -\/run\/dacs-operator$/m);
  // /run/dacs-operator exists only while the operator runs (RuntimeDirectory=, removed at stop). Without "-" a
  // missing path fails namespace setup (226/NAMESPACE), so the stopped-operator backup and report could not start.
  assert.doesNotMatch(unit,/^RuntimeDirectoryPreserve=/m);
  for(const name of ['dacs-operator-backup.service','dacs-operator-health.service','dacs-operator-ops-health.service']){
    const paths=read(name).split('\n').filter(line=>line.startsWith('InaccessiblePaths=')).flatMap(line=>line.slice('InaccessiblePaths='.length).split(' '));
    assert.ok(paths.includes('-/run/dacs-operator')&&!paths.includes('/run/dacs-operator'),`${name} hides the runtime directory only when it exists`);
  }
  for(const name of ['dacs-operator-backup.service','dacs-operator-ops-health.service'])assert.doesNotMatch(read(name),/^(Requires|Requisite|BindsTo|PartOf)=.*dacs-operator\.service/m,`${name} runs with the operator stopped`);
  // main's stuck-purchase report runs on a timer, read-only and offline, from the state alone.
  const opsHealth=read('dacs-operator-ops-health.service').split('\n');
  for(const key of ['Type=oneshot','User=dacs-operator','ExecStart=/usr/bin/node /opt/dacs-operator/http-mcp/bin/dacs-ops-health.mjs --operator-state /var/lib/dacs-operator/state','Environment=TMPDIR=/tmp','PrivateTmp=yes','PrivateNetwork=yes','ProtectSystem=strict','NoNewPrivileges=yes','CapabilityBoundingSet=','LogNamespace=dacs-operator',
    'InaccessiblePaths=/var/lib/dacs-operator/custody /var/lib/dacs-operator/backups /etc/dacs-operator -/run/dacs-operator'])assert.ok(opsHealth.includes(key),key);
  assert.ok(!opsHealth.some(line=>/^(ReadWritePaths|EnvironmentFile)=/.test(line)),'the report writes nothing and reads no config');
  assert.match(read('dacs-operator-ops-health.timer'),/^OnUnitActiveSec=10min$/m);assert.match(read('dacs-operator-ops-health.timer'),/^Unit=dacs-operator-ops-health\.service$/m);
  assert.ok(existsSync(fileURLToPath(new URL('../bin/dacs-ops-health.mjs',import.meta.url))),'the report the unit runs exists');
  assert.doesNotMatch(read('backup.mjs'),/\/etc\/dacs-operator|\/custody/);
  const attach=read('attach.sh');
  assert.deepEqual([...attach.matchAll(/-p ([A-Za-z]+=[^ \\\n]+)/g)].map(match=>match[1]),['User=dacs-operator','ProtectSystem=strict','ProtectHome=yes','NoNewPrivileges=yes','PrivateNetwork=yes']);
  assert.match(attach,/systemd-run --pty --wait --collect/);assert.match(attach,/SUDO_UID/);assert.match(attach,/SUDO_USER/);
  assert.match(attach,/\/usr\/bin\/tmux -S \/run\/dacs-operator\/tmux.sock attach/);
  for(const options of [{},{SUDO_UID:'0',SUDO_USER:'root'},{SUDO_UID:'1001',SUDO_USER:'operator-admin'}])assert.notEqual(spawnSync('/bin/bash',[join(kit,'attach.sh')],{env:options}).status,0);
  assert.match(read('console.sh'),/exit "\$status"/);
  assert.match(read('pane.sh'),/exit-status\.tmp && mv -f /);
  assert.match(read('pane.sh'),/devnet-demo-compose\.mjs --config=\/etc\/dacs-operator\/operator\.json --signal-ready-file=\/run\/dacs-operator\/node\.pid < \/dev\/tty &/);
  assert.doesNotMatch(read('pane.sh'),/> \/run\/dacs-operator\/node\.pid/);
  assert.doesNotMatch(read('console.sh'),/i<25/);
  assert.match(read('pane.sh'),/trap finish EXIT/);
  assert.match(read('pane.sh'),/pipe-pane -O 'exec \/usr\/bin\/systemd-cat/);
  assert.match(read('pane.sh'),/< \/dev\/tty &/);
  assert.match(read('tmux.conf'),/default-shell \/bin\/bash/);
});

test('installer refuses agent-owned checkout and unsafe directories, parents and source files before planning',{skip:LINUX_ONLY('the installer uses GNU stat -c')},t=>{
  // A checkout that is already root-owned throughout (a container running as
  // root) passes the installer's ownership checks; the fixture below covers them.
  const trusted=path=>{const info=lstatSync(path);return !info.isSymbolicLink()&&info.uid===0&&(info.mode&0o022)===0;};
  const ancestors=path=>path==='/'?['/']:[path,...ancestors(join(path,'..'))];
  if(![join(kit,'install.sh'),...ancestors(join(kit,'.'))].every(trusted)){
    const refused=spawnSync('/bin/bash',[join(kit,'install.sh')],{encoding:'utf8'});
    assert.equal(refused.status,1);assert.match(refused.stderr,/root ownership and no group\/other writes/);assert.equal(refused.stdout,'');
  }
  const root=work(t),parent=join(root,'parent'),staged=join(parent,'kit');
  mkdirSync(parent,{mode:0o755});mkdirSync(staged,{mode:0o755});
  // Only the kit's files: a tool may leave a directory (such as a local cache directory) here.
  for(const entry of readdirSync(kit,{withFileTypes:true}))if(entry.isFile())writeFileSync(join(staged,entry.name),read(entry.name),{mode:0o644});
  // Model root ownership in an unprivileged worker; retain actual type/mode checks
  // for the fixture subtree. Production always uses the absolute system PATH.
  const original=read('install.sh');
  const shim=`stat() {
    local path="\${@: -1}" field="$2"
    if [[ "$path" == '${parent}'* ]]; then
      if [[ "$path" == '${parent}' && \${TEST_NONROOT:-0} == 1 ]]; then printf '1001 755\\n'; return; fi
      if [[ "$field" == '%u %a' ]]; then printf '0 %s\\n' "$(/usr/bin/stat -c '%a' -- "$path")"; else /usr/bin/stat "$@"; fi
    else printf '0 755\\n'; fi
  }
`;
  writeFileSync(join(staged,'install.sh'),original.replace('refuse() {',shim+'refuse() {'));
  const run=(extra={})=>spawnSync('/bin/bash',[join(staged,'install.sh')],{encoding:'utf8',env:{...process.env,...extra}});
  const accepted=run();assert.equal(accepted.status,0,accepted.stderr);
  assert.match(accepted.stdout,/--dry-run install -d -o root -g root -m 0755 \/opt\/dacs-operator/);
  assert.match(accepted.stdout,/--dry-run install -d -o root -g dacs-operator -m 0750 \/etc\/dacs-operator/);
  assert.match(accepted.stdout,/--dry-run install -o root -g dacs-operator -m 0640/);
  assert.doesNotMatch(accepted.stdout,/systemctl (start|enable)|wallet\.json/);
  for(const unit of ['dacs-operator-ops-health.service','dacs-operator-ops-health.timer'])assert.match(accepted.stdout,new RegExp(`--dry-run install -o root -g root -m 0644 \\S+/${unit.replace('.','\\.')} /etc/systemd/system/${unit.replace('.','\\.')}`),unit);
  for(const path of [staged,parent,join(staged,'dacs-operator.service')]){
    chmodSync(path,path.endsWith('.service')?0o664:0o775);
    const result=run();assert.equal(result.status,1);assert.match(result.stderr,/root ownership and no group\/other writes/);assert.equal(result.stdout,'');
    chmodSync(path,path.endsWith('.service')?0o644:0o755);
  }
  const badParent=run({TEST_NONROOT:'1'});assert.equal(badParent.status,1);assert.match(badParent.stderr,/root ownership/);assert.equal(badParent.stdout,'');
  rmSync(join(staged,'dacs-operator.service'));symlinkSync(join(staged,'dacs-operator-health.service'),join(staged,'dacs-operator.service'));
  assert.match(run().stderr,/symlink/);
  assert.match(original,/PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin/);
  assert.doesNotMatch(original,/chown (?!-h)/);
});

test('preflight rejects manual/missing approvals and accepts policy without importing live code',t=>{
  for(const sellerApproval of [undefined,{mode:'manual'},{mode:'policy '}])assert.throws(()=>preflight({...config(),sellerApproval},env),/unattended startup requires sellerApproval.mode="policy"/);
  assert.equal(preflight(config(),env),true);
  for(const update of [{publicOrigin:'http://0.0.0.0:987'},{sellerOrigin:'https://dacs.example.com:990'},{directoryOrigin:'http://127.0.0.1:987'},{externalOrigin:'http://dacs.example.com'},{stateDirectory:'/tmp/state'},{custodyDirectory:'/tmp/custody'},{networkAdmissionPath:'/etc/dacs-seller/admission.json'},{networkAdmissionPath:'/etc/dacs-operator/..'},{sellerTls:{keyPath:'/tmp/key.pem',certificatePath:'/etc/dacs-operator/seller-cert.pem'}}])assert.throws(()=>preflight({...config(),...update},env));
  assert.throws(()=>preflight(config(),{...env,DACS_PUBLIC_ORIGIN:'https://old.example.com'}),/probe environment must match/);
  // dacs.env reaches the operator: every key it reads from its environment is refused there, even at its off value.
  const reads=new Set(),src=fileURLToPath(new URL('../src/',import.meta.url));
  const sources=[...readdirSync(src,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.mjs')).map(entry=>join(entry.parentPath,entry.name)),fileURLToPath(new URL('../scripts/devnet-demo-compose.mjs',import.meta.url))];
  for(const path of sources)for(const match of readFileSync(path,'utf8').matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[/g))reads.add(match[1]??`dynamic read in ${path}`);
  assert.deepEqual([...reads].sort(),[...OPERATOR_ENV_SWITCHES].sort(),'preflight refuses exactly the keys the operator reads from its environment');
  for(const key of OPERATOR_ENV_SWITCHES)for(const value of ['on','off','1'])assert.throws(()=>preflight(config(),{...env,[key]:value}),new RegExp(`the operator reads ${key} from its environment; remove them from dacs\\.env`),key);
  // The README names the same switches, and how many.
  const named=read('README.md').split('the operator reads ')[1].split('Preflight refuses')[0];
  assert.match(named,new RegExp(`^${['zero','one','two','three','four','five','six','seven'][OPERATOR_ENV_SWITCHES.length]}\\s`));
  for(const key of OPERATOR_ENV_SWITCHES)assert.ok(named.includes(`\`${key}\``),`README names ${key}`);
  // Dependencies read NODE_ENV (express error pages); dacs.env may only repeat the unit's value.
  for(const value of ['development','test',''])assert.throws(()=>preflight(config(),{...env,NODE_ENV:value}),/NODE_ENV must be production/,value);
  assert.equal(preflight(config(),{...env,NODE_ENV:'production'}),true);
  const root=work(t),path=join(root,'operator.json');
  writeFileSync(path,JSON.stringify({...config(),sellerApproval:{mode:'manual'}}));
  const refused=spawnSync(process.execPath,[join(kit,'preflight.mjs'),path],{encoding:'utf8',env:{...process.env,...env}});
  assert.equal(refused.status,1);assert.match(refused.stderr,/\x56PS preflight refused: unattended startup/);
  writeFileSync(path,JSON.stringify(config()));
  // A worker is not the target host: CLI must refuse its sysctl/layout.
  const refusedHost=spawnSync(process.execPath,[join(kit,'preflight.mjs'),path],{encoding:'utf8',env:{...process.env,...env,DACS_ADMIN_USER:'admin'}});
  assert.equal(refusedHost.status,1);assert.match(refusedHost.stderr,/\x56PS preflight refused:/);
});

test('preflight requires reserved ports and warns from local privileged group membership',()=>{
  assert.equal(checkPortThreshold('1024\n'),undefined);
  for(const value of ['0','1023','1025',''])assert.throws(()=>checkPortThreshold(value),/must equal 1024/);
  for(const key of ['publicOrigin','sellerOrigin','directoryOrigin'])assert.throws(()=>preflight({...config(),[key]:config()[key].replace(/:\d+$/,':8790')},env));
  const groups=['docker:x:1:root,admin,operator-admin','adm:x:2:operator-admin','lxd:x:3:agent','disk:x:4:dacs-operator','sudo:x:5:operator-admin','systemd-journal:x:6:operator-admin','dacs-operator:x:7:admin'].join('\n');
  const warnings=groupWarnings(groups,'admin');assert.equal(warnings.length,6);assert.ok(warnings.every(warning=>!warning.startsWith('admin ')&&!warning.startsWith('root ')));
  assert.ok(groupWarnings(groups,'admin','primary:x:123:3::/nonexistent:/usr/sbin/nologin').some(warning=>warning.startsWith('primary is in privileged group lxd')));
  assert.throws(()=>groupWarnings(groups,'operator-admin'),/separate trusted admin/);
});

test('preflight checks root-owned code/config and service-owned private state with TLS key exception',async()=>{
  const directory=(uid,gid,mode)=>({uid,gid,mode,nlink:2,isDirectory:()=>true,isFile:()=>false,isSymbolicLink:()=>false});
  const file=(uid,gid,mode)=>({uid,gid,mode,nlink:1,isDirectory:()=>false,isFile:()=>true,isSymbolicLink:()=>false});
  const paths=new Map();
  for(const path of ['/','/opt','/var','/var/lib','/etc','/opt/dacs-operator','/var/lib/dacs-operator','/opt/dacs-operator/http-mcp'])paths.set(path,directory(0,0,0o755));
  paths.set('/opt/dacs-operator/http-mcp/app.mjs',file(0,0,0o644));
  paths.set('/etc/dacs-operator',directory(0,123,0o750));
  for(const name of ['operator.json','admission.json','seller-cert.pem'])paths.set(`/etc/dacs-operator/${name}`,file(0,123,0o640));
  paths.set('/etc/dacs-operator/seller-key.pem',file(123,123,0o600));
  for(const name of ['state','custody'])paths.set(`/var/lib/dacs-operator/${name}`,directory(123,123,0o700));
  for(const name of ['evidence','seller-sessions','seller-state'])paths.set(`/var/lib/dacs-operator/state/${name}`,directory(123,123,0o700));
  paths.set('/var/lib/dacs-operator/state/evidence/seller-approvals.jsonl',file(123,123,0o600));
  paths.set('/var/lib/dacs-operator/state/seller-sessions/key.json',file(123,123,0o600));
  paths.set('/var/lib/dacs-operator/state/seller-state/seller-state.sqlite',file(123,123,0o600));
  const options={uid:123,gid:123,inspect:async path=>{assert.ok(paths.has(path),path);return paths.get(path);},list:async path=>path==='/etc/dacs-operator'?['operator.json','admission.json','seller-cert.pem','seller-key.pem']:path==='/opt/dacs-operator/http-mcp'?['app.mjs']:path==='/var/lib/dacs-operator/state'?['evidence','seller-sessions','seller-state']:path.endsWith('/evidence')?['seller-approvals.jsonl']:path.endsWith('/seller-sessions')?['key.json']:path.endsWith('/seller-state')?['seller-state.sqlite']:[]};
  const check=()=>checkLayout(config(),'/etc/dacs-operator/operator.json',options);
  await check();
  for(const [path,update] of [['/var/lib/dacs-operator/state/evidence/seller-approvals.jsonl',{mode:0o640}],['/var/lib/dacs-operator/state/seller-sessions/key.json',{uid:0}],['/var/lib/dacs-operator/state/seller-sessions/key.json',{nlink:2}],['/var/lib/dacs-operator/state/seller-state',{isSymbolicLink:()=>true}],['/opt/dacs-operator',{uid:123}],['/etc/dacs-operator/operator.json',{uid:123}],['/etc/dacs-operator',{mode:0o770}],['/etc/dacs-operator/seller-key.pem',{uid:0}],['/opt/dacs-operator/http-mcp/app.mjs',{isSymbolicLink:()=>true}]]){
    const old=paths.get(path);paths.set(path,{...old,...update});await assert.rejects(check(),/unsafe/);paths.set(path,old);
  }
  // A SIGKILL between the private-file write's link and its unlink: still
  // refused, now named with its one safe recovery step, in either listing order.
  const key='/var/lib/dacs-operator/state/seller-sessions/key.json',temporary=`/var/lib/dacs-operator/state/seller-sessions/.key.json.${'ab'.repeat(24)}.tmp`;
  paths.set(key,{...file(123,123,0o600),nlink:2,ino:7,dev:1});paths.set(temporary,{...file(123,123,0o600),nlink:2,ino:7,dev:1});
  for(const order of [['key.json',temporary.split('/').pop()],[temporary.split('/').pop(),'key.json']]){
    const listed={...options,list:async path=>path.endsWith('/seller-sessions')?order:options.list(path)};
    await assert.rejects(checkLayout(config(),'/etc/dacs-operator/operator.json',listed),{message:`unfinished publication: ${temporary} is a second link to ${key}, left by a SIGKILL during a write; with the operator stopped, remove only ${temporary} (see "Unfinished publication" in the ${SERVER_DIRECTORY.toUpperCase()} README)`});
  }
  // A hard link that is not that pair (another inode, or a third link) keeps the plain refusal.
  for(const update of [{ino:8},{nlink:3}]){
    paths.set(temporary,{...file(123,123,0o600),nlink:2,ino:7,dev:1,...update});
    await assert.rejects(checkLayout(config(),'/etc/dacs-operator/operator.json',{...options,list:async path=>path.endsWith('/seller-sessions')?['key.json',temporary.split('/').pop()]:options.list(path)}),/^Error: unsafe owner, mode or type: /);
  }
  assert.match(read('README.md'),/### Unfinished publication/);
  // The README's state list names everything the operator opens directly under stateDirectory.
  const operatorSource=readFileSync(fileURLToPath(new URL('../src/devnet-demo/operator.mjs',import.meta.url)),'utf8');
  const named=new Set([...operatorSource.matchAll(/join\(config\.stateDirectory,'([^']+)'/g)].map(match=>match[1]));
  assert.ok(named.has('seller-party-vet.sqlite'));
  const list=read('README.md').split('The recursive state snapshot includes all of these')[1].split('\n\n')[1];
  for(const name of named)assert.ok(list.includes(`\`${name}`),`README state list names ${name}`);
});

test('online backup includes committed WAL and journals, verifies restore, retains only successful snapshots',{skip:LINUX_ONLY('the backup opens SQLite through /proc/self/fd')},async t=>{
  const root=work(t),state=join(root,'state'),backups=join(root,'backups');
  for(const path of [state,backups])mkdirSync(path,{mode:0o700});
  const db=new DatabaseSync(join(state,'wallet.sqlite'));t.after(()=>db.close());
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE records (stage TEXT); INSERT INTO records VALUES (\'issued-unknown\')');
  assert.ok(statSync(join(state,'wallet.sqlite-wal')).size>0);
  writeFileSync(join(state,'approvals.jsonl'),' {"decision":"approved"}\n',{mode:0o600});
  writeFileSync(join(state,'draft.json'),'{"version":1}\n',{mode:0o600});
  writeFileSync(join(state,'draft.json.tmp'),'{incomplete');
  const journals=['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite','seller-transport.sqlite','seller-state/seller-state.sqlite','app/dacs-chatgpt.sqlite'];
  for(const rel of journals){
    const parts=rel.split('/');if(parts.length>1)mkdirSync(join(state,parts[0]),{mode:0o700});
    const journal=new DatabaseSync(join(state,rel));journal.exec("CREATE TABLE records (stage TEXT); INSERT INTO records VALUES ('issued-unknown')");journal.close();chmodSync(join(state,rel),0o600);
  }
  const records=['evidence/seller-approvals.jsonl','evidence/buyer-approvals.jsonl','seller-state/sdk-agreements/job.json','seller-state/sdk-receipts/job.json','seller-sessions/key.json','seller-sessions/key.retired.json','buyer-runs/run.private.json'];
  for(const rel of records){
    mkdirSync(join(state,...rel.split('/').slice(0,-1)),{recursive:true,mode:0o700});
    writeFileSync(join(state,rel),rel.endsWith('.jsonl')?'{}\n':'{}',{mode:0o600});
  }
  const first=await backupOnline({stateDirectory:state,backupDirectory:backups,keep:1});
  assert.equal(verifyBackup({backupDir:first}).databases.length,7);
  assert.equal(statSync(first).mode&0o777,0o700);
  assert.equal(statSync(join(first,'state','wallet.sqlite')).mode&0o777,0o600);
  assert.equal(existsSync(join(first,'state','draft.json.tmp')),false);
  for(const rel of [...journals,...records])assert.equal(statSync(join(first,'state',rel)).mode&0o777,0o600,rel);
  const restored=join(root,'restored');restoreState({backupDir:first,dataDir:restored});
  for(const rel of journals){
    const journal=new DatabaseSync(join(restored,rel),{readOnly:true});
    try{assert.equal(journal.prepare('SELECT stage FROM records').get().stage,'issued-unknown',rel);}finally{journal.close();}
  }
  for(const rel of records){assert.equal(readFileSync(join(restored,rel),'utf8'),readFileSync(join(state,rel),'utf8'),rel);assert.equal(statSync(join(restored,rel)).mode&0o777,0o600,rel);}
  const copy=new DatabaseSync(join(restored,'wallet.sqlite'),{readOnly:true});
  try{assert.equal(copy.prepare('SELECT stage FROM records').get().stage,'issued-unknown');}finally{copy.close();}
  writeFileSync(join(state,'approvals.jsonl'),'{"decision":');
  await assert.rejects(backupOnline({stateDirectory:state,backupDirectory:backups,keep:1}),/incomplete journal/);
  assert.deepEqual(readdirSync(backups),[first.split('/').pop()]);
  writeFileSync(join(state,'approvals.jsonl'),' {"decision":"approved"}\n');
  const second=await backupOnline({stateDirectory:state,backupDirectory:backups,keep:1});
  assert.equal(existsSync(first),false);assert.ok(existsSync(second));
  symlinkSync(join(state,'draft.json'),join(state,'unsafe'));
  await assert.rejects(backupOnline({stateDirectory:state,backupDirectory:backups}),/regular files/);
  assert.ok(existsSync(second));
  assert.match(read('backup.mjs'),/backup as sqliteBackup/);
  assert.match(read('backup.mjs'),/await sqliteBackup\(db,target\)/);
});

test('backup pins identity with nofollow, rejects swaps/hardlinks, checks space and cleans only snapshot partials',async t=>{
  const root=work(t),state=join(root,'state'),backups=join(root,'backups');
  for(const path of [state,backups])mkdirSync(path,{mode:0o700});
  const path=join(state,'draft.json');writeFileSync(path,'{}',{mode:0o600});
  const earlier=lstatSync(path),old=join(root,'old.json');renameSync(path,old);symlinkSync(old,path);
  assert.throws(()=>openStateFile(path,earlier),/ELOOP/);
  rmSync(path);writeFileSync(path,'{}');assert.throws(()=>openStateFile(path,earlier),/changed identity/);
  linkSync(path,join(root,'hardlink'));assert.throws(()=>openStateFile(path,lstatSync(path)),/hardlinks/);
  await assert.rejects(backupOnline({stateDirectory:state,backupDirectory:backups}),/hardlinks/);rmSync(join(root,'hardlink'));
  const fd=openStateFile(path,lstatSync(path));closeSync(fd);
  assert.throws(()=>checkSpace(backups,1n,()=>({bavail:1n,bsize:1n})),/insufficient backup free space/);
  const partial=join(backups,'.snapshot-20261008T030000000Z-12345678-1234-1234-1234-123456789abc.partial');
  mkdirSync(partial);writeFileSync(join(partial,'leftover'),'incomplete');mkdirSync(join(backups,'.unrelated.partial'));
  await backupOnline({stateDirectory:state,backupDirectory:backups});assert.equal(existsSync(partial),false);assert.equal(existsSync(join(backups,'.unrelated.partial')),true);
  symlinkSync(state,partial);await assert.rejects(backupOnline({stateDirectory:state,backupDirectory:backups}),/unsafe partial cleanup/);assert.equal(existsSync(path),true);
});

// The shim stands in for tmux: new-session runs the console's real pane
// command (pane.sh, whose own tmux calls are no-ops here and whose TTY is
// /dev/null), and list-panes reports the operator pane. The fixture stands in
// for the compose CLI: like it, it publishes node.pid itself once its signal
// handlers are installed, here only after a startup delay, and it logs every
// signal it receives. Supervisor polls are accelerated.
const consoleCases=[
  ['waits for a delayed shutdown before cleaning up the pane',{onTerm:'drain'},0],
  ['keeps a stop that arrives while the pane is starting, and forwards it once Node has started',{onTerm:'drain',late:true,trigger:'session'},0],
  ['holds a stop that arrives before Node has installed its signal handlers until it has',{onTerm:'drain',handlerDelay:1000,trigger:'starting'},0],
  ['forwards one TERM to Node however many signals reach the pane',{onTerm:'drain',ctrlC:true},0],
  ['passes a nonzero shutdown status through',{onTerm:'status7'},7],
  ['exits 1 when the pane ends without a status',{onTerm:'dies'},1],
  ['exits 1 when the operator pane ends without a status in a split window',{onTerm:'dies',split:true},1],
  ['never signals the process named in node.pid',{onTerm:'drain',decoy:true},0],
  ['treats one failed tmux probe as unknown, not as the pane gone',{onTerm:'drain',failProbes:[3],probesBeforeStop:6},0],
  ['keeps waiting through repeated failed tmux probes and still reports the pane status',{onTerm:'status7',failProbes:'from 2',probesBeforeStop:8},7],
];
for(const [name,{onTerm,late=false,split=false,decoy=false,handlerDelay=0,trigger='node.pid',ctrlC=false,failProbes=[],probesBeforeStop=0},expected] of consoleCases)test(`console ${name}`,{timeout:15000},async t=>{
  const root=work(t),runtime=join(root,'run'),code=join(root,'code');
  mkdirSync(runtime,{mode:0o700});mkdirSync(join(code,'deploy',SERVER_DIRECTORY),{recursive:true});mkdirSync(join(code,'scripts'));
  const at=file=>JSON.stringify(join(root,file)),shim=join(root,'tmux.sh'),fixture=join(code,'scripts','devnet-demo-compose.mjs');
  const onSignal={drain:`setTimeout(()=>{writeFileSync(${at('drained')},'drained');process.exit(0);},800)`,status7:'process.exit(7)',dies:`writeFileSync(${at('dead')},'dead');process.kill(process.ppid,'SIGKILL');process.exit(0)`}[onTerm];
  // A live process whose PID the fixture publishes in node.pid instead of its own.
  const other=decoy?spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${at('decoy')},'TERM');process.exit(0);});require('node:fs').writeFileSync(${at('decoy-ready')},'ready');setInterval(()=>{},1000);`],{stdio:'ignore'}):null;
  if(other)t.after(()=>other.kill('SIGKILL'));
  writeFileSync(fixture,`import {appendFileSync,renameSync,writeFileSync} from 'node:fs';
writeFileSync(${at('starting')},String(process.pid));
const ready=process.argv.find(value=>value.startsWith('--signal-ready-file='))?.slice('--signal-ready-file='.length);
setTimeout(()=>{
  let stopping=false;
  const on=signal=>{appendFileSync(${at('signals')},signal+'\\n');if(stopping)return;stopping=true;${onSignal};};
  process.on('SIGTERM',()=>on('TERM'));process.on('SIGINT',()=>on('INT'));writeFileSync(${at('handlers')},'');
  if(ready){writeFileSync(ready+'.tmp','${decoy?other.pid:''}'||String(process.pid));renameSync(ready+'.tmp',ready);}
},${handlerDelay});
setInterval(()=>{},1000);
`);
  const failing=failProbes==='from 2'?'test "$n" -ge 2':failProbes.length?failProbes.map(n=>`test "$n" -eq ${n}`).join(' || '):'false';
  writeFileSync(shim,`#!/bin/bash
case "$*" in
  *new-session*) : > '${join(root,'session')}'${late?'; /bin/sleep 0.3':''}
    pane=\${*: -1}
    ( ${late?'/bin/sleep 0.5; ':''}exec $pane ) >/dev/null 2>&1 &
    printf '%s' "$!" > '${join(root,'pane-pid')}'
    echo "%7 $!" ;;
  *list-panes*) n=$(( $(cat '${join(root,'probes')}' 2>/dev/null || echo 0) + 1 )); echo "$n" > '${join(root,'probes')}'
    if ${failing}; then exit 1; fi
    test -f '${join(root,'session')}' || exit 1; if test -f '${join(root,'dead')}'; then echo '%7 1'; else echo '%7 0'; fi${split?"; echo '%8 0'":''} ;;
  *kill-server*) test -f '${join(runtime,'exit-status')}' || printf premature > '${join(root,'premature')}' ;;
esac
`);
  const rewrite=value=>value.replaceAll('/run/dacs-operator',runtime).replaceAll('/opt/dacs-operator/http-mcp',code).replaceAll('/usr/bin/tmux',`/bin/bash ${shim}`).replaceAll('/usr/bin/node',process.execPath).replace('< /dev/tty','< /dev/null');
  writeFileSync(join(code,'deploy',SERVER_DIRECTORY,'pane.sh'),rewrite(read('pane.sh')));
  writeFileSync(join(code,'deploy',SERVER_DIRECTORY,'console.sh'),rewrite(read('console.sh')).replace('umask 077','umask 077\nsleep() { /bin/sleep 0.01; }'));
  const waitFor=async(check,label)=>{const deadline=Date.now()+5000;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(check(),label);};
  const exists=file=>()=>existsSync(file);
  if(decoy)await waitFor(exists(join(root,'decoy-ready')),'decoy');
  const running=spawn('/bin/bash',['deploy/v\u0070s/console.sh'],{cwd:code,stdio:['ignore','pipe','pipe']}),exited=once(running,'exit');
  let stderr='';running.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{if(running.exitCode===null)running.kill('SIGKILL');if(existsSync(join(root,'starting'))){try{process.kill(Number(readFileSync(join(root,'starting'),'utf8')),'SIGKILL');}catch{}}});
  await waitFor(exists(trigger==='session'?join(root,'session'):trigger==='starting'?join(root,'starting'):join(runtime,'node.pid')),trigger);
  if(trigger!=='node.pid')assert.equal(existsSync(join(runtime,'node.pid')),false,'node.pid must not be published before Node has installed its signal handlers');
  if(probesBeforeStop){
    const probes=()=>Number(existsSync(join(root,'probes'))?readFileSync(join(root,'probes'),'utf8'):0);
    await waitFor(()=>probes()>=probesBeforeStop||running.exitCode!==null,'probes');
    assert.equal(running.exitCode,null,`a failed probe must not end the console: ${stderr}`);
    assert.match(stderr,/tmux probe failed; the operator pane counts as running/);
  }
  if(ctrlC){
    // Ctrl-C in the pane: SIGINT to pane.sh and Node, then a stop during the drain.
    await waitFor(exists(join(root,'handlers')),'handlers');
    const node=Number(readFileSync(join(root,'starting'),'utf8')),pane=Number(readFileSync(join(root,'pane-pid'),'utf8'));
    process.kill(node,'SIGINT');process.kill(pane,'SIGINT');
    await waitFor(()=>existsSync(join(root,'signals'))&&readFileSync(join(root,'signals'),'utf8').split('\n').length>2,'Node has the Ctrl-C and its forwarded TERM');
    process.kill(pane,'SIGTERM');
  }
  running.kill('SIGTERM');
  const [status]=await exited;assert.equal(status,expected,stderr);
  assert.equal(readFileSync(join(root,'signals'),'utf8'),ctrlC?'INT\nTERM\n':'TERM\n',ctrlC?'Node gets its Ctrl-C and one TERM':'SIGTERM reaches Node exactly once');
  if(onTerm==='drain'){assert.ok(existsSync(join(root,'drained')));assert.equal(existsSync(join(root,'premature')),false,'cleanup must wait for the shutdown result');}
  if(decoy)assert.equal(existsSync(join(root,'decoy')),false,'the process named in node.pid must not be signalled');
});

// pane.sh run directly, as tmux runs it: in its own process group, so a
// Ctrl-C at the pane's terminal reaches pane.sh and whatever runs in the
// foreground (a tmux call during setup, Node once spawned). Node's stand-in
// installs its handlers and publishes node.pid only after a delay.
const paneCases=[
  ['a double Ctrl-C during its tmux setup, before Node spawns: Node never starts',{setupDelay:1000}],
  ['two SIGINTs to the pane alone during its tmux setup, which then succeeds: Node never starts',{setupDelay:1000,group:false}],
  ['a double Ctrl-C after Node spawns, before its handlers and readiness',{handlerDelay:2000}],
];
for(const [name,{setupDelay=0,handlerDelay=0,group=true,selfTerm=false}] of [...paneCases.map(([name,options])=>[`${name}, as a stop: status 0`,options]),
  ['Node ended by a SIGTERM the pane did not ask for, as a failure: status 143',{selfTerm:true}]])test(`pane reports ${name}`,{timeout:15000},async t=>{
  const root=work(t),runtime=join(root,'run'),code=join(root,'code'),file=name=>join(root,name);
  mkdirSync(runtime,{mode:0o700});mkdirSync(join(code,'scripts'),{recursive:true});
  writeFileSync(join(code,'scripts','devnet-demo-compose.mjs'),`import {renameSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(file('starting'))},String(process.pid));${selfTerm?"process.kill(process.pid,'SIGTERM');":''}
const ready=process.argv.find(value=>value.startsWith('--signal-ready-file=')).slice('--signal-ready-file='.length);
setTimeout(()=>{process.on('SIGINT',()=>{});process.on('SIGTERM',()=>process.exit(0));writeFileSync(ready+'.tmp',String(process.pid));renameSync(ready+'.tmp',ready);},${handlerDelay});
setInterval(()=>{},1000);
`);
  const shim=file('tmux.sh');
  writeFileSync(shim,`#!/bin/bash\ncase "$*" in *set-option*) : > '${file('setup')}'; /bin/sleep ${setupDelay/1000} ;; esac\n`);
  const pane=file('pane.sh');
  writeFileSync(pane,read('pane.sh').replaceAll('/run/dacs-operator',runtime).replaceAll('/opt/dacs-operator/http-mcp',code).replaceAll('/usr/bin/tmux',`/bin/bash ${shim}`).replaceAll('/usr/bin/node',process.execPath).replace('< /dev/tty','< /dev/null'));
  const running=spawn('/bin/bash',[pane],{detached:true,stdio:['ignore','pipe','pipe']}),exited=once(running,'exit');
  let stderr='';running.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{try{process.kill(-running.pid,'SIGKILL');}catch{}});
  if(selfTerm){const [status]=await exited;assert.equal(status,143,stderr);assert.equal(readFileSync(join(runtime,'exit-status'),'utf8'),'143\n','only a requested stop is normalized');return;}
  await until(()=>existsSync(file(setupDelay?'setup':'starting')),setupDelay?'the pane is in its tmux setup':'Node has started');
  assert.equal(existsSync(join(runtime,'node.pid')),false,'the Ctrl-C comes before Node is ready');
  // The second Ctrl-C finds no process group if the first already ended the pane.
  for(let index=0;index<2;index++){try{process.kill(group?-running.pid:running.pid,'SIGINT');}catch(error){if(error.code!=='ESRCH'||index===0)throw error;}await new Promise(resolve=>setTimeout(resolve,50));}
  const [status,signal]=await exited;
  assert.equal(signal,null,stderr);assert.equal(status,0,`an administrative stop is not a failure for Restart=on-failure: ${stderr}`);
  assert.equal(readFileSync(join(runtime,'exit-status'),'utf8'),'0\n','the published status is 0');
  if(setupDelay)assert.equal(existsSync(file('starting')),false,'a stop before Node spawns means Node never starts');
  else assert.throws(()=>process.kill(Number(readFileSync(file('starting'),'utf8')),0),{code:'ESRCH'},'no Node is left running');
});

// The real compose CLI, with an operator module whose steps can be watched.
const compose=fileURLToPath(new URL('../scripts/devnet-demo-compose.mjs',import.meta.url));
const startCompose=(t,root,body,{wrap=null,stdin='ignore'}={})=>{
  const module=join(root,'operator.mjs'),ready=join(root,'node.pid');
  writeFileSync(module,`import {appendFileSync,writeFileSync} from 'node:fs';\nconst mark=(name,text='')=>appendFileSync(${JSON.stringify(root)}+'/'+name,text);\n${body}`);
  const argv=[compose,`--operator-module=${module}`,`--signal-ready-file=${ready}`];
  const child=wrap?spawn('script',['-qec',argv.map(value=>`'${value}'`).join(' ').replace(/^/,`'${process.execPath}' `),'/dev/null'],{stdio:['pipe','pipe','pipe']}):spawn(process.execPath,argv,{stdio:[stdin,'pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const exited=once(child,'exit');
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(existsSync(ready)){try{process.kill(Number(readFileSync(ready,'utf8')),'SIGKILL');}catch{}}});
  return{child,exited,ready,output:()=>output};
};
const until=async(check,label,ms=10000)=>{const deadline=Date.now()+ms;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(check(),label);};

test('compose CLI installs its handlers before startup, finishes the step in flight, and shares one shutdown across repeated signals',{timeout:30000},async t=>{
  const root=work(t),file=name=>join(root,name);
  const {exited,ready,output}=startCompose(t,root,`export async function prepareDevnetDemo(){
  mark('preparing');await new Promise(resolve=>setTimeout(resolve,1000));mark('prepared');
  return{composition:{},config:{},devnetAgreementTransport:{},close:async()=>{mark('close-calls','close\\n');await new Promise(resolve=>setTimeout(resolve,800));mark('closed');}};
}
export async function attachSellerAgent(){mark('attached');}
export async function listen(){mark('listened');}
`);
  await until(()=>existsSync(ready)&&existsSync(file('preparing')),'node.pid is published before startup waits');
  const pid=Number(readFileSync(ready,'utf8'));
  process.kill(pid,'SIGTERM');await new Promise(resolve=>setTimeout(resolve,100));process.kill(pid,'SIGINT');
  const ignored=()=>output().match(/ignored; the shutdown already started continues/g)?.length??0;
  await until(()=>ignored()===1,'a second signal during startup is ignored');
  await until(()=>existsSync(file('close-calls')),'shutdown closes the operator after the step in flight');
  // A double Ctrl-C and a second stop during the drain, each seen before the next.
  for(const [index,repeat] of ['SIGINT','SIGINT','SIGTERM'].entries()){process.kill(pid,repeat);await until(()=>ignored()===index+2,`${repeat} during the drain is ignored`);}
  const [code,signal]=await exited;
  assert.equal(signal,null,output());assert.equal(code,0,output());
  assert.ok(existsSync(file('prepared')),'the startup step in flight is finished, not cut');
  assert.ok(existsSync(file('closed')),'the drain completes');
  assert.equal(readFileSync(file('close-calls'),'utf8'),'close\n','one shared shutdown');
  for(const name of ['attached','listened'])assert.equal(existsSync(file(name)),false,`a stop during startup starts no further step: ${name}`);
  assert.match(output(),/devnet-operator: SIGTERM; shutting down/);
  assert.equal(ignored(),4,output());
});

test('compose CLI still fails a startup that fails without a stop',{timeout:30000},async t=>{
  const root=work(t);
  const {exited,output}=startCompose(t,root,`export async function prepareDevnetDemo(){throw new Error('fixture startup failure');}\n`);
  const [code]=await exited;assert.equal(code,1,output());assert.match(output(),/fixture startup failure/);
});

// A Listing prompt is declined by a stop instead (the Listing tests below).
test('compose CLI ends a stop at an APPROVE prompt unanswered: nothing is recorded, signed or sent',{timeout:30000,skip:LINUX_ONLY('util-linux script provides the TTY')},async t=>{
  if(spawnSync('/bin/bash',['-c','command -v script'],{encoding:'utf8'}).status!==0){t.skip('util-linux script is not installed');return;}
  const root=work(t),file=name=>join(root,name),approval=pathToFileURL(fileURLToPath(new URL('../src/devnet-demo/operator-approval.mjs',import.meta.url))).href;
  const {child,exited,output}=startCompose(t,root,`import {createExactOperatorApproval} from ${JSON.stringify(approval)};
export async function prepareDevnetDemo(){
  const approve=createExactOperatorApproval({maxTotalOs:'10',evidencePath:${JSON.stringify(join(root,'evidence','seller-approvals.jsonl'))}});
  mark('asking',String(process.pid));const answer=await approve({method:'sendTransaction',address:'0x${'1'.repeat(64)}',content:{artifactKind:'Deliverable',debit:{totalOs:'1'}}});mark('answered',String(answer));
  return{composition:{},config:{},devnetAgreementTransport:{},close:async()=>mark('closed')};
}
`,{wrap:'script'});
  await until(()=>existsSync(file('asking'))&&output().includes('Type APPROVE '),'the prompt is waiting');
  process.kill(Number(readFileSync(file('asking'),'utf8')),'SIGTERM');
  const started=Date.now();const [code]=await exited;child.stdin.end();
  assert.equal(code,0,output());assert.ok(Date.now()-started<5000,'the stop does not wait for an answer');
  assert.match(output(),/stopping at an APPROVE prompt; it ends unanswered, nothing was signed or sent/);
  assert.equal(existsSync(file('answered')),false);
  assert.equal(existsSync(join(root,'evidence','seller-approvals.jsonl')),false,'no approval decision is recorded');
});

// The real Listing publisher (listing.mjs) and the real TTY prompt, over an
// anchor that follows main's publish order (artifact-anchor.mjs): a retained
// intent is held; otherwise chain reads, then authorize() with no await, then
// the intent is journaled, then the wallet asks APPROVE <hash>. No pty here:
// the module marks its pipes as TTYs, which is all the prompt checks.
const listingOperator=(root,{readMs=1000,sendMs=0}={})=>{
  const url=path=>JSON.stringify(pathToFileURL(fileURLToPath(new URL(path,import.meta.url))).href);
  return `import {existsSync} from 'node:fs';
import {createDevnetDemoListingPublisher} from ${url('../src/devnet-demo/listing.mjs')};
import {createExactOperatorApproval} from ${url('../src/devnet-demo/operator-approval.mjs')};
import {DEM_RAIL} from ${url('../src/dacs/listing.mjs')};
import {createEphemeralWallet} from ${url('./fixtures/wallet.mjs')};
import {fixtureListing} from ${url('./fixtures/listings.mjs')};
process.stdin.isTTY=true;process.stdout.isTTY=true;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),intent=${JSON.stringify(join(root,'intent'))};
const anchor={async publish({logicalAddress,artifactKind,authorize}){
  if(existsSync(intent))return{status:'indeterminate',reason:'the original demo CREATE hash is not uniquely retained'};
  mark('reading');await sleep(${readMs});
  if(authorize!==undefined){const allowed=authorize();if(allowed!==true)throw new Error('not-authorized: '+allowed+'; no intent was stored and nothing was sent');}
  mark('intent',logicalAddress);
  const approve=createExactOperatorApproval({maxTotalOs:'10',evidencePath:${JSON.stringify(join(root,'evidence','seller-approvals.jsonl'))}});
  if(await approve({method:'sendTransaction',address:'0x${'1'.repeat(64)}',content:{artifactKind,debit:{totalOs:'1'}}})!==true)return{status:'rejected',reason:'user_rejected'};
  mark('approved');await sleep(${sendMs});mark('sent');
  return{status:'present',receipt:{nativeAddress:'stor-${'a'.repeat(64)}',transactionRef:{value:'0x${'b'.repeat(64)}'}}};
}};
const rails=()=>({trustPhase:'PA-1',trustPolicyAcceptsPA1:true,registry:{state:'not-used',entries:[],definitions:[]},inCodeDefinitions:[{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion,phaseHandler:'pay-dem',governanceAnchoring:'in-code',signatureValid:true}]});
export async function prepareDevnetDemo(){
  const wallet=createEphemeralWallet(),{signature:_signature,...draft}=fixtureListing(wallet,{listingId:'stop-before-intent'});
  await createDevnetDemoListingPublisher({anchor,sign:bytes=>wallet.signBytes(bytes),scanOwnListings:async()=>({status:'ok',anchors:[]}),loadRailResolution:rails})(draft);
  mark('published');
  return{composition:{},config:{},devnetAgreementTransport:{},close:async()=>mark('closed')};
}
`;
};

test('compose CLI: a stop before the Listing CREATE intent journals none, exits 0, and the next start asks for approval again',{timeout:30000},async t=>{
  const root=work(t),file=name=>join(root,name);
  const first=startCompose(t,root,listingOperator(root));
  await until(()=>existsSync(first.ready)&&existsSync(file('reading')),'the publication is reading the chain');
  process.kill(Number(readFileSync(first.ready,'utf8')),'SIGTERM');
  const [code,signal]=await first.exited;
  assert.equal(signal,null,first.output());assert.equal(code,0,first.output());
  assert.equal(existsSync(file('intent')),false,`a stop before the intent journals none: ${first.output()}`);
  assert.doesNotMatch(first.output(),/Type APPROVE /);
  assert.match(first.output(),/startup ended by the stop: .*not-authorized: the operator is stopping/);
  assert.equal(existsSync(file('closed')),false,'nothing was prepared, so nothing is closed');
  // The next start is not held: it reaches the exact APPROVE prompt again.
  rmSync(first.ready);
  const second=startCompose(t,root,listingOperator(root,{readMs:0}),{stdin:'pipe'});
  await until(()=>second.output().includes('Type APPROVE '),`the next start asks again: ${second.output()}`);
  assert.doesNotMatch(second.output(),/not uniquely retained/);
  assert.ok(existsSync(file('intent')),'main journals the intent before the prompt');
  process.kill(Number(readFileSync(second.ready,'utf8')),'SIGTERM');
  const [again]=await second.exited;second.child.stdin.end();
  assert.equal(again,0,second.output());
  assert.match(second.output(),/startup ended by the stop: .*user_rejected/,'a stop at the Listing prompt declines it');
  assert.doesNotMatch(second.output(),/stopping at an APPROVE prompt/);
  assert.equal(existsSync(join(root,'evidence','seller-approvals.jsonl')),false,'the owner decided nothing, so no decision is recorded');
});

test('compose CLI: a stop after APPROVE was answered lets the approved Listing publication finish',{timeout:30000},async t=>{
  const root=work(t),file=name=>join(root,name);
  const {child,exited,ready,output}=startCompose(t,root,listingOperator(root,{readMs:0,sendMs:1000}),{stdin:'pipe'});
  await until(()=>/Type APPROVE ([0-9a-f]{64}) /.test(output()),'the prompt is waiting');
  child.stdin.write(`APPROVE ${output().match(/Type APPROVE ([0-9a-f]{64}) /)[1]}\n`);
  await until(()=>existsSync(file('approved')),'the answer is accepted');
  process.kill(Number(readFileSync(ready,'utf8')),'SIGTERM');
  const [code]=await exited;child.stdin.end();
  assert.equal(code,0,output());
  assert.ok(existsSync(file('sent')),`an answered prompt is no longer pending: the approved send is not cut short: ${output()}`);
  assert.ok(existsSync(file('published'))&&existsSync(file('closed')),'the step in flight finishes, then the shutdown closes it');
  assert.doesNotMatch(output(),/stopping at an APPROVE prompt/);
  assert.match(readFileSync(join(root,'evidence','seller-approvals.jsonl'),'utf8'),/"decision":"approved"/);
});

// The real pieces instead: listing.mjs, main's artifact anchor, the packaged
// seller wallet, a durable SQLite artifact journal and the real TTY prompt,
// over the fixture chain. `slow` delays one node read by 3 s, as a slow node
// would; the wallet's getNetworkParameters comes after the intent and before
// the prompt.
const realListingOperator=(root,{slow=null}={})=>{
  const url=path=>JSON.stringify(pathToFileURL(fileURLToPath(new URL(path,import.meta.url))).href);
  return `import {createPrivateKey,sign} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
process.stdin.isTTY=true;process.stdout.isTTY=true;
// Sets the browser globals and loads the wallet runtime first (as party-vet-fixture.mjs).
await import(${url('./helpers/native-settlement-consumer-seller.mjs')});
const {startDevnetLiveCompositionTransport}=await import(${url('./helpers/devnet-live-composition-transport.mjs')});
const {createDevnetAgreementWalletTransport,createSdkWalletSession}=await import(${url('../public/portal/embedded-wallet/sdk-provider.mjs')});
const {fixtureListing}=await import(${url('./fixtures/listings.mjs')});
const {createOperatorBuyerAccess}=await import(${url('../src/devnet-demo/buyer-access.mjs')});
const {createDevnetDemoArtifactAnchor}=await import(${url('../src/devnet-demo/artifact-anchor.mjs')});
const {createDevnetDemoListingPublisher}=await import(${url('../src/devnet-demo/listing.mjs')});
const {createExactOperatorApproval}=await import(${url('../src/devnet-demo/operator-approval.mjs')});
const {openDurableWalletJournal}=await import(${url('../src/wallet/durable-journal.mjs')});
const {DEM_RAIL}=await import(${url('../src/dacs/listing.mjs')});
const at=name=>${JSON.stringify(root)}+'/'+name,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rails=()=>({trustPhase:'PA-1',trustPolicyAcceptsPA1:true,registry:{state:'not-used',entries:[],definitions:[]},inCodeDefinitions:[{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion,phaseHandler:'pay-dem',governanceAnchoring:'in-code',signatureValid:true}]});
let slowed=false;
export async function prepareDevnetDemo(){
  const harness=await startDevnetLiveCompositionTransport({rpcResponse:async parsed=>{
    if(!slowed&&parsed?.params?.[0]?.message===${JSON.stringify(slow)}){slowed=true;mark('slow-read');await sleep(3000);}
  }});
  globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:harness.origin+'/portal/assets/embedded-wallet/',currentScript:null};
  const {Demos,Identities,validateMnemonic}=await import(${url('../public/portal/embedded-wallet/demos-runtime.mjs')});
  // One seller and one Listing draft across starts, as the operator's custody and draft.
  if(!existsSync(at('phrase')))writeFileSync(at('phrase'),new Demos().newMnemonic(256),{mode:0o600});
  const phrase=readFileSync(at('phrase'),'utf8'),seller=new Demos();await seller.connectWallet(phrase,{algorithm:'ed25519'});
  const address=seller.getAddress().toLowerCase(),seed=Buffer.from(seller.keypair.privateKey).subarray(0,32);seller.disconnect();
  const key=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});
  const signer={address,claim:'did:demos:agent:'+address.slice(2),signBytes:bytes=>sign(null,Buffer.from(bytes),key)};
  const approve=createExactOperatorApproval({maxTotalOs:'100000000000000',evidencePath:at('evidence/seller-approvals.jsonl')});
  let delegate;
  const wallet=createSdkWalletSession({DemosCtor:Demos,IdentitiesCtor:Identities,validateMnemonic,transactionTransport:createDevnetAgreementWalletTransport(harness.capability.profile(harness.origin)),
    anchorJournal:{get:k=>delegate.get(k),put:(k,v)=>delegate.put(k,v),withWalletLock:(k,work)=>delegate.withWalletLock(k,work)},approve});
  await wallet.importMnemonic(phrase);
  const durable=openDurableWalletJournal({path:at('seller-artifacts.sqlite'),mode:existsSync(at('seller-artifacts.sqlite'))?'open':'create'});
  const journal={get:durable.get,entries:durable.entries,withWalletLock:durable.withWalletLock,put:async(k,v)=>{if(k.startsWith('demo/artifact/'))mark('artifact-stages',v.stage+'\\n');return durable.put(k,v);}};
  const anchor=createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:({anchorJournal})=>{delegate=anchorJournal;return wallet;},
    network:harness.capability.pins.network,signer:{claim:signer.claim,sign:signer.signBytes},buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})});
  const now=Number(readFileSync(at('now'),'utf8')),{signature:_signature,...draft}=fixtureListing(signer,{listingId:'stop-after-intent',version:1,now,notAfter:now+86400000});
  await createDevnetDemoListingPublisher({anchor,sign:signer.signBytes,scanOwnListings:async()=>({status:'ok',anchors:[]}),loadRailResolution:rails})(draft);
  // Startup holds here until the stop, which then closes this step only.
  mark('published');await new Promise(resolve=>process.once('SIGTERM',resolve));
  return{composition:{},config:{},devnetAgreementTransport:{},close:async()=>{mark('closed');wallet.lock();durable.close();await harness.close();}};
}
`;
};
const realListingRoot=t=>{
  const root=work(t);mkdirSync(join(root,'evidence'),{mode:0o700});writeFileSync(join(root,'now'),String(Date.now()-1000));
  return root;
};
const artifactJournal=(root,read)=>{const journal=openDurableWalletJournal({path:join(root,'seller-artifacts.sqlite'),mode:'open'});try{return read(journal);}finally{journal.close();}};
const stages=root=>existsSync(join(root,'artifact-stages'))?readFileSync(join(root,'artifact-stages'),'utf8').trim().split('\n'):[];

test('compose CLI: a stop after the Listing CREATE intent, before its prompt, declines it, and the next start asks again and publishes (real anchor, wallet and journal)',{timeout:120000},async t=>{
  const root=await realListingRoot(t);
  const first=startCompose(t,root,realListingOperator(root,{slow:'getNetworkParameters'}),{stdin:'pipe'});
  await until(()=>existsSync(first.ready)&&existsSync(join(root,'slow-read')),`the wallet reads the chain after the intent: ${first.output()}`,60000);
  assert.deepEqual(stages(root),['intent'],'the stop lands after the intent is journaled');
  assert.doesNotMatch(first.output(),/Type APPROVE /,'and before the prompt');
  process.kill(Number(readFileSync(first.ready,'utf8')),'SIGTERM');
  const [code,signal]=await first.exited;first.child.stdin.end();
  assert.equal(signal,null,first.output());assert.equal(code,0,first.output());
  assert.doesNotMatch(first.output(),/Type APPROVE |"approvalHash"/,'the stop declines the prompt before it is shown');
  assert.match(first.output(),/startup ended by the stop: .*user_rejected: the request was not approved; nothing was signed/);
  assert.deepEqual(stages(root),['intent','denied'],'the wallet refused before signing');
  assert.deepEqual(artifactJournal(root,journal=>journal.inspectLocks()),[],'no lock is left behind');
  assert.equal(existsSync(join(root,'evidence','seller-approvals.jsonl')),false,'no decision is recorded');
  // The next start is not held: it asks again, and an answer publishes the Listing.
  rmSync(first.ready);
  const second=startCompose(t,root,realListingOperator(root),{stdin:'pipe'});
  await until(()=>/Type APPROVE ([0-9a-f]{64}) /.test(second.output())||second.child.exitCode!==null,`the next start asks again: ${second.output()}`,60000);
  assert.doesNotMatch(second.output(),/not uniquely retained|held by another holder/);
  second.child.stdin.write(`APPROVE ${second.output().match(/Type APPROVE ([0-9a-f]{64}) /)[1]}\n`);
  await until(()=>existsSync(join(root,'published'))||second.child.exitCode!==null,`the approved Listing is published: ${second.output()}`,60000);
  assert.ok(existsSync(join(root,'published')),second.output());
  assert.deepEqual(stages(root),['intent','denied','intent','issued','verified'],'a fresh intent replaced the denied one, then one send');
  process.kill(Number(readFileSync(second.ready,'utf8')),'SIGTERM');
  const [again]=await second.exited;second.child.stdin.end();
  assert.equal(again,0,second.output());assert.ok(existsSync(join(root,'closed')),second.output());
  assert.deepEqual(artifactJournal(root,journal=>journal.inspectLocks()),[]);
  assert.equal(readFileSync(join(root,'evidence','seller-approvals.jsonl'),'utf8').match(/"decision":"approved"/g).length,1);
});

test('compose CLI: a crash after the Listing CREATE intent leaves its locks, and the next start names the owner\'s step (real anchor, wallet and journal)',{timeout:120000},async t=>{
  const root=await realListingRoot(t);
  const first=startCompose(t,root,realListingOperator(root,{slow:'getNetworkParameters'}),{stdin:'pipe'});
  await until(()=>existsSync(first.ready)&&existsSync(join(root,'slow-read')),`the wallet reads the chain after the intent: ${first.output()}`,60000);
  const pid=Number(readFileSync(first.ready,'utf8'));process.kill(pid,'SIGKILL');
  await first.exited;first.child.stdin.end();rmSync(first.ready);
  assert.deepEqual(stages(root),['intent']);
  const locks=artifactJournal(root,journal=>journal.inspectLocks());
  assert.deepEqual(locks.map(lock=>[lock.key.split('/').slice(0,2).join('/'),lock.pid]),[['demo/artifact',pid],['demo/wallet',pid]],'a crash leaves both lock rows');
  const second=startCompose(t,root,realListingOperator(root),{stdin:'pipe'});
  const [code]=await second.exited;second.child.stdin.end();
  assert.equal(code,1,second.output());
  assert.match(second.output(),/the wallet lane is held by another holder/);
  assert.match(second.output(),/a durable journal lock is held\. If no other operator process runs, a crash or SIGKILL left it: .*"Locks left by a crash" in deploy\/v\x70s\/README\.md/);
  assert.doesNotMatch(second.output(),/Type APPROVE /);
  // The README's step: release exactly those rows once the holder is gone.
  // The intent stays, read back only: the Listing is then held, never resent.
  artifactJournal(root,journal=>{for(const {key,instance,fence} of locks)journal.releaseAbandonedLock({key,instance,fence});});
  rmSync(second.ready,{force:true});
  const third=startCompose(t,root,realListingOperator(root),{stdin:'pipe'});
  const [held]=await third.exited;third.child.stdin.end();
  assert.equal(held,1,third.output());
  assert.match(third.output(),/the original demo CREATE hash is not uniquely retained/);
  assert.doesNotMatch(third.output(),/Type APPROVE |durable journal lock is held/);
  assert.deepEqual(stages(root),['intent'],'nothing new is journaled or sent');
});

test('private tmux supervisor preserves TTY review, propagates failure and gracefully stops a fixture',async t=>{
  const tmux=spawnSync('/bin/bash',['-c','command -v tmux'],{encoding:'utf8'}).stdout.trim();
  if(!tmux){t.skip('tmux is not installed; console lifecycle is unrun');return;}
  const root=work(t),runtime=join(root,'run'),code=join(root,'code');
  // A UNIX socket path has a 104-byte limit on macOS (108 on Linux).
  if(Buffer.byteLength(join(runtime,'tmux.sock'))>=104){t.skip(`the tmux socket path under ${tmpdir()} is too long for a UNIX socket; console lifecycle is unrun`);return;}
  mkdirSync(runtime,{mode:0o700});mkdirSync(join(code,'deploy',SERVER_DIRECTORY),{recursive:true});mkdirSync(join(code,'scripts'));
  const rewrite=value=>value.replaceAll('/run/dacs-operator',runtime).replaceAll('/opt/dacs-operator/http-mcp',code).replaceAll('/usr/bin/node',process.execPath).replaceAll('/usr/bin/tmux',tmux);
  for(const name of ['console.sh','pane.sh','tmux.conf'])writeFileSync(join(code,'deploy',SERVER_DIRECTORY,name),rewrite(read(name)));
  // Keep all activity local and capture console output without a host journal.
  const pane=join(code,'deploy',SERVER_DIRECTORY,'pane.sh');
  writeFileSync(pane,readFileSync(pane,'utf8').replace('exec /usr/bin/systemd-cat --identifier=dacs-console',`exec cat > ${join(root,'console.log')}`));
  const fixture=join(code,'scripts','devnet-demo-compose.mjs');
  writeFileSync(fixture,"if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(90);console.log('APPROVE fixture-hash');setTimeout(()=>process.exit(7),100);\n");
  const start=()=>spawn('/bin/bash',['deploy/v\u0070s/console.sh'],{cwd:code,stdio:['ignore','pipe','pipe']});
  const failed=start();let stderr='';failed.stderr.on('data',chunk=>{stderr+=chunk;});
  const [failure]=await once(failed,'exit');
  assert.equal(existsSync(join(runtime,'tmux.sock')),false,'console removes its socket on exit');
  if(failure===1&&stderr.includes('Operation not permitted')){t.skip('managed worker rejects tmux UNIX sockets; console lifecycle is unrun');return;}
  assert.equal(failure,7,stderr);
  assert.match(readFileSync(join(root,'console.log'),'utf8'),/APPROVE fixture-hash/);
  // Like the compose CLI, but with its signal handlers only after a startup
  // delay: the stop arrives first and must be held until node.pid is published.
  writeFileSync(fixture,`import {renameSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(root,'starting'))},'');
const ready=process.argv.find(value=>value.startsWith('--signal-ready-file=')).slice('--signal-ready-file='.length);
setTimeout(()=>{process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(join(root,'stopped'))},'stopped');process.exit(0);},300));writeFileSync(ready+'.tmp',String(process.pid));renameSync(ready+'.tmp',ready);},1000);
setInterval(()=>{},1000);
`);
  // Listen for exit at spawn time so an early refusal cannot be missed.
  const running=start(),runningExit=once(running,'exit');let runningErr='';running.stderr.on('data',chunk=>{runningErr+=chunk;});t.after(()=>{if(running.exitCode===null)running.kill('SIGKILL');spawnSync(tmux,['-S',join(runtime,'tmux.sock'),'kill-server']);});
  const deadline=Date.now()+5000;
  while(!existsSync(join(root,'starting'))&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(existsSync(join(root,'starting')),runningErr);
  assert.equal(existsSync(join(runtime,'node.pid')),false,'the stop arrives before the fixture has installed its handler');
  running.kill('SIGTERM');const [stopped]=await runningExit;
  assert.equal(stopped,0,runningErr);assert.ok(existsSync(join(root,'stopped')));
  assert.equal(existsSync(join(runtime,'tmux.sock')),false);
});
