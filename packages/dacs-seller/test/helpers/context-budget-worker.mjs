// Pause one legitimate process after its ledger read, before admission.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';

const [input] = await once(process, 'message');
const readFile = fs.readFile; let paused = false;
fs.readFile = async (path, ...args) => {
  if (path !== input.config.evidencePath || paused) return readFile(path, ...args);
  paused = true;
  let value, failure;
  try { value = await readFile(path, ...args); } catch (error) { failure = error; }
  const continued = once(process, 'message'); process.send({ type: 'reading' }); await continued;
  if (failure) throw failure;
  return value;
};
syncBuiltinESMExports();
try {
  const { createSellerContextAdmission } = await import('../../src/devnet-demo/operator-approval.mjs');
  const value = await createSellerContextAdmission({ ...input.config, now: () => 300 }).reserve(input.reserve);
  process.send({ type: 'result', value });
} catch (error) {
  process.send({ type: 'error', code: error.code, message: error.message });
  process.exitCode = 1;
} finally { process.disconnect(); }
