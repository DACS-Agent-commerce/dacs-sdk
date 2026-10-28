// TEST preload (`--import`): right after this process first checks its own new
// lease file (`holders/<uuid>.sqlite`), and before SQLite opens it, the file is
// removed, as another process's pruning would remove a lease file not yet
// locked. SQLite then creates a new file at that path.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const lstatSync = fs.lstatSync;
let raced = false;
fs.lstatSync = function race(path, ...rest) {
  const stat = lstatSync.call(this, path, ...rest);
  if (!raced && /\/holders\/[0-9a-f-]{36}\.sqlite$/.test(String(path))) { raced = true; fs.unlinkSync(path); }
  return stat;
};
syncBuiltinESMExports();
