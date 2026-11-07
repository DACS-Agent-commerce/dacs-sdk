import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { privateModule } from './private-module.mjs';

// operator-custody.mjs imports three sources that no part of the stack ships,
// so it cannot load as it is. This loads its real source with those three
// imports replaced by stubs, and with `node:fs/promises` replaced by a wrapper
// that records every file operation and can fail or interleave one.
const CUSTODY_URL = new URL('../../src/devnet-demo/operator-custody.mjs', import.meta.url);
const DURABLE_FILE_URL = new URL('../../src/devnet-demo/durable-file.mjs', import.meta.url);
let loads = 0;

const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

const demosRuntimeStub = (key) => `
const state = globalThis[${JSON.stringify(key)}];
export class Demos {
  newMnemonic() {
    state.generated += 1;
    if (state.failGenerationAt === state.generated) throw new Error('TEST key generation failed');
    return \`TEST mnemonic \${state.generated}\`;
  }
  async connectWallet(mnemonic) {
    if (state.failConnect) throw state.failConnect;
    this.mnemonic = mnemonic; this.keypair = { privateKey: new Uint8Array(32) };
  }
  getAddress() { return \`addr-\${this.mnemonic.replace(/\\W/g, '')}\`; }
  disconnect() { state.disconnected += 1; }
}
export function validateMnemonic(mnemonic) {
  if (state.failValidation) throw state.failValidation;
  return /^TEST mnemonic \\w+$/.test(mnemonic);
}`;
const sdkProviderStub = 'export const createSdkWalletSession = () => null; export const createDevnetAgreementWalletTransport = () => null;';
const demosSignatureStub = 'export const claimForAddress = (address) => ({ claimFor: address });';

const filesystemStub = (key) => `
import * as real from 'node:fs/promises';
export * from 'node:fs/promises';
const state = globalThis[${JSON.stringify(key)}];
const record = (...parts) => state.events.push(parts.join(' '));
export async function open(path, ...rest) {
  record('open', path, rest[0]);
  if (state.failOpen?.(path)) throw state.filesystemError;
  const handle = await real.open(path, ...rest);
  return new Proxy(handle, { get(target, property) {
    if (property === 'sync') return async () => {
      record('sync', path);
      if (state.failSync?.(path)) throw state.filesystemError ?? new Error('TEST sync failed');
      return target.sync();
    };
    if (property === 'close') return async () => { record('close', path); return target.close(); };
    if (property === 'writeFile') return async (data, ...more) => {
      record('write', path);
      if (state.failWrite?.(path)) { await target.writeFile(String(data).slice(0, 12)); throw new Error('TEST disk full'); }
      return target.writeFile(data, ...more);
    };
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
export async function mkdir(path, ...rest) {
  record('mkdir', path);
  await state.beforeMkdir?.(path);
  const created = await real.mkdir(path, ...rest);
  state.mkdirCreated.push(created);
  await state.afterMkdir?.(path);
  return created;
}
export async function readFile(path, ...rest) { record('readFile', path); return real.readFile(path, ...rest); }
export async function link(temporary, path) { record('link', temporary, path); await state.beforePublish?.(path); return real.link(temporary, path); }
export async function lstat(path, ...rest) {
  const info = await real.lstat(path, ...rest);
  await state.afterLstat?.(path, info);
  return info;
}
export async function unlink(path) { record('unlink', path); await state.beforeUnlink?.(path); return real.unlink(path); }
export async function writeFile(path, data, ...rest) {
  record('writeFile', path);
  await state.beforePublish?.(path);
  if (state.failWrite?.(path)) { await real.writeFile(path, String(data).slice(0, 12), ...rest); throw new Error('TEST disk full'); }
  return real.writeFile(path, data, ...rest);
}
`;

/**
 * Loads the real custody source with stubbed imports.
 * Returns the custody exports, the load's `state` (record of file operations in
 * `events`, and the hooks `failWrite(path)`, `beforePublish(path)`, `beforeMkdir(path)`, `afterMkdir(path)`,
 * `failOpen(path)`, `failSync(path)`, the injected `filesystemError`, the mkdir
 * results in `mkdirCreated`, `afterLstat(path, info)`, `beforeUnlink(path)`,
 * validation/connection errors and key-generation counters)
 * and `normalized(directory)`, which
 * returns the events with the directory and the temporary-file suffix masked.
 */
export async function loadCustody() {
  const key = `TEST_CUSTODY_FIXTURE_${(loads += 1)}`;
  const state = { events: [], generated: 0, disconnected: 0, failGenerationAt: null, failWrite: null, beforePublish: null,
    beforeUnlink: null, afterLstat: null, beforeMkdir: null, afterMkdir: null, mkdirCreated: [], failOpen: null, failSync: null, filesystemError: null };
  globalThis[key] = state;
  const fileSystem = dataUrl(filesystemStub(key));
  const swap = (source, replacements) => replacements.reduce((text, [from, to]) => text.split(from).join(to), source);
  // The durable-file module is new in this part; the earlier head has none.
  const durableFileUrl = existsSync(DURABLE_FILE_URL) ? dataUrl(swap(await readFile(DURABLE_FILE_URL, 'utf8'), [["'node:fs/promises'", JSON.stringify(fileSystem)]])) : null;
  const custody = await privateModule(CUSTODY_URL, [], (source) => swap(source, [
    ["'../../public/portal/embedded-wallet/sdk-provider.mjs'", JSON.stringify(dataUrl(sdkProviderStub))],
    ["'../wallet/demos-signature.mjs'", JSON.stringify(dataUrl(demosSignatureStub))],
    ["'../../public/portal/embedded-wallet/demos-runtime.mjs'", JSON.stringify(dataUrl(demosRuntimeStub(key)))],
    ["'node:fs/promises'", JSON.stringify(fileSystem)],
    ...(durableFileUrl ? [["'./durable-file.mjs'", JSON.stringify(durableFileUrl)]] : []),
  ]));
  const normalized = (directory) => state.events.map((event) => event.split(directory).join('<dir>').replace(/\.\d+\.[0-9a-f]+\.tmp/g, '.tmp'));
  return { ...custody, state, normalized, release: () => { delete globalThis[key]; } };
}
