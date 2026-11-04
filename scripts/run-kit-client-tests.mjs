// The kit-client contract harness: the test files named on the command line, one process at a time.
// Every test process, children included, gets the harness loader through NODE_OPTIONS.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = process.argv.slice(2);
// Without file arguments `node --test` would discover and run every test file under the repository.
if (files.length === 0) throw new Error('no test files given: run npm run kit-client:test');
const loader = pathToFileURL(fileURLToPath(new URL('../test/kit-client/test-loader.mjs', import.meta.url))).href;
const nodeOptions = [process.env.NODE_OPTIONS, '--import=' + loader].filter(Boolean).join(' ');
const args = ['--experimental-vm-modules', '--test', '--test-concurrency=1', ...files];
const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: nodeOptions } });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
