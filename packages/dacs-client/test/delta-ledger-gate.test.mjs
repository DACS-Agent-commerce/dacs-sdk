import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemble } from '../scripts/delta-assemble.mjs';
import { pkg } from '../scripts/delta-map.mjs';
test('the assembled records and checked-out head pass provenance and the four required refusals', () => {
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 assert.deepEqual(assemble(pkg).failures, [], 'every record satisfies its schema and declares its id');
 const result=spawnSync(process.execPath,['packages/dacs-client/scripts/check-provenance.mjs','--local-only'],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),encoding:'utf8',env});
 assert.equal(result.status,0,result.stdout+result.stderr);
 const cases=["^launch review: unrelated main commits and a PR merge preserve client provenance$","^the committed head passes and each archived record fault is refused$","^parallel records of different blobs conflict until a later record chooses one$","^an archived control-only record is refused with the ledger path"].join('|');
 const negatives=spawnSync(process.execPath,['--test','--test-concurrency=1','--test-name-pattern',cases,'packages/dacs-client/scripts/delta-provenance.test.mjs','packages/dacs-client/scripts/delta-frontier.test.mjs','packages/dacs-client/scripts/delta-continuity.test.mjs'],{cwd:fileURLToPath(new URL('../../..',import.meta.url)),encoding:'utf8',env});
 assert.equal(negatives.status,0,negatives.stdout+negatives.stderr);
 assert.match(negatives.stdout,/^# pass 4$/m,'all four required ledger cases ran');
});
