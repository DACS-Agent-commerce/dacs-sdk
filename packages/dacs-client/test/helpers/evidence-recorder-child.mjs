// Test-owned independent Node process: records one wallet result through the
// evidence recorder over the caller's journal file, then prints the answer.
// Modes: `record`, `killBeforeAppend` and `killAfterAppend` (SIGKILL on that side
// of the journal append). No network, no keys.
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createPurchaseEvidenceRecorder } from '../../src/passive-evidence-recorder.mjs';

const [path, mode, deliveryId, hash, nonce, state] = process.argv.slice(2);
const real = openDurableWalletJournal({ path, mode: 'open' });
const die = () => process.kill(process.pid, 'SIGKILL');
const journal = {
  get: real.get,
  entries: real.entries,
  withWalletLock: real.withWalletLock,
  async appendUnderLock(...args) {
    if (mode === 'killBeforeAppend') die();
    await real.appendUnderLock(...args);
    if (mode === 'killAfterAppend') die();
  },
};
const recorder = createPurchaseEvidenceRecorder({ admission: { binding: {}, currentLocal: () => ({}) }, journal });
const answer = await recorder.recordWalletResult({ deliveryId, hash, nonce: Number(nonce), state });
process.stdout.write(JSON.stringify(answer));
real.close();
