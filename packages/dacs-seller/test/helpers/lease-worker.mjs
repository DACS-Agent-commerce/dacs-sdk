// TEST child for process-lease.test.mjs. On directory argv[2], mode argv[3]:
// 'lease' takes its lease, 'lock' the seller state lock, 'section' the lock's
// takeover section, and 'probe' reads the state of lease argv[4]. It reports
// the outcome, then holds what it took until it is killed.
import Database from 'better-sqlite3';
import { leaseFile, leaseState, PROCESS_LEASE_ID, PROCESS_NAMESPACE, takeLease } from '../../src/dacs/process-lease.mjs';
import { acquireSellerStateLock } from '../../src/devnet-demo/seller-state-lock.mjs';

const [directory, mode = 'lease', probed] = process.argv.slice(2);
let section; // kept referenced, so the open transaction is never collected
const take = {
  lease: () => { takeLease(directory); return 'taken'; },
  lock: async () => { await acquireSellerStateLock(directory); return 'taken'; },
  section: () => { section = new Database(leaseFile(directory, 'takeover')); section.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); return 'taken'; },
  probe: () => leaseState(directory, probed),
};
let outcome;
try { outcome = await take[mode](); } catch (error) { outcome = error.reason ?? error.code ?? error.message; }
process.send({ outcome, process: PROCESS_LEASE_ID, namespace: PROCESS_NAMESPACE, pid: process.pid });
process.on('message', () => {});
