// A second instance of our program on the same journal file: it reserves through the module and reports each step to the parent.
// Modes: reserve (default), before (killed holding the lock during the chain read), after (killed after ownership commits),
// stall (holds the lock until the parent says finish), dispatch (binds signed bytes, records confirm-started, then is killed).
import { createSignerReservations } from '../../src/wallet/signer-reservation.mjs';
import { args, open, options, signed } from './signer-reservation-world.mjs';
import { installNoEgress } from './no-egress.mjs';

const trap = installNoEgress();
const [path, mode, attemptId] = process.argv.slice(2);
const journal = open(path), reservations = createSignerReservations(options(journal));
const send = value => new Promise(resolve => process.send(value, resolve));
try {
  const input = args(attemptId, attemptId);
  if (mode === 'before') input.readChainNonce = async () => { await send({ event: 'reading' }); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); };
  if (mode === 'stall') input.readChainNonce = async () => { await send({ event: 'reading' }); await new Promise(resolve => process.once('message', resolve)); return 0; };
  let { reservation } = await reservations.reserve(input);
  if (mode === 'after') { await send({ event: 'committed' }); process.kill(process.pid, 'SIGKILL'); }
  if (mode === 'dispatch') {
    reservation = await reservations.bindApprovalIntent(reservation, 'TEST-exact-request');
    reservation = await reservations.bindApproval(reservation, { ledgerId: 'TEST-ledger', requestText: 'TEST-exact-request' });
    reservation = await reservations.bindSigned(reservation, signed());
    await reservations.recordStage(reservation, 'confirm-started');
    await send({ event: 'dispatched' }); process.kill(process.pid, 'SIGKILL');
  }
  await send({ event: 'result', reservation, egress: trap.attempts });
} catch (error) { await send({ event: 'error', code: error.code, message: error.message }); }
finally { journal.close(); trap.restore(); process.disconnect(); }
