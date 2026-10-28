// Drives the real OAuth 2.1 authorization-code + PKCE flow with the official
// MCP client SDK (`auth()` / StreamableHTTPClientTransport + OAuthClientProvider):
// PRM discovery, AS discovery, DCR, PKCE S256, resource indicator, RFC 9207
// iss check, token exchange. The "user agent" follows redirects with a cookie
// jar and completes the portal's wallet-signature login with an ephemeral wallet.
import { auth } from '@modelcontextprotocol/client';
import { CALLBACK_URL } from './harness.mjs';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Minimal browser-like jar: honours the cookie Path attribute (RFC 6265 §5.1.4),
// so tests fail exactly where a real browser would withhold a cookie.
export class CookieJar {
  constructor() {
    this.cookies = new Map(); // `${path}\0${name}` -> { name, value, path }
  }
  store(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const pathAttr = attrs.map((a) => a.trim()).find((a) => /^path=/i.test(a));
      const path = pathAttr ? pathAttr.slice(5) : '/';
      const id = `${path}\0${name}`;
      if (/expires=Thu, 01 Jan 1970/i.test(line) || value === '') this.cookies.delete(id);
      else this.cookies.set(id, { name, value, path });
    }
  }
  header(url) {
    const requestPath = url ? new URL(url).pathname : '/';
    const matches = (p) => requestPath === p || (requestPath.startsWith(p) && (p.endsWith('/') || requestPath[p.length] === '/'));
    return [...this.cookies.values()].filter((c) => matches(c.path)).map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

export class TestOAuthProvider {
  // Without applicationType the MCP client SDK derives it (SEP-837): `native`
  // for loopback redirects such as CALLBACK_URL, as on main.
  constructor({ scope, redirectUrl = CALLBACK_URL, applicationType } = {}) {
    this._scope = scope;
    this._redirectUrl = redirectUrl;
    this._applicationType = applicationType;
    this._tokens = undefined;
    this._client = undefined;
    this._verifier = undefined;
    this.authorizationUrl = null;
  }
  get redirectUrl() {
    return this._redirectUrl;
  }
  get clientMetadata() {
    return {
      client_name: 'DACS plugin test client',
      redirect_uris: [this.redirectUrl],
      ...(this._applicationType ? { application_type: this._applicationType } : {}),
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this._scope ? { scope: this._scope } : {}),
    };
  }
  clientInformation() {
    return this._client;
  }
  saveClientInformation(info) {
    this._client = info;
  }
  tokens() {
    return this._tokens;
  }
  saveTokens(tokens) {
    this._tokens = tokens;
  }
  redirectToAuthorization(url) {
    this.authorizationUrl = new URL(url);
  }
  saveCodeVerifier(verifier) {
    this._verifier = verifier;
  }
  codeVerifier() {
    return this._verifier;
  }
  // Persisted with the verifier so the SDK can bind the callback to the
  // authorization server it redirected to (SEP-2352 / RFC 9207).
  saveDiscoveryState(state) {
    this._discovery = state;
  }
  discoveryState() {
    return this._discovery;
  }
}

async function follow(url, jar, { maxHops = 10, callbackUrl = CALLBACK_URL } = {}) {
  let current = new URL(url);
  const callback = new URL(callbackUrl);
  for (let hop = 0; hop < maxHops; hop += 1) {
    const response = await fetch(current, { redirect: 'manual', headers: { cookie: jar.header(current) } });
    jar.store(response);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current);
      await response.body?.cancel();
      // Same origin and path, so a loopback callback is never a prefix of the
      // portal's own loopback URL; the registered query stays a prefix.
      if (next.origin === callback.origin && next.pathname === callback.pathname && next.href.startsWith(callbackUrl)) return { callback: next };
      current = next;
      continue;
    }
    return { final: current, response };
  }
  throw new Error('too many redirects');
}

async function portal(origin, path, body, jar) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: jar.header(`${origin}${path}`) },
    body: JSON.stringify(body ?? {}),
  });
  jar.store(response);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message ?? `portal ${response.status}`), { status: response.status, data });
  return data;
}

// Completes the browser leg: authorization endpoint -> portal wallet login ->
// redirect back with ?code&state&iss. Returns the callback URL.
export async function beginAuthorizationInBrowser({ authorizationUrl, wallet, origin, tamper, callbackUrl = CALLBACK_URL, jar = new CookieJar() } = {}) {
  const start = await follow(authorizationUrl, jar, { callbackUrl });
  if (start.callback) return start;
  const uid = /\/portal\/authorize\/([^/?#]+)/.exec(start.final.pathname)?.[1];
  if (!uid) throw new Error(`authorization did not reach the portal (at ${start.final.href})`);
  await start.response.body?.cancel();
  const view = await portal(origin, `/portal/authorize/${uid}/api/view`, {}, jar);
  const challenge = await portal(origin, `/portal/authorize/${uid}/api/challenge`, { address: wallet.address }, jar);
  const signature = tamper?.signature ?? wallet.signHex(tamper?.message ?? challenge.message);
  const done = await portal(origin, `/portal/authorize/${uid}/api/complete`, { challengeId: challenge.challengeId, signature }, jar);
  return { redirectTo: done.redirectTo, jar, view, challenge };
}

export async function completeAuthorizationInBrowser(options = {}) {
  const pending = await beginAuthorizationInBrowser(options);
  if (pending.callback) return pending.callback;
  const { redirectTo, jar, view, challenge } = pending;
  const end = await follow(redirectTo, jar, { callbackUrl: options.callbackUrl });
  if (!end.callback) {
    const body = await end.response.text();
    throw new Error(`authorization did not return to the client callback (ended at ${end.final.pathname} HTTP ${end.response.status}: ${body.replace(/<[^>]+>/g, ' ').slice(0, 300)})`);
  }
  return Object.assign(end.callback, { view, challenge });
}

// Full flow: returns the provider holding tokens for the MCP resource.
export async function linkAccount({ harness, wallet, scope = 'dacs.account.read dacs.agents.write dacs.purchases.write' }) {
  const provider = new TestOAuthProvider({ scope });
  const first = await auth(provider, { serverUrl: harness.mcpUrl, scope });
  if (first !== 'REDIRECT') throw new Error(`expected REDIRECT, got ${first}`);
  const callback = await completeAuthorizationInBrowser({ authorizationUrl: provider.authorizationUrl, wallet, origin: harness.origin });
  const code = callback.searchParams.get('code');
  const iss = callback.searchParams.get('iss');
  const second = await auth(provider, { serverUrl: harness.mcpUrl, authorizationCode: code, iss, scope });
  if (second !== 'AUTHORIZED') throw new Error(`expected AUTHORIZED, got ${second}`);
  return { provider, callback, iss };
}

// Boot the actual base authorization server in a disposable project, then replace
// only its source and start a fresh process with the same database, port and keys.
// The base is the committed pre-fix fixture (see its README) unless DCR_BASE_SOURCE
// names another file; it runs from src/auth/ so its relative imports resolve.
const BASE_FIXTURE = fileURLToPath(new URL('../fixtures/authorization-server.pre-dcr-logout.mjs', import.meta.url));
export async function startUpgradeHarness({ allowedOrigins } = {}) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'dcr-upgrade-'));
  const source = join(dir, 'src/auth/authorization-server.mjs');
  let current;
  const env = { DACS_DATA_DIR: join(dir, 'data'), DACS_OAUTH_COOKIE_KEYS: 'upgrade-regression-cookie-key-at-least-32-chars',
    DACS_ALLOWED_REDIRECT_ORIGINS: allowedOrigins.join(',') };
  let child, origin;
  const script = `
    import { startHarness } from './test/helpers/harness.mjs';
    const h = await startHarness({ env: JSON.parse(process.env.DCR_UPGRADE_ENV) });
    process.on('message', async (message) => {
      if (message === 'close') { await h.close(); process.exit(0); }
    });
    process.send({ origin: h.origin });
  `;
  async function boot() {
    child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: dir,
      env: { ...process.env, DCR_UPGRADE_ENV: JSON.stringify(env) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`upgrade fixture timed out: ${stderr}`)); }, 30_000);
      child.once('message', (message) => { clearTimeout(timer); resolve(message.origin); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`upgrade fixture exited ${code}: ${stderr}`)); });
    });
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.send('close');
      await exited;
    }
  }
  try {
    for (const name of ['src', 'test', 'public', 'package.json']) cpSync(join(root, name), join(dir, name), { recursive: true });
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    current = readFileSync(source, 'utf8');
    writeFileSync(source, readFileSync(process.env.DCR_BASE_SOURCE || BASE_FIXTURE, 'utf8'));
    await boot();
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  return {
    get origin() { return origin; },
    async upgrade({ origins = allowedOrigins } = {}) {
      env.__port = Number(new URL(origin).port);
      env.DACS_ALLOWED_REDIRECT_ORIGINS = origins.join(',');
      await stop();
      writeFileSync(source, current);
      await boot();
    },
    async close() { try { await stop(); } finally { rmSync(dir, { recursive: true, force: true }); } },
  };
}
