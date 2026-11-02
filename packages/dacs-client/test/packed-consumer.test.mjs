// DC-CW11: behaviour of the packed archives after the hold is switched. The switched
// copy rewrites only purchase-admission-state.mjs (P35's diff) in a temporary
// directory; nothing here is committed, published or pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installPackedPair, packageDir, switchedCopy } from './helpers/packed-install.mjs';

// What the composition test needs besides the installed package, copied into the empty app.
const COMPOSITION_FILES = ['test/public-composition.test.mjs', 'test/helpers/public-composition-world.mjs', 'test/helpers/purchase-integrity-operations.mjs',
  'test/helpers/purchase-integrity-database.mjs', 'test/helpers/passive-native-world.mjs', 'test/fixtures/listings.mjs', 'test/fixtures/wallet.mjs', 'test/fixtures/tp1-authority-reader.mjs'];

test('tests 24-29\'s composition passes from the packed client and core archives installed in an empty directory (switched-copy archive, DC-CW11)', t => {
  const { app, run } = installPackedPair(t, { clientDir: switchedCopy(t) });
  for (const path of COMPOSITION_FILES) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    cpSync(join(packageDir, path), join(app, path));
  }
  // The helpers reach the package as ../../src; here that is the installed copy.
  symlinkSync(join(app, 'node_modules/@kynesyslabs/dacs-client/src'), join(app, 'src'));
  const output = run(process.execPath, ['--test', '--test-concurrency=1', 'test/public-composition.test.mjs'], app, { DACS_PACKED_COMPOSITION: '1' });
  assert.match(output, /^# pass 6$/m, 'all six composition tests ran from the installed package');
  assert.match(output, /^# fail 0$/m);
});

test('a binding made through the consumer\'s own @kynesyslabs/dacs/wire import is accepted by the packed client (switched-copy archive)', t => {
  const { app, run } = installPackedPair(t, { clientDir: switchedCopy(t) });
  writeFileSync(join(app, 'identity.mjs'), `
    import assert from 'node:assert/strict';
    import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
    import { createProtocolPurchases, createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';
    const local = { endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' };
    const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local, readAuthority: async scope => ({ local: { ...scope.local },
      chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-authority', sessionId: scope.sessionId, participants: [] }) });
    const store = createSqlitePurchaseStore(), currentLocal = () => ({ ...local });
    const accepted = createProtocolPurchases({ store, admission: { binding, currentLocal } });
    assert.equal(accepted.actionsAdmitted, true, 'the switched copy is admitted');
    // Admitted: the original ran and gave its own refusal, not the wrapper's.
    await assert.rejects(accepted.prepareTerms({ verification: {}, domain: {}, sellerClaim: 'TEST-seller' }), { code: 'dacs_protocol_unavailable' });
    const cloned = createProtocolPurchases({ store, admission: { binding: structuredClone(binding), currentLocal } });
    await assert.rejects(cloned.prepareTerms({}), error => error.code === 'profile_not_admitted' && error.cause?.code === 'tp1_binding_required');
  `);
  run(process.execPath, ['identity.mjs'], app);
});
