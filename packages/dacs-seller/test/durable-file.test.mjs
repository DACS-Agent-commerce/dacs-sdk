import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDirectory, syncFile } from '../src/devnet-demo/durable-file.mjs';

// The kernel refuses fsync on a character device (EINVAL), whose error text does not name the path.
const UNSYNCABLE_PATH = '/dev/null';

for (const [name, sync] of [['syncFile', syncFile], ['syncDirectory', syncDirectory]]) {
  test(`${name} names the path and keeps the original error as cause when the sync fails`, async () => {
    const error = await sync(UNSYNCABLE_PATH).then(() => assert.fail('the sync was expected to fail'), (caught) => caught);
    assert.ok(error.message.includes(UNSYNCABLE_PATH), error.message);
    assert.equal(error.cause?.code, 'EINVAL');
    assert.equal(error.code, 'EINVAL');
  });

  test(`${name} names the path and keeps the original error as cause when the path cannot be opened`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-file-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const missing = join(directory, 'missing');
    const error = await sync(missing).then(() => assert.fail('the sync was expected to fail'), (caught) => caught);
    assert.ok(error.message.includes(missing), error.message);
    assert.equal(error.cause?.code, 'ENOENT');
    assert.equal(error.code, 'ENOENT');
  });
}
