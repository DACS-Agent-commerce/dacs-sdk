// The one parser for feature switch files, src/switches/<env>.switch
// (docs/SWITCHES.md). src/config.mjs reads its switches with it when it is
// imported. The deploy checks (deploy/scripts/lib/rules.mjs) load this file
// from the package root they check, so a file the runtime refuses is refused
// at build time with the same message. No dependencies and no side effects.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SWITCH_DIR = 'src/switches';
// Strict JSON, but not named .json: the packaging checks refuse any
// wallet-named *.json path, which DACS_WALLET_* would be.
export const SWITCH_SUFFIX = '.switch';
const SWITCH_KEYS = new Set(['env', 'configKey', 'kind', 'values', 'default', 'deployValue', 'held', 'order', 'operatorNote', 'contractNote']);

// path is relative to the package root; detail is the reason alone.
export class SwitchFileError extends Error {
  constructor(file, detail) {
    const path = file === null ? `${SWITCH_DIR}/` : `${SWITCH_DIR}/${file}`;
    super(`${path}: ${detail}`);
    this.name = 'SwitchFileError';
    this.path = path;
    this.detail = detail;
  }
}

// The first key that occurs twice in one object of already-valid JSON text
// (JSON.parse silently keeps the last), or null.
function duplicateKey(text) {
  const objects = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = objects.at(-1);
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === '{') objects.push({ keys: new Set(), expectKey: true });
    else if (c === '[') objects.push(null);
    else if (c === '}' || c === ']') objects.pop();
    else if (c === ',' && objects.at(-1)) objects.at(-1).expectKey = true;
  }
  return null;
}

export function parseSwitch(file, text) {
  const fail = (detail) => new SwitchFileError(file, detail);
  let entry;
  try {
    entry = JSON.parse(text);
  } catch (error) {
    throw fail(`not valid JSON (${error.message})`);
  }
  const duplicate = duplicateKey(text);
  if (duplicate !== null) throw fail(`duplicate key ${JSON.stringify(duplicate)} (JSON.parse would keep only the last)`);
  const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('must be a JSON object');
  for (const key of Object.keys(entry)) if (!SWITCH_KEYS.has(key)) throw fail(`unknown field ${key}`);
  if (!/^DACS_[A-Z0-9_]+$/.test(entry.env ?? '') || file !== `${entry.env}${SWITCH_SUFFIX}`) throw fail('env must be a DACS_ name equal to the file name');
  if (!/^[a-z][A-Za-z0-9]*$/.test(entry.configKey ?? '')) throw fail('configKey must be a camelCase identifier');
  if (!nonEmpty(entry.operatorNote)) throw fail('operatorNote is required');
  if (entry.contractNote !== undefined && !nonEmpty(entry.contractNote)) throw fail('contractNote must be a non-empty string');
  if (entry.order !== undefined && !Number.isFinite(entry.order)) throw fail('order must be a number');
  const held = entry.held ?? {};
  if (!held || typeof held !== 'object' || Array.isArray(held) || !Object.values(held).every(nonEmpty)) throw fail('held must map values to error messages');
  let values;
  if (entry.kind === 'flag') {
    // Exactly '1' enables; any other value (absent, empty, '0', 'true') is off and never refused.
    if (entry.values !== undefined) throw fail('a flag has no values (exactly 1 enables it)');
    if (entry.default !== '0') throw fail('a flag defaults to 0');
    values = ['0', '1'];
  } else if (entry.kind === 'enum') {
    values = entry.values;
    if (!Array.isArray(values) || values.length < 2 || !values.every(nonEmpty) || new Set(values).size !== values.length) throw fail('values must be two or more distinct strings');
    if (!values.includes(entry.default)) throw fail('default must be one of values');
  } else {
    throw fail('kind must be enum or flag');
  }
  if (!Object.keys(held).every((v) => values.includes(v) && v !== entry.default)) throw fail('held values must be non-default values');
  if (entry.deployValue !== null && (!values.includes(entry.deployValue) || Object.hasOwn(held, entry.deployValue))) throw fail('deployValue must be null or an accepted value');
  // A deploy that does not list the switch runs its default, so the two must agree.
  if (entry.deployValue !== null && entry.deployValue !== entry.default) throw fail('deployValue must equal default when it is set (a deploy that does not list the switch runs the default)');
  return Object.freeze({ ...entry, held: Object.freeze({ ...held }), ...(entry.values ? { values: Object.freeze([...values]) } : {}) });
}

// Reads every switch file in dir (a path or file URL). Returns { switches,
// errors }: the valid switches in check order (ascending order, then env
// name; no order = last), and every SwitchFileError in the order the runtime
// meets them. The runtime refuses the package on the first error.
export function readSwitchFiles(dir) {
  const root = typeof dir === 'string' ? dir : fileURLToPath(dir);
  const errors = [];
  const fail = (file, detail) => errors.push(new SwitchFileError(file, detail));
  const done = (entries = []) => Object.freeze({ switches: Object.freeze(entries), errors: Object.freeze(errors) });
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    fail(null, 'the directory is missing; the package is incomplete (every package ships its switch files)');
    return done();
  }
  if (!stat.isDirectory()) {
    fail(null, stat.isSymbolicLink() ? 'must be a directory, not a symbolic link' : 'must be a directory');
    return done();
  }
  // Nothing else lives here (dotfiles aside), so a misnamed switch file is never silently ignored.
  const files = readdirSync(root).filter((f) => !f.startsWith('.')).sort();
  if (!files.length) {
    fail(null, 'has no switch files; the package is incomplete');
    return done();
  }
  const entries = [];
  for (const file of files) {
    if (!file.endsWith(SWITCH_SUFFIX)) {
      fail(file, `not a ${SWITCH_SUFFIX} file`);
      continue;
    }
    // npm pack leaves symbolic links out, so only a regular file ships as validated.
    const type = lstatSync(join(root, file));
    if (!type.isFile()) {
      fail(file, type.isSymbolicLink() ? 'must be a regular file, not a symbolic link' : 'must be a regular file');
      continue;
    }
    try {
      entries.push(parseSwitch(file, readFileSync(join(root, file), 'utf8')));
    } catch (error) {
      if (!(error instanceof SwitchFileError)) throw error;
      errors.push(error);
    }
  }
  const keys = new Set();
  for (const entry of entries) {
    if (keys.has(entry.configKey)) fail(`${entry.env}${SWITCH_SUFFIX}`, `configKey ${entry.configKey} is used by another switch`);
    keys.add(entry.configKey);
  }
  // Checked in this order, so with several invalid switches the first error is fixed.
  const rank = (e) => e.order ?? Infinity;
  return done(entries.sort((a, b) => rank(a) - rank(b) || (a.env < b.env ? -1 : 1)));
}

// The switches in check order; throws the first SwitchFileError.
export function loadSwitchFiles(dir) {
  const { switches, errors } = readSwitchFiles(dir);
  if (errors.length) throw errors[0];
  return switches;
}
