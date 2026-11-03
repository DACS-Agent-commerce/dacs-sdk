// Test-owned independent Node process for the durable wallet journal. It opens
// the caller's explicit database and runs IPC commands. No network, no keys.
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';

const journal = openDurableWalletJournal({ path: process.env.DACS_DURABLE_JOURNAL_PATH, mode: 'open', lockTimeoutMs: Number(process.env.DACS_DURABLE_JOURNAL_LOCK_MS ?? 2000) });
const releases = new Map();
const send = (message) => new Promise((resolve) => process.send(message, resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const handlers = {
  async hold({ key, record }) {
    return journal.withWalletLock(key, async () => {
      if (record) await journal.put(key, record);
      const released = new Promise((resolve) => releases.set(key, resolve));
      await send({ event: 'locked', key });
      await released;
      return { released: key };
    });
  },
  release({ key }) { releases.get(key)?.(); return { ok: true }; },
  // Retain the exact public intent, report it, then die before any "send".
  async crashAfterRecord({ key, record }) {
    return journal.withWalletLock(key, async () => {
      await journal.put(key, record);
      if (JSON.stringify(await journal.get(key)) !== JSON.stringify(record)) throw new Error('readback differs');
      await send({ event: 'recorded', key });
      process.kill(process.pid, 'SIGKILL');
      await delay(10_000);
    });
  },
  async increment({ key, counterKey, times }) {
    for (let i = 0; i < times; i += 1) {
      await journal.withWalletLock(key, async () => {
        const current = (await journal.get(counterKey)) ?? { count: 0, writers: [] };
        await delay(1);
        await journal.put(counterKey, { count: current.count + 1, writers: [...current.writers, process.pid].slice(-4) });
      });
    }
    return { done: times };
  },
  async tryLock({ key }) {
    const started = Date.now();
    try { await journal.withWalletLock(key, async () => {}); return { acquired: true, elapsedMs: Date.now() - started }; } catch (error) { return { acquired: false, code: error.code, elapsedMs: Date.now() - started }; }
  },
  async get({ key }) { return { value: (await journal.get(key)) ?? null }; },
};

process.on('message', async (message) => {
  try { await send({ id: message.id, ok: true, result: await handlers[message.op](message) }); } catch (error) { await send({ id: message.id, ok: false, code: error.code ?? 'child-error', message: error.message }); }
});
process.on('disconnect', () => process.exit(0));
await send({ event: 'ready', pid: process.pid, instance: journal.instance });
