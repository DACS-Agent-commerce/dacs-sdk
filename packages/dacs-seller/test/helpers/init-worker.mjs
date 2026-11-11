// Runs `runInit` in its own process so a test can kill it or hold it at one named
// filesystem call, under a chosen umask. Only fs/promises is patched; the shipped
// code has no hook. Argument 1 is the data directory, argument 2 a JSON options text:
//   seed      the identity double's generated seed number
//   umask     process umask to set first
//   kill      { fn, n, when }: SIGKILL before or after the n-th call of fs/promises `fn`
//   pause     { fn, n }: after the n-th call returns, report "paused" and wait forever
//   barrier   report "at-mkdir" and wait for a message before every mkdir
//   guards    count network and signer calls instead of allowing them
import crypto from 'node:crypto';
import dns from 'node:dns';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { identityDouble } from './init-identity-fixture.mjs';

const [dataDirectory, optionsText] = process.argv.slice(2);
const options = JSON.parse(optionsText);
if (options.umask !== undefined) process.umask(options.umask);

const PAUSE_KEEPALIVE_MS = 60_000;
const seen = { eexist: 0, networkAttempts: 0, signs: 0 };
const calls = {};
const matches = (spec, name, count) => spec?.fn === name && spec.n === count;
for (const name of ['mkdir', 'chmod', 'link']) {
  const real = fsp[name];
  fsp[name] = async (...args) => {
    calls[name] = (calls[name] ?? 0) + 1;
    if (matches(options.kill, name, calls[name]) && options.kill.when === 'before') process.kill(process.pid, 'SIGKILL');
    if (name === 'mkdir' && options.barrier) {
      process.send({ stage: 'at-mkdir' });
      await new Promise(resolve => process.once('message', resolve));
    }
    let result;
    try { result = await real(...args); } catch (error) {
      if (name === 'mkdir' && error.code === 'EEXIST') seen.eexist += 1;
      throw error;
    }
    if (matches(options.kill, name, calls[name]) && options.kill.when === 'after') process.kill(process.pid, 'SIGKILL');
    if (matches(options.pause, name, calls[name])) { process.send({ stage: 'paused' }); setInterval(() => {}, PAUSE_KEEPALIVE_MS); await new Promise(() => {}); }
    return result;
  };
}
if (options.guards) {
  const refuse = counter => () => { seen[counter] += 1; throw new Error('TEST forbidden call'); };
  net.connect = net.createConnection = net.Socket.prototype.connect = dns.lookup = refuse('networkAttempts');
  crypto.sign = refuse('signs');
}
syncBuiltinESMExports();

const { runInit } = await import('../../src/cli/init.mjs');
const identity = identityDouble(options.seed ?? 3);
let stdout = '';
const finish = message => process.send({ ...message, ...seen, generated: identity.generated }, () => process.exit(0));
try {
  await runInit({ dataDirectory, identity, stdout: { write: text => { stdout += text; } } });
  finish({ stage: 'done', stdout });
} catch (error) {
  finish({ stage: 'error', code: error.code, detail: error.detail, stdout });
}
