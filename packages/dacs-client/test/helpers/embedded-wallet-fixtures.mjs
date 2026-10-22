// Fixtures for the EXPERIMENTAL, default-off embedded wallet tests.
//
// Evidence labels used by the tests (never merged into one claim):
//  - browser-real:   real headless Chrome from DACS_TEST_CHROME, packaged asset
//                    served by the real plugin server on loopback.
//  - sdk-real:       the shared sdk-provider.mjs seam driven by the Demos
//                    runtime exported from demos-runtime.mjs (no SDK doubles).
//  - loopback-simulated: local fixture services / recorders on 127.0.0.1.
//  - source-aware adapter: a test-owned vault store, public-state recorder or
//                    approval callback injected through the documented seams.
// These are source-aware functional tests. They are NOT source-blind
// validation, NOT a security review and NOT live/ChatGPT/installed-wallet proof.
//
// Key material is synthetic, generated fresh in RAM by the SDK per test, and
// is never printed: secret checks report only a label and an index.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/store/database.mjs';
import { createChallengeService, PURPOSES } from '../../src/wallet/challenges.mjs';
import { verifyDemosSignature } from '../../src/wallet/demos-signature.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const EMBEDDED_WALLET_DIR = join(here, '..', '..', 'public', 'portal', 'embedded-wallet');
// Exact packaged path served by the existing /portal/assets static route.
export const EMBEDDED_WALLET_ASSET_PATH = '/portal/assets/embedded-wallet/index.html';
export const EMBEDDED_WALLET_ASSET_BASE = '/portal/assets/embedded-wallet';

export const SDK_MODULES = ['sdk-provider.mjs', 'demos-runtime.mjs'];
export const UI_MODULES = ['ui.mjs', 'index.html'];

// Coordinator combined run: set DACS_EMBEDDED_WALLET_REQUIRE=1 so absent
// modules FAIL instead of being recorded as BLOCKED.
export const REQUIRE_MODULES = process.env.DACS_EMBEDDED_WALLET_REQUIRE === '1';

export function modulePresence(files) {
  const missing = files.filter((file) => !existsSync(join(EMBEDDED_WALLET_DIR, file)));
  return { present: missing.length === 0, missing };
}

// node:test options for a feature check. Absent modules are reported as TODO
// with a "BLOCKED:" reason (counted under "todo", never under "pass" or
// "skipped"); the test body still runs and fails loudly on the missing import.
export function blockedUnless(presence, extra = '') {
  if (presence.present || REQUIRE_MODULES) return {};
  return { todo: `BLOCKED: combined candidate absent (missing ${presence.missing.join(', ')} under public/portal/embedded-wallet/)${extra ? `; ${extra}` : ''}` };
}

export async function importEmbeddedModule(file) {
  return import(pathToFileURL(join(EMBEDDED_WALLET_DIR, file)).href);
}

// Mirrors the existing portal extraction (public/portal/portal.js walletSign).
export function extractSignature(res) {
  return res?.data?.signature ?? res?.data?.data ?? (typeof res?.data === 'string' ? res.data : null) ?? res?.signature;
}

export const ADDRESS_RE = /^0x[0-9a-f]{64}$/;
export const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/;
export const PUBLIC_ACCOUNT_KEYS = ['address', 'evidenceMode', 'network', 'publicKey'];
// INTERFACE-CONTRACT: public callbacks carry only address/locked/network/evidence/error status.
export const PUBLIC_STATE_KEYS = new Set(['address', 'locked', 'network', 'evidence', 'evidenceMode', 'error', 'status']);

export function freshPassword() {
  return `pw-${randomBytes(18).toString('base64url')}`;
}

function serialize(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString('utf8');
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Throws with a label and index only; the secret never enters an error message.
export function assertNoSecrets(haystacks, secrets, label) {
  const values = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  if (values.length !== secrets.length) throw new Error(`${label}: secret probe values must be non-empty strings`);
  haystacks.forEach((item, index) => {
    const text = serialize(item);
    values.forEach((secret, which) => {
      // Also catch common re-encodings of the same bytes.
      const forms = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), Buffer.from(secret).toString('hex')];
      if (forms.some((form) => text.includes(form))) throw new Error(`${label}: secret #${which} found in recorded item #${index}`);
    });
  });
}

// Real server verifier path: an in-memory challenge service issues the exact
// wallet-login message; verification uses src/wallet/demos-signature.mjs.
export function createLoginChallengeIssuer({ origin = 'http://127.0.0.1:65530' } = {}) {
  const db = openDatabase(':memory:');
  const service = createChallengeService({ db, origin, ttlSeconds: 300 });
  return {
    issue(address) {
      return service.issue({ purpose: PURPOSES.LOGIN, address, binding: { interaction: `ew-${randomBytes(6).toString('hex')}`, client: 'embedded-wallet-test' } });
    },
    verifyOnly: ({ address, message, signature }) => verifyDemosSignature({ address, message, signature }),
    verifyAndConsume: (challengeId, signature) => service.verifyAndConsume({ challengeId, purpose: PURPOSES.LOGIN, expectedBinding: { client: 'embedded-wallet-test' }, signature, consumedBy: 'embedded-wallet-test' }),
    close: () => db.close(),
  };
}

// SOURCE-AWARE ADAPTER (labelled): records what the SDK seam asks to approve.
export function createRecordingApprove(decide = () => true) {
  const requests = [];
  const approve = async (request) => {
    requests.push(serialize(request));
    return decide(request);
  };
  return { approve, requests };
}

// LOOPBACK-SIMULATED: a fresh 127.0.0.1 recorder. Records method/url/body of
// every request it receives and answers 503 not_configured. Never forwards.
export async function startLoopbackRecorder() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(503, { 'content-type': 'application/json', connection: 'close' }).end('{"error":"not_configured","simulated":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

// Bounded LIFO cleanup: every step is attempted with its own time limit and
// all failures are reported together, so cleanup never passes silently.
export function createCleanupStack() {
  const steps = [];
  return {
    add(label, ms, fn) {
      steps.push({ label, ms, fn });
    },
    async run() {
      const failures = [];
      while (steps.length > 0) {
        const { label, ms, fn } = steps.pop();
        let timer;
        const limit = new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), ms);
        });
        try {
          const outcome = await Promise.race([Promise.resolve().then(fn).then(() => 'done'), limit]);
          if (outcome === 'timeout') failures.push(new Error(`cleanup "${label}" did not finish within ${ms}ms`));
        } catch (error) {
          failures.push(new Error(`cleanup "${label}" failed: ${error?.message ?? error}`));
        } finally {
          clearTimeout(timer);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, failures.map((f) => f.message).join('; '));
    },
  };
}

// Never a bare Chromium launch: only the executable named by DACS_TEST_CHROME.
export function chromeSkipReason() {
  const path = process.env.DACS_TEST_CHROME;
  if (!path) return 'DACS_TEST_CHROME is not set (embedded wallet browser tests never fall back to another browser)';
  if (!existsSync(path)) return `DACS_TEST_CHROME not found at ${path}`;
  return false;
}

export async function launchTestChrome(cleanups) {
  const reason = chromeSkipReason();
  if (reason) throw new Error(reason);
  const executablePath = process.env.DACS_TEST_CHROME;
  const { chromium } = await import('playwright-core');
  const browserServer = await chromium.launchServer({ executablePath, headless: true });
  const proc = browserServer.process();
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  cleanups.add('test-launched browser shutdown', 20000, async () => {
    let timer;
    const graceful = await Promise.race([
      browserServer.close().then(() => 'done', () => 'error'),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 8000); }),
    ]).finally(() => clearTimeout(timer));
    if (graceful === 'done' && exited()) return;
    await browserServer.kill();
    if (!exited()) throw new Error('test-launched browser process is still running after termination');
    if (graceful === 'error') throw new Error('graceful browser close failed (test-launched process was terminated)');
  });
  const browser = await chromium.connect(browserServer.wsEndpoint());
  cleanups.add('browser disconnect', 5000, () => browser.close());
  return { browser, executablePath, version: browser.version() };
}

// Fresh context with recorders for every request, console error and page error.
export async function openRecordedPage(browser, cleanups) {
  const context = await browser.newContext();
  cleanups.add('browser context close', 5000, () => context.close());
  const page = await context.newPage();
  const requests = [];
  const consoleErrors = [];
  const consoleAll = [];
  page.on('request', (req) => requests.push({ method: req.method(), url: req.url(), body: req.postData() ?? '' }));
  page.on('console', (msg) => {
    consoleAll.push(msg.text());
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  return { context, page, requests, consoleErrors, consoleAll };
}

// Central UI selectors, matched to the accessible names in embedded-wallet/ui.mjs
// and approval.mjs (the UI files are read-only for tests).
export const UI = {
  experimental: /experimental/i,
  localOnly: /local/i,
  create: /^create wallet$/i,
  importMnemonic: /^import wallet$/i,
  phraseInput: /^recovery phrase \(words separated by spaces\)$/i,
  phraseRegion: 'Recovery phrase', // section aria-label while the phrase is shown
  showBackup: /^show recovery phrase$/i,
  hidePhrase: /hide/i,
  lock: /^lock wallet$/i,
  unlock: /^unlock$/i,
  exportBackup: /^export encrypted backup$/i,
  backupText: /encrypted backup text/i,
  pasteBackup: /^or paste backup text$/i,
  restoreBackup: /^restore backup$/i,
  approve: /^approve$/i,
  reject: /^reject$/i,
  unlockedHeading: /^wallet unlocked$/i,
  lockedHeading: /^wallet locked$/i,
  // 12-24 lowercase BIP39-style words: the locally displayed backup.
  mnemonicText: /^\s*(?:[a-z]+\s+){11,23}[a-z]+\s*$/,
};

// --- Page drivers for the real embedded wallet UI (Playwright) -------------
// `scope` is a page or a locator containing exactly one mounted wallet.

// The form whose submit button has the given accessible name. The `has`
// locator must be page-rooted so it is evaluated relative to each form.
const formWith = (scope, name) => {
  const page = typeof scope.page === 'function' ? scope.page() : scope;
  return scope.locator('form').filter({ has: page.getByRole('button', { name }) });
};

async function fillAll(locator, value) {
  const count = await locator.count();
  if (count < 1) throw new Error('expected at least one password field');
  for (let i = 0; i < count; i += 1) await locator.nth(i).fill(value);
}

// Reads the address shown in the unlocked view (the dd after "Address").
export async function shownAddress(scope) {
  await scope.getByRole('heading', { name: UI.unlockedHeading }).waitFor({ timeout: 30000 });
  const text = await scope.locator('dt', { hasText: /^Address$/ }).locator('xpath=following-sibling::dd[1]').innerText();
  const match = text.trim().match(/^0x[0-9a-f]{64}$/);
  if (!match) throw new Error('unlocked view does not show a Demos address');
  return match[0];
}

// Create with a password (the UI encrypts and stores before showing the phrase).
export async function uiCreate(scope, password) {
  const form = formWith(scope, UI.create);
  await form.getByRole('button', { name: UI.create }).waitFor({ timeout: 10000 });
  await fillAll(form.locator('input[type="password"]'), password);
  await form.getByRole('button', { name: UI.create }).click();
  return shownAddress(scope);
}

export async function uiImport(scope, phrase, password) {
  const form = formWith(scope, UI.importMnemonic);
  await form.getByRole('button', { name: UI.importMnemonic }).waitFor({ timeout: 10000 });
  await form.getByLabel(UI.phraseInput).fill(phrase);
  await fillAll(form.locator('input[type="password"]'), password);
  await form.getByRole('button', { name: UI.importMnemonic }).click();
  return shownAddress(scope);
}

// The locally displayed recovery phrase (only while deliberately shown).
export async function uiShownPhrase(scope) {
  const region = scope.getByRole('region', { name: UI.phraseRegion });
  await region.waitFor({ timeout: 10000 });
  const words = (await region.locator('li').allInnerTexts()).map((w) => w.trim());
  const phrase = words.join(' ');
  if (!UI.mnemonicText.test(phrase)) throw new Error('shown recovery phrase does not look like 12-24 words');
  return phrase;
}

export async function uiRevealPhrase(scope, password) {
  const form = formWith(scope, UI.showBackup);
  await form.locator('input[type="password"]').fill(password);
  await form.getByRole('button', { name: UI.showBackup }).click();
  return uiShownPhrase(scope);
}

export async function uiLock(scope) {
  await scope.getByRole('button', { name: UI.lock }).click();
  await scope.getByRole('heading', { name: UI.lockedHeading }).waitFor({ timeout: 10000 });
}

export async function uiUnlock(scope, password) {
  const form = formWith(scope, UI.unlock);
  await form.locator('input[type="password"]').fill(password);
  await form.getByRole('button', { name: UI.unlock }).click();
  return shownAddress(scope);
}

export async function uiExportBackup(scope) {
  await scope.getByRole('button', { name: UI.exportBackup }).click();
  const text = scope.getByRole('textbox', { name: UI.backupText });
  await text.waitFor({ timeout: 10000 });
  return (await text.inputValue()).trim();
}

// Restores into an empty wallet; the result is the locked view.
export async function uiRestoreBackup(scope, backup) {
  const form = formWith(scope, UI.restoreBackup);
  await form.getByLabel(UI.pasteBackup).fill(backup);
  await form.getByRole('button', { name: UI.restoreBackup }).click();
  await scope.getByRole('heading', { name: UI.lockedHeading }).waitFor({ timeout: 10000 });
}

// --- In-page installers (serialised by page.evaluate; no closures) ---------

// SOURCE-AWARE ADAPTER (labelled): test-owned memory vault store with the
// ui.mjs store interface (get() -> record|null, put(record), delete()) + public
// state recorder. Every write is recorded (bytes decoded) for secret scans.
export function pageInstallRecorders() {
  window.__ewPublic = [];
  window.__ewVaultWrites = [];
  window.__ewProvider = null;
  let current = null;
  const asText = (value) => {
    try {
      if (value instanceof ArrayBuffer) return `bytes:${new TextDecoder().decode(new Uint8Array(value))}`;
      if (ArrayBuffer.isView(value)) return `bytes:${new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))}`;
      if (typeof value === 'string') return value;
      return JSON.stringify(value, (_k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? `bytes:${new TextDecoder().decode(v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}` : v));
    } catch {
      return '[unserialisable]';
    }
  };
  const record = (op, value) => window.__ewVaultWrites.push({ op, value: asText(value) });
  const copy = (value) => {
    try { return structuredClone(value); } catch { return value; }
  };
  window.__ewVaultStore = {
    kind: 'test-memory', // TEST-OWNED (source-aware fixture, RAM only)
    async get() { return current === null ? null : copy(current); },
    async put(value) { record('put', value); current = copy(value); },
    async delete() { record('delete', null); current = null; },
  };
  return true;
}

// Mounts the shared UI with the real SDK seam (including the SDK's exported
// validateMnemonic, without which import/unlock fail closed) and the labelled
// recorders. Waits for the UI's ready promise.
export async function pageMountWallet({ base }) {
  const [ui, sdk, runtime] = await Promise.all([import(`${base}/ui.mjs`), import(`${base}/sdk-provider.mjs`), import(`${base}/demos-runtime.mjs`)]);
  const root = document.createElement('div');
  root.id = 'ew-test-root';
  document.body.replaceChildren(root);
  const handle = ui.mountEmbeddedWallet(root, {
    sessionFactory: async ({ approve }) => sdk.createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, approve }),
    vaultStore: window.__ewVaultStore,
    onPublicState: (state) => window.__ewPublic.push(JSON.parse(JSON.stringify(state ?? null))),
    onProviderReady: (provider) => { window.__ewProvider = provider; },
  });
  await handle.ready;
  window.__ewHandle = handle;
  return true;
}
