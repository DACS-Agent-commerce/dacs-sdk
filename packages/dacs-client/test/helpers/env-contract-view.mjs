// The env contract as every deploy check sees it (env-contract.json plus the
// switch files in src/switches/) and the env names the runtime reads. Tests
// assert these instead of a committed digest of src/config.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { envContract, readSwitchRegistry, runtimeEnvNames } from '../../deploy/scripts/lib/rules.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function contractView() {
  return envContract(JSON.parse(readFileSync(new URL('../../deploy/env-contract.json', import.meta.url), 'utf8')), root);
}

export function runtimeNames() {
  return runtimeEnvNames(readFileSync(new URL('../../src/config.mjs', import.meta.url), 'utf8'), readSwitchRegistry(root).entries);
}
