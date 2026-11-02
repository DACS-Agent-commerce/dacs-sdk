// Child process for kit-operation-guard.test.mjs: runs one named case against
// the real modules and prints its answer as one line of JSON. The parent
// decides whether the guard fixture loader is present (it removes it for the
// off-state cases).
import fs from 'node:fs';
import { mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seller } from './protocol-fixture.mjs';
import { anchorFixture, signSdkCreate } from './anchor-isolated-fixture.mjs';

const WATCHED_FS_CALLS = ['openSync', 'mkdirSync', 'lstatSync', 'realpathSync', 'writeFileSync', 'readFileSync', 'readdirSync', 'statSync'];
const ARTIFACT_JOB = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const [caseName, ...caseArguments] = process.argv.slice(2);

const refusalOf = async (run) => {
  try { await run(); return null; } catch (error) { return { name: error.name, code: error.code, entry: error.entry, message: error.message }; }
};
const privateTemporaryDirectory = () => realpathSync(mkdtempSync(join(tmpdir(), 'TEST-kit-guard-')));

async function startWithHostileOptions() {
  const fsCalls = [];
  let counting = false;
  for (const name of WATCHED_FS_CALLS) { const original = fs[name]; fs[name] = (...args) => { if (counting) fsCalls.push(name); return original(...args); }; }
  syncBuiltinESMExports();
  const { startSellerHost } = await import('../../src/host.mjs');
  const optionReads = [];
  const recorder = new Proxy({}, new Proxy({}, { get: (_target, trap) => (...args) => { optionReads.push(trap); return Reflect[trap](...args); } }));
  counting = true;
  const refusal = await refusalOf(() => startSellerHost(recorder));
  counting = false;
  return { refusal, optionReads, fsCalls };
}

async function concurrentStarts([dataDirectory]) {
  const { startSellerHost } = await import('../../src/host.mjs');
  const results = await Promise.all([startSellerHost({ dataDirectory }), startSellerHost({ dataDirectory })].map((started) => refusalOf(() => started)));
  return { results, entries: readdirSync(dataDirectory) };
}

async function namedGuardInputs() {
  const { startSellerHost } = await import('../../src/host.mjs');
  const { kitOperationAdmitted } = await import('../../src/kit-operation-guard.mjs');
  const options = { kitOperationGuard: 'testnet-tp1', guard: 'testnet-tp1', DACS_KIT_GUARD: 'testnet-tp1' };
  return { admitted: kitOperationAdmitted(), refusal: await refusalOf(() => startSellerHost(options)), argv: process.argv.slice(2), environment: process.env.DACS_KIT_GUARD };
}

async function guardValues() {
  const { assertKitOperationAdmitted, kitOperationAdmitted, setKitOperationGuardForTest } = await import('../../src/kit-operation-guard.mjs');
  const answers = [];
  for (const value of ['testnet-tp1', '', 'TESTNET-TP1', 'on', 'testnet-tp1 ', undefined, null, true, 1]) {
    setKitOperationGuardForTest(value);
    answers.push({ value: String(value), admitted: kitOperationAdmitted(), refusal: await refusalOf(() => assertKitOperationAdmitted('probe')) });
  }
  return answers;
}

async function fixtureAdmits() {
  const guard = await import('../../src/kit-operation-guard.mjs');
  const { startSellerHost } = await import('../../src/host.mjs');
  const refusal = await refusalOf(() => startSellerHost({}));
  return { exports: Object.keys(guard).sort(), guard: guard.KIT_OPERATION_GUARD, admitted: guard.kitOperationAdmitted(), startRefusal: refusal?.code ?? null, startMessage: refusal?.message };
}

// A pending signed CREATE whose publisher died before the source journal: a read would recover it by resending.
async function recoveryWorld() {
  const w = await anchorFixture({ signRpc: async () => 'TEST rpc authentication' }), resends = [];
  w.source.observeBinding = async () => {};
  w.source.binding = async () => ({ disposition: 'pending' });
  w.source.recoverStorageWrite = async ({ signedTransaction }) => { resends.push(structuredClone(signedTransaction)); };
  w.controls.request = async (request) => {
    const signedTransaction = await signSdkCreate(request.transaction);
    await w.journal.put('demo/wallet/lane', { stage: 'broadcast-started', hash: signedTransaction.hash, signedTransaction });
    throw new Error('TEST interrupted before source journal');
  };
  return { ...w, resends };
}

async function artifactReadRecovery() {
  const { setKitOperationGuardForTest } = await import('../../src/kit-operation-guard.mjs');
  const readWhile = async (guard) => {
    setKitOperationGuardForTest('testnet-tp1');
    const w = await recoveryWorld();
    await w.publish(w.open(), ARTIFACT_JOB).catch(() => null);
    const input = [...w.journal.rows.values()].find((row) => row.input).input;
    setKitOperationGuardForTest(guard);
    // A read rebroadcasts only when asked to and the caller's own check allows it.
    const read = await w.open().read(input, { resend: true, authorizeResend: async () => true });
    return { status: read.status, resends: w.resends.length, walletRequests: w.captured.length };
  };
  return { admitted: await readWhile('testnet-tp1'), off: await readWhile('off') };
}

async function effectEntries() {
  const effects = { signs: 0, sends: 0 };
  const signBytes = (bytes) => { effects.signs++; return seller.signBytes(bytes); };
  const directory = privateTemporaryDirectory();
  const refused = {}, readable = {};
  const attempt = async (entry, run) => { refused[entry] = await refusalOf(run); };

  const { startSellerHost } = await import('../../src/host.mjs');
  const { createSellerAgent } = await import('../../src/dacs/seller-agent.mjs');
  const { createSellerAgentClient, createSellerHttpHandler } = await import('../../src/dacs/seller-http.mjs');
  const { createSellerTransportClientAuth, createSellerTransportServerAuth } = await import('../../src/dacs/seller-transport-auth.mjs');
  const { createSellerDurableState } = await import('../../src/dacs/seller-durable-state.mjs');
  const { createSignedCreateJournal, createPaymentEvidenceWalletJournal } = await import('../../src/dacs/payment-evidence-wallet-journal.mjs');
  const { createNativePaymentEvidenceConsumer } = await import('../../src/dacs/native-payment-evidence-consumer.mjs');
  const { nativeDemDeliverySubmitsOf, submitNativeDemDelivery } = await import('../../src/dacs/native-dem-delivery-consumer.mjs');
  const { signAnchorWrite } = await import('../../src/dacs/fixture-anchors.mjs');
  const { signatureCommitmentAnchor } = await import('../../src/dacs/commit-on-signature.mjs');
  const { createDevnetDemoAgreementContextProvider } = await import('../../src/devnet-demo/agreement-context.mjs');
  const { createDevnetDemoListingPublisher } = await import('../../src/devnet-demo/listing.mjs');
  const { createDevnetDemoDeliveryCapability } = await import('../../src/devnet-demo/native-delivery.mjs');
  const { storageWriteRpcSigner } = await import('../../src/devnet-demo/storage-write-recovery.mjs');

  await attempt('startSellerHost', () => startSellerHost({}));
  await attempt('createSellerAgent', () => createSellerAgent({}));
  await attempt('createSellerHttpHandler', () => createSellerHttpHandler({}));
  await attempt('createSellerAgentClient', () => createSellerAgentClient({}));
  await attempt('createSellerTransportServerAuth', () => createSellerTransportServerAuth({}));
  await attempt('createSellerTransportClientAuth', () => createSellerTransportClientAuth({}));
  await attempt('createNativePaymentEvidenceConsumer', () => createNativePaymentEvidenceConsumer({ anchorEvidence: async () => { effects.sends++; } }));
  await attempt('createDevnetDemoAgreementContextProvider', () => createDevnetDemoAgreementContextProvider({}));
  await attempt('signAnchorWrite', () => signAnchorWrite(signBytes, 'logical', 'hash'));
  await attempt('submitNativeDemDelivery', () => submitNativeDemDelivery({}, {}));
  await attempt('signatureCommitmentAnchor', () => signatureCommitmentAnchor({ onCreateAuthorized: () => { effects.sends++; }, anchorAgreement: async () => { effects.sends++; } }, {}, true).anchorAgreement({}));
  await attempt('createDevnetDemoListingPublisher', () => createDevnetDemoListingPublisher({ sign: signBytes, scanOwnListings: async () => [], loadRailResolution: async () => null,
    anchor: { publish: async () => { effects.sends++; }, read: async () => { effects.sends++; }, verifyReceipt: async () => { effects.sends++; } } })({}));
  await attempt('storageWriteRpcSigner', () => storageWriteRpcSigner({ claim: 'writer', sign: signBytes }, 'writer')('message'));

  const delivery = { authority: 'TEST-native', writer: seller.claim, publish: async () => { effects.sends++; }, read: async () => ({ status: 'absent' }), readRetained: async () => ({ status: 'absent' }), verifyReceipt: async () => 'valid' };
  await attempt('createDevnetDemoDeliveryCapability.submit', () => nativeDemDeliverySubmitsOf(createDevnetDemoDeliveryCapability({ authority: delivery.authority, anchor: delivery })).submit({}));

  const store = await createSellerDurableState({ dir: directory, signer: { claim: seller.claim, sign: signBytes }, listingPin: { contentHash: 'a'.repeat(64) } });
  effects.signs = 0; // opening the store authenticates its signer once; the refusals below must add none
  readable.durableState = typeof store.retainContext;
  await attempt('signOnce', () => store.signOnce('signature:probe', Buffer.from('bytes')));
  store.close?.();

  const journalOptions = (name) => ({ path: join(directory, name), signCreate: async () => { effects.signs++; }, broadcast: async () => { effects.sends++; }, readAccountNonce: async () => { effects.sends++; }, readTransactionState: async () => { effects.sends++; } });
  const evidence = createPaymentEvidenceWalletJournal(journalOptions('evidence.sqlite'));
  await attempt('anchorEvidence', () => evidence.anchorEvidence({}));
  await attempt('reconcilePaymentEvidence', () => evidence.reconcilePaymentEvidence({}));
  await attempt('ensureEvidence', () => evidence.ensureEvidence({}));
  readable.signedProjection = await evidence.readSignedProjection({ logicalAddress: 'dacs4:evidence:probe' });
  evidence.close();
  const other = createSignedCreateJournal({ ...journalOptions('other.sqlite'), table: 'probe_creates' });
  await attempt('guardedCreate', () => other.guardedCreate({}, { resume: false }));
  other.close();

  const anchors = await anchorFixture();
  await attempt('publish', () => anchors.publish(anchors.open(), ARTIFACT_JOB));
  readable.anchorRead = (await anchors.open().read({ logicalAddress: 'dacs4:probe', artifactKind: 'FinalityCommitmentRecord', artifact: {} }).catch((error) => ({ error: error.code ?? error.name }))).error ?? 'answered';
  return { refused, readable, effects, walletRequests: anchors.captured.length, anchorJournalRows: anchors.journal.rows.size };
}

const CASES = { startWithHostileOptions, concurrentStarts, namedGuardInputs, guardValues, fixtureAdmits, artifactReadRecovery, effectEntries };
process.stdout.write(JSON.stringify(await CASES[caseName](caseArguments)) + '\n');
