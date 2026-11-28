// Child process of the seller Node wallet's crash and restart tests. It builds the wallet in DATA_DIRECTORY under the real
// seller state lock, over the chain and approval ledger files in STATE_DIRECTORY, then acts by MODE and is killed (SIGKILL):
//   anchor:<cut>   anchors one payment evidence inside an effect pass, killed at the cut: `signed` (the inner signature made,
//                  nothing stored), `bound` (the adapter stored the signed bytes, the journal has not kept them), `kept` (the
//                  journal kept them, nothing sent) or `sent` (the broadcast applied, before its answer).
//   guarded:<n>    sends one artifact CREATE whose authorize is killed during its n-th call (1: as the approval answer returns,
//                  2: at the signature), after writing `killed.json` with the call and the node reads so far.
//   hold-locks     holds the signer's reservation lock and an artifact-journal lane lock, prints `ready`, and waits.
//   recovery:<n>   is killed at the n-th check of the state lock while the wallet is built (2: as the artifact journal's lock
//                  rows are recovered, 3: as the composition journal's are).
//   second-lock    tries to take the seller state lock and prints the refusal.
//   qualify:<n>    anchors one payment evidence inside an effect pass and is killed inside the n-th node qualification read of its
//                  gate passes (1: the signature's, 2: the confirmation's, 3: the broadcast's, after its durable intent).
// Usage: node seller-node-wallet-child.mjs MODE DATA_DIRECTORY STATE_DIRECTORY JOURNAL_MODE
import { mock } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, COMPOSITION_JOURNAL, createSellerNodeWallet, evidenceInput, inWalletPass, nodeConnection, persistedApproval, preparedWrite, replayNode,
  sellerApproval, setPurchaseAdmission, spyTransactionSignatures, walletOptions } from './seller-node-wallet-world.mjs';
import { journalOverAdapter } from './payment-evidence-test-journals.mjs';

const { acquireSellerStateLock } = await import('../../src/devnet-demo/seller-state-lock.mjs');
const { openDurableWalletJournal } = await import('@kynesyslabs/dacs-client/wallet/durable-journal');
const { signerReservationKey } = await import('../../../dacs-client/src/wallet/signer-reservation.mjs');

const [mode, directory, stateDirectory, journalMode] = process.argv.slice(2);
const [action, cut] = mode.split(':');
const die = () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); };
const forever = () => new Promise(() => {});

if (action === 'second-lock') {
  try { await acquireSellerStateLock(directory); process.stdout.write(`${JSON.stringify({ acquired: true })}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ code: error.code, reason: error.reason })}\n`); }
  process.exit(0);
}

setPurchaseAdmission('testnet-tp1');
const node = replayNode(join(stateDirectory, 'chain.json')), approval = persistedApproval(join(stateDirectory, 'approval.json'));
const connection = await nodeConnection(node), lock = await acquireSellerStateLock(directory);
let checks = 0;
const stateLock = action === 'recovery' ? { path: lock.path, held: () => { if (++checks === Number(cut)) process.kill(process.pid, 'SIGKILL'); return lock.held(); } } : lock;
if (mode === 'anchor:signed') await spyTransactionSignatures(mock, transaction => { writeFileSync(join(stateDirectory, 'signed.json'), JSON.stringify({ nonce: transaction.content.nonce })); return die(); });
if (mode === 'anchor:bound') {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function prepareOrDie(sql, ...rest) {
    if (/^INSERT INTO evidence_creates /.test(sql)) process.kill(process.pid, 'SIGKILL');
    return Reflect.apply(prepare, this, [sql, ...rest]);
  };
}
if (mode === 'anchor:kept') approval.reopen = die;
if (mode === 'anchor:sent') {
  node.reply = row => {
    if (row.body.params[0].extra !== 'broadcastTx') return undefined;
    const tx = row.body.params[0].data.response.data.transaction;
    node.applied.set(tx.hash, structuredClone(tx)); node.nonce = tx.content.nonce; node.save();
    return die();
  };
}
const options = await walletOptions({ connection, directory, stateLock, journalMode, approve: sellerApproval(approval) });
if (action === 'qualify') {
  const shipped = options.readDeploymentEvidence;
  let qualifications = 0;
  options.readDeploymentEvidence = input => (++qualifications === Number(cut) ? die() : shipped(input));
}
const wallet = await createSellerNodeWallet(options);
const world = { owner: connection.owner, wallet, node, directory, options };
if (action === 'anchor' || action === 'qualify') await inWalletPass(world, () => journalOverAdapter(world).anchorEvidence(evidenceInput(world)));
if (action === 'guarded') {
  const write = await preparedWrite(world);
  let calls = 0;
  const authorize = () => {
    if (++calls === Number(cut)) {
      writeFileSync(join(stateDirectory, 'killed.json'), JSON.stringify({ call: calls, reads: node.reads }));
      process.kill(process.pid, 'SIGKILL');
    }
    return true;
  };
  await inWalletPass(world, () => write.wallet.request(write.request, { authorize }),
    { context: api.passContext({ operationClass: 'job-create', currentAuthorization: () => true }) });
}
if (action === 'hold-locks') {
  const second = openDurableWalletJournal({ path: join(directory, COMPOSITION_JOURNAL), mode: 'open' });
  await new Promise(held => { second.withWalletLock(signerReservationKey(TP1_APPROVED_IDENTITY_RECORD, wallet.address), () => { held(); return forever(); }); });
  await new Promise(held => { wallet.artifactJournal.withWalletLock('TEST-artifact-lane', () => { held(); return forever(); }); });
  process.stdout.write('ready\n');
  await forever();
}
// Every mode that reaches this line missed its cut.
process.exit(3);
