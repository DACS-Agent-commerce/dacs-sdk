import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemble, readArchive } from '../scripts/delta-assemble.mjs';
import { lastRecordOnlyFailures, pkg } from '../scripts/delta-map.mjs';
test('the assembled records and checked-out head pass provenance and the four required refusals; the last archive entry names a source or test change, or is a record-only entry that records, for each path, the blob committed at its own commit when no other entry, superseded ones included, and no record file committed before it, recorded that blob for the path', () => {
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 assert.deepEqual(assemble(pkg).failures, [], 'every record satisfies its schema and declares its id');
 const ledger=readArchive(pkg).ledger;
 const last=ledger.changes.at(-1),cwd=fileURLToPath(new URL('../../..',import.meta.url));
 if(last.files.some(file=>/packages\/dacs-client\/(src|test)\//.test(file.path)&&file.before!==file.after)) {
  const selected=spawnSync('git',['log','--no-merges','--format=%H','--fixed-strings',`--grep=${last.subject}`],{cwd,encoding:'utf8'});
  assert.equal(selected.status,0,selected.stderr);
  const sha=last.sha??selected.stdout.trim();
  const changed=spawnSync('git',['diff','--name-only',`${sha}^`,sha,'--','packages/dacs-client/src','packages/dacs-client/test'],{cwd,encoding:'utf8'});
  assert.equal(changed.status,0,changed.stderr);
  assert.ok(last.files.some(file=>changed.stdout.split('\n').includes(file.path)&&file.before!==file.after),'last record selects a commit that actually changes its recorded source or test');
 } else assert.deepEqual(lastRecordOnlyFailures(ledger),[],'last ledger record names a source or test change, or records a committed blob that no other record recorded');
 const result=spawnSync(process.execPath,['packages/dacs-client/scripts/check-provenance.mjs','--local-only'],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),encoding:'utf8',env});
 assert.equal(result.status,0,result.stdout+result.stderr);
 const cases=["^launch review: unrelated main commits and a PR merge preserve client provenance$","^the committed head passes and each archived record fault is refused$","^parallel records of different blobs conflict until a later record chooses one$","^an archived control-only record is refused with the ledger path"].join('|');
 const negatives=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-name-pattern',cases,'packages/dacs-client/scripts/delta-provenance.test.mjs','packages/dacs-client/scripts/delta-frontier.test.mjs','packages/dacs-client/scripts/delta-continuity.test.mjs'],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),encoding:'utf8',env});
 assert.equal(negatives.status,0,negatives.stdout+negatives.stderr);
 assert.match(negatives.stdout,/^# pass 4$/m,'all four required ledger cases ran');
});
