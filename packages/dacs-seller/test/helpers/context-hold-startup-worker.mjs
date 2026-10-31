import { readFile } from 'node:fs/promises';
import { createSellerTransportStore } from '../../src/dacs/seller-transport-auth.mjs';
import { createSellerContextAdmission } from '../../src/devnet-demo/operator-approval.mjs';
import { acquireSellerStateLock } from '../../src/devnet-demo/seller-state-lock.mjs';
import { dirname } from 'node:path';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const lock = await acquireSellerStateLock(dirname(config.path));
const store = createSellerTransportStore({ path: config.path, now: () => config.now });
try {
  const policy = createSellerContextAdmission({ ...config, now: () => config.now, transportStore: store });
  const released = await policy.ready;
  const admitted = await policy.reserve(config.next);
  process.stdout.write(JSON.stringify({ released, admitted }));
} finally { store.close(); lock.release(); }
