// Starts SIMULATED fixture services (Demos RPC, Community directory) and the
// real plugin server on loopback ports, with an isolated temporary data dir.
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../../src/config.mjs';
import { createApp } from '../../src/app.mjs';
import { createLogger } from '../../src/util/log.mjs';
import { startChainFixture } from '../fixtures/chain-server.mjs';
import { startDirectoryFixture } from '../fixtures/directory-server.mjs';

// Never listened on; browser tests intercept it. (Port 9 is on Chrome's unsafe-port list.)
export const CALLBACK_ORIGIN = 'http://127.0.0.1:65531';
export const CALLBACK_URL = `${CALLBACK_ORIGIN}/oauth/callback`;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

export async function startHarness({ env = {}, chain: existingChain, directory: existingDirectory, logs } = {}) {
  const chain = existingChain ?? (await startChainFixture());
  const directory = existingDirectory ?? (await startDirectoryFixture());
  // The harness owns (and removes on close) only a data dir it created itself;
  // a caller-supplied DACS_DATA_DIR stays the caller's to clean up.
  const ownsDataDir = env.DACS_DATA_DIR === undefined;
  const dataDir = env.DACS_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'dacs-chatgpt-test-'));
  const cookieKey = randomBytes(32).toString('hex');
  const lines = logs ?? [];

  let server = http.createServer();
  const port = await listen(server, env.__port ?? 0);
  const origin = `http://127.0.0.1:${port}`;
  const baseEnv = {
    DACS_PUBLIC_ORIGIN: origin,
    DACS_ALLOW_INSECURE_LOCALHOST: '1',
    DACS_OAUTH_COOKIE_KEYS: cookieKey,
    DACS_DATA_DIR: dataDir,
    DACS_DIRECTORY_ORIGIN: directory.url,
    DACS_CHAIN_RPC_URL: chain.url,
    DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN,
    DACS_LOG_LEVEL: 'debug',
  };
  const effectiveEnv = { ...baseEnv, ...env };
  delete effectiveEnv.__port;

  async function boot() {
    const config = loadConfig(effectiveEnv);
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const created = await createApp({ config, logger });
    server.removeAllListeners('request');
    server.on('request', created.app);
    return { config, created };
  }

  let { config, created } = await boot();

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    chain,
    directory,
    dataDir,
    logs: lines,
    get config() {
      return config;
    },
    get app() {
      return created;
    },
    // Simulates a process restart: drop the app and database handle, then
    // boot a fresh app instance on the same port and data directory. An env
    // override (for example a feature switch) applies to this and later boots.
    async restart({ env: override = {} } = {}) {
      Object.assign(effectiveEnv, override);
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
      await created.close();
      // Let pooled keep-alive client sockets observe the reset before reuse.
      await new Promise((resolve) => setTimeout(resolve, 150));
      server = http.createServer();
      await listen(server, port);
      ({ config, created } = await boot());
    },
    // Closes the server, app and database first, then removes the harness-owned
    // data dir (SQLite files included). restart() never removes it, so durable
    // state survives until this final close. Removal errors are not swallowed.
    // keepFixtures only keeps the shared chain/directory fixtures running.
    async close({ keepFixtures = false } = {}) {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
      await created.close();
      if (!keepFixtures) {
        await chain.close();
        await directory.close();
      }
      if (ownsDataDir) rmSync(dataDir, { recursive: true });
    },
  };
}
