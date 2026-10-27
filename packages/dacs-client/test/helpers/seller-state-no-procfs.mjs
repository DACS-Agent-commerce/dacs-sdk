// TEST preload (`--import`): this Node process sees no /proc, as on macOS and
// the BSDs, and `sysctl -n kern.boottime` answers in their format with this
// boot's time (the `btime` of /proc/stat, read before /proc is hidden). `ps` is
// the host's own. With TEST_SELLER_STATE_SYSCTL=absent, sysctl fails too, as on
// a host with no boot identity at all. Node children inherit it only through
// NODE_OPTIONS or their execArgv.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const btime = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1];
const hidden = (path) => /^\/proc(?:\/|$)/.test(String(path));
const absent = (path) => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT', errno: -2, path: String(path) });
for (const name of ['statSync', 'lstatSync', 'readFileSync', 'openSync', 'readdirSync', 'existsSync']) {
  const real = fs[name];
  fs[name] = function hide(path, ...rest) {
    if (!hidden(path)) return real.call(this, path, ...rest);
    if (name === 'existsSync') return false;
    throw absent(path);
  };
}
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function sysctl(file, args, ...rest) {
  if (file === 'sysctl' && args?.[0] === '-n' && args[1] === 'kern.boottime') {
    if (process.env.TEST_SELLER_STATE_SYSCTL === 'absent') throw Object.assign(new Error('TEST sysctl: unknown oid'), { status: 1 });
    // The microseconds vary per answer here, as a small adjustment would: the boot id uses whole seconds.
    return `{ sec = ${btime}, usec = ${Math.floor(Math.random() * 1e6)} } ${new Date(Number(btime) * 1000).toUTCString()}\n`;
  }
  return execFileSync.call(this, file, args, ...rest);
};
syncBuiltinESMExports();
