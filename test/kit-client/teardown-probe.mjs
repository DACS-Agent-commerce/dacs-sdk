// Run as a child by off-state.test.mjs (not a .test.mjs file, so the runner never collects it): opens the composed host, then fails on purpose.
// After the failing test's own teardown has run, and before this process ends, it reports to the parent whether the host still listens
// and whether its state directory is still there.
import test, { after } from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { composedKitHost } from './kit-host.mjs';

const FETCH_DEADLINE_MS = 2000;
let opened;

after(async () => {
  const listening = await fetch(opened.url, { signal: AbortSignal.timeout(FETCH_DEADLINE_MS) }).then(() => true, (error) => error.cause?.code !== 'ECONNREFUSED');
  writeFileSync(process.env.KIT_CLIENT_PROBE_OUT, JSON.stringify({ ...opened, listening, directoryExists: existsSync(opened.dataDirectory) }));
});

test('teardown probe: a failing test with the kit host open', async (t) => {
  const { host, dataDirectory } = await composedKitHost(t);
  opened = { url: host.url, dataDirectory };
  throw new Error('TEST deliberate failure with the host open');
});
