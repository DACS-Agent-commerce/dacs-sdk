// The kit-client contract harness: every test file under test/kit-client, one process at a time.
// Every test process, children included, gets the harness loader through NODE_OPTIONS.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('../test/kit-client/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort();
const loader = pathToFileURL(fileURLToPath(new URL('../test/kit-client/test-loader.mjs', import.meta.url))).href;
const nodeOptions = [process.env.NODE_OPTIONS, '--import=' + loader].filter(Boolean).join(' ');
const args = ['--experimental-vm-modules', '--test', '--test-concurrency=1', ...files.map((name) => 'test/kit-client/' + name)];
const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: nodeOptions } });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
