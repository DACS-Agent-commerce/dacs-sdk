// Test-owned child for the source-read crash test. It opens the journal, starts one
// real source read whose node never answers, tells the parent it is inside the read
// and waits to be killed. No network, no keys.
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { queuedOwner } from './queued-owner.mjs';
import { sourceReadTransport } from './source-read-transport.mjs';

const journal = openDurableWalletJournal({ path: process.env.SOURCE_READ_JOURNAL_PATH, mode: 'open' });
const owner = queuedOwner({ fetchImpl: () => { process.send({ event: 'reading' }); return new Promise(() => {}); } });
const transport = sourceReadTransport({ journal, owner });
transport.readRpc('/', { method: 'nodeCall', params: [{ message: 'getNetworkInfo', data: {} }] }).catch(() => {});
