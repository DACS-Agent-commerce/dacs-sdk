// Preloaded into the settle worker: every file read first makes a fetch and swallows its failure, as code under test could.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const readFile = fs.readFile;
fs.readFile = async (...args) => {
  try { await globalThis.fetch('http://127.0.0.1:1/'); } catch { /* swallowed */ }
  return readFile(...args);
};
syncBuiltinESMExports();
