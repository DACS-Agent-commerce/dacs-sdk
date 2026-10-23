import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSellerDurableState } from '../../src/dacs/seller-durable-state.mjs';
import { seller } from './protocol-fixture.mjs';
export async function durableFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-durable-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { dir, signer: { claim: seller.claim, sign: seller.signBytes }, listingPin: { contentHash: 'a'.repeat(64) }, ...options };
  const store = await createSellerDurableState(config); store.retainContext({ TEST: 'context' });
  return { dir, path: join(dir, 'seller-state.sqlite'), store, config, reopen: () => createSellerDurableState(config) };
}
