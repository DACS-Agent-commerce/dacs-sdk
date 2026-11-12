import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import ts from 'typescript';

// Execute the actual private/generated loop without adding a production export.
function loadFunction(path, name, bindings = {}, prelude = '') {
  const source = ts.createSourceFile(path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source).replace(/^export /u, '');
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isArrowFunction(node.initializer)) declaration = `const ${node.getText(source)};`;
    ts.forEachChild(node, visit);
  }
  visit(source);
  // Generated lifecycle functions are inside a template string.
  if (!declaration && path.endsWith('liveTemplates.ts')) {
    const text = source.text, start = text.indexOf(`async function ${name}(`);
    const generated = ts.createSourceFile('lifecycle.ts', text.slice(start), ts.ScriptTarget.Latest, true);
    declaration = generated.statements.find(ts.isFunctionDeclaration)?.getText(generated);
  }
  assert.ok(declaration, `${path}: ${name}`);
  const js = ts.transpileModule(`${prelude}\n${declaration}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), `${js}\nreturn ${name};`)(...Object.values(bindings));
}

for (const jump of [-60_000, 60_000]) {
  for (const [name, path, budget, poll, args, dependencies, expected] of [
    ['endpointAvailable', 'packages/create-dacs-agent/src/liveTemplates.ts', 1_000, 250, ['buyer', 1_000],
      { serviceEndpoint: () => 'http://localhost/', fetch: async () => { throw new Error('not ready'); } }, false],
    ['stopRecord', 'packages/create-dacs-agent/src/liveTemplates.ts', 15_000, 100, [{ pid: 1, role: 'buyer' }],
      { alive: () => true, ownedCommand: () => true, process: { kill() {} } }, 'local-runtime-process-stop-timeout'],
    ['readRecordSettled', 'packages/dacs-seller/src/devnet-demo/agreement-context.mjs', 100, 25, [{}],
      { COUNTERPARTY_TIMEOUT_MS: 100, READ_POLL_MS: 25, callCounterparty: async () => ({ status: 'indeterminate' }) }, { status: 'indeterminate' }],
  ]) {
    test(`${name} keeps its budget after a ${jump} ms wall jump`, async () => {
      let elapsed = 0;
      const operation = loadFunction(path, name, { ...dependencies,
        AbortSignal: { timeout: () => new AbortController().signal },
        Date: { now: () => 1_000_000 + elapsed + (elapsed > 0 && elapsed < budget * 3 ? jump : 0) },
        performance: { now: () => elapsed }, monotonicNow: () => elapsed,
        setTimeout: callback => { elapsed += poll; queueMicrotask(callback); },
      });
      let outcome;
      try { outcome = await operation(...args); } catch (error) { outcome = error.message; }
      assert.deepEqual(outcome, expected);
      assert.equal(elapsed, budget);
    });
  }

  for (const port of ['dacs-client', 'dacs-seller']) {
    test(`${port} readback TTL ignores a ${jump} ms wall jump`, () => {
      let elapsed = 0, wall = 1_000;
      const create = loadFunction(`packages/${port}/src/util/immutable-readbacks.mjs`, 'createImmutableReadbacks', {
        IMMUTABLE_READBACK_TTL_MS: 10, MAX_IMMUTABLE_READBACK_ENTRIES: 10_000,
        canonicalize: JSON.stringify, sha256Hex: value => value, Date: { now: () => wall },
      });
      const cache = create({ ttlMs: 10, monotonicNow: () => elapsed });
      const input = { purchaseId: 'clock', locator: 'test', contentHash: 'test', scope: {} };
      cache.put(input, { value: 1 });
      elapsed = 1; wall += jump;
      assert.deepEqual(cache.get(input), { value: 1 });
      elapsed = 10;
      assert.equal(cache.get(input), null);
    });

    test(`${port} request rate window ignores a ${jump} ms wall jump`, async () => {
      let elapsed = 0;
      const create = loadFunction(`packages/${port}/src/dacs/seller-http.mjs`, 'createSellerHttpHandler', {
        Date: { now: () => 1_000_000 + elapsed + (elapsed > 0 ? jump : 0) }, performance: { now: () => elapsed },
        assertKitOperationAdmitted() {}, ROUTES: {}, SIGNATURE_ROUTES: {}, loopbackSocket: () => true, SELLER_TRANSPORT_MAX_RESPONSE: 10_000,
      });
      const handler = create({}, { maxRequestsPerWindow: 1, rateWindowMs: 10 });
      let status;
      const request = () => handler({ socket: {}, url: '/missing' }, {
        writeHead(value) { status = value; }, end() {},
      });
      await request(); assert.equal(status, 404);
      elapsed = 1; await request(); assert.equal(status, 429);
      elapsed = 10; await request(); assert.equal(status, 404);
    });
  }

  test(`mount-table cache TTL ignores a ${jump} ms wall jump`, async () => {
    let elapsed = 0, loads = 0;
    const read = loadFunction('src/filesystem/privateStore.ts', 'filesystemType', {
      Date: { now: () => 1_000_000 + elapsed + (elapsed > 0 ? jump : 0) }, performance: { now: () => elapsed },
      loadMountEntries: async () => { loads += 1; return [{ mountPoint: '/', type: 'ext4' }]; },
      withinPath: () => true,
    }, 'let mountEntriesCache;');
    assert.equal(await read('/store', 'test'), 'ext4');
    elapsed = 1; await read('/store', 'test'); assert.equal(loads, 1);
    elapsed = 1_000; await read('/store', 'test'); assert.equal(loads, 2);
  });
}

for (const jump of [-60_000, 60_000]) test(`publisher propagation budget ignores a ${jump} ms wall jump`, async () => {
  let elapsed = 0;
  const Date = { now: () => 1_000_000 + elapsed + (elapsed > 0 && elapsed < 3_000 ? jump : 0) };
  const performance = { now: () => elapsed };
  const source = readFileSync(new URL('../../scripts/publish-release-set.mjs', import.meta.url), 'utf8');
  const declaration = source.match(/^const deadline = (.+);$/mu)[0];
  const deadline = new Function('Date', 'performance', 'PUBLISH_DEADLINE_MS', 'jobStartedAt', 'PUBLISH_JOB_TIMEOUT_MS', 'PUBLISH_JOB_RESERVE_MS', `${declaration} return deadline;`)(Date, performance, 1_000, 1_000_000, 1_000, 0);
  class ReleaseError extends Error { constructor(code) { super(code); this.code = code; } }
  const poll = loadFunction('scripts/publish-release-set.mjs', 'pollWithinWindow', {
    Date, performance, deadline, REGISTRY_PROPAGATION_WINDOW_MS: 1_000, REGISTRY_POLL_INTERVAL_MS: 250, ReleaseError,
    sleep: async delay => { elapsed += delay; },
  });
  await assert.rejects(poll(async () => undefined, 'test'), { code: 'publish_budget_exhausted' });
  assert.equal(elapsed, 1_000);
});

for (const jump of [-60_000, 60_000]) test(`verification tool total budget ignores a ${jump} ms wall jump`, () => {
  const source = readFileSync(new URL('../../scripts/verify-node-test-effectiveness.mjs', import.meta.url), 'utf8');
  const declaration = source.match(/^const started = (.+);$/mu)[0];
  const condition = source.match(/if \((!baselinePassed \|\| .+ > TOTAL_BUDGET_MS)\)/u)[1];
  let elapsed = 0;
  const Date = { now: () => 1_000_000 + elapsed + (elapsed > 0 ? jump : 0) };
  const performance = { now: () => elapsed };
  const check = new Function('Date', 'performance', `${declaration} return () => { const baselinePassed = true, TOTAL_BUDGET_MS = 1_000; return ${condition}; };`)(Date, performance);
  elapsed = 1; assert.equal(check(), false);
  elapsed = 1_001; assert.equal(check(), true);
});

for (const jump of [-60_000, 60_000]) {
  test(`native step elapsed time ignores a ${jump} ms wall jump`, () => {
    let elapsed = 0, wall = 1_000_000;
    const events = [], step = loadFunction('packages/dacs-client/src/wallet/devnet-native-transport.mjs', 'step', {
      now: () => wall, monotonicNow: () => elapsed, stepListeners: new Set([event => events.push(event)]),
    });
    elapsed = 10; wall += 10 + jump;
    step({ hash: 'test', content: {} }, 'inclusion', 'complete', 0);
    assert.equal(events[0].durationMs, 10);
    assert.equal(events[0].timestampMs, wall);
  });

  test(`verification subprocess elapsed time ignores a ${jump} ms wall jump`, async () => {
    let elapsed = 0, wall = 1_000_000;
    const run = loadFunction('scripts/verify-node-test-effectiveness.mjs', 'runVitest', {
      Date: { now: () => wall }, performance: { now: () => elapsed },
      repoRoot: '/test', join, escapeRegExp: value => value, childEnvironment: () => ({}), RUN_TIMEOUT_MS: 100,
      setTimeout: () => 0, clearTimeout() {},
      spawn: () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => { elapsed = 10; wall += 10 + jump; child.emit('close', 0); });
        return child;
      },
    });
    const result = await run('/test', [], [], 'test.json');
    assert.equal(result.exitCode, 0); assert.equal(result.durationMs, 10);
  });

  test(`generated consumer command elapsed time ignores a ${jump} ms wall jump`, async () => {
    let elapsed = 0, wall = 1_000_000;
    const steps = [], step = loadFunction('scripts/verify-generated-consumer.mjs', 'step', {
      Date: { now: () => wall }, performance: { now: () => elapsed },
      steps, outputDirectory: '/test', join, writeFile: async () => {},
      spawnSync: () => { elapsed = 10; wall += 10 + jump; return { status: 0, signal: null, stdout: '', stderr: '' }; },
    });
    await step('test', 'test', [], { cwd: '/test', timeoutMs: 100 });
    assert.equal(steps[0].durationMs, 10);
  });

  test(`generated consumer total elapsed time ignores a ${jump} ms wall jump`, () => {
    let elapsed = 0, wall = 1_000_000;
    const source = readFileSync(new URL('../../scripts/verify-generated-consumer.mjs', import.meta.url), 'utf8');
    const start = source.match(/^const started = (.+);$/mu)[0];
    const finish = source.match(/^report.durationMs = (.+);$/mu)[0];
    const duration = new Function('Date', 'performance', `${start} const report = {}; return () => { ${finish} return report.durationMs; };`)(
      { now: () => wall }, { now: () => elapsed });
    elapsed = 10; wall += 10 + jump;
    assert.equal(duration(), 10);
  });
}
