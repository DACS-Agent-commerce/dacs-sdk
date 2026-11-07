// Test-owned independent Node process: runs one native send or CREATE recovery
// on the caller's journal and kills itself the moment the scripted node is asked
// to broadcast, with the wallet lane lock still held. No network, no funds.
//   DACS_LOCK_ORDER_JOURNAL  absolute path of an existing journal
//   DACS_LOCK_ORDER_SCENARIO 'leased-broadcast' (nonce 2) or 'recovery' (nonce 1)
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createWorld, JOB_IDS } from './native-create-world.mjs';

const journal = openDurableWalletJournal({ path: process.env.DACS_LOCK_ORDER_JOURNAL, mode: 'open' });
const world = createWorld({ journal, onNode: async (message) => {
  if (message !== 'broadcastTx') return;
  await new Promise((resolve) => process.send({ event: 'at-broadcast', sentBefore: world.sent.broadcasts.length }, resolve));
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
} });

if (process.env.DACS_LOCK_ORDER_SCENARIO === 'recovery') {
  await world.recover(await world.makeCreate(JOB_IDS[0], 1));
} else {
  const tx = await world.makeCreate(JOB_IDS[1], 2);
  const lease = await world.lease();
  await world.broadcast(lease, await world.confirm(tx), tx.hash);
}
throw new Error('the scripted node was never asked to broadcast');
