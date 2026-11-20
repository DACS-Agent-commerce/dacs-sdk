// How a restarted host resumes a send whose confirmation the journal retained: a resume context names the retained operation, and the
// retained transaction is confirmed again and its confirmation broadcast through the session's held transport.
import { passContext, runInPassContext } from '../../src/wallet/pass-context.mjs';
import { confirmThroughFacade, sha, signingWallet } from './seller-facade-confirm.mjs';

/** Resumes the first retained signed transaction of `world`; resolves the node's answer to the broadcast. */
export async function resumeRetainedConfirmation(world) {
  const signed = (await world.records()).find(record => record.bytes);
  const tx = JSON.parse(Buffer.from(signed.bytes, 'base64').toString());
  const wallet = await signingWallet(world), facade = world.session.transport;
  const context = passContext({ operationClass: 'job-resume', operationId: signed.operationId, currentAuthorization: () => true });
  return runInPassContext(context, async () => {
    const { answer, lease } = await confirmThroughFacade(world, wallet, tx);
    try {
      await facade.binding({ phase: 'broadcast', address: wallet.address, leaseId: lease.leaseId, hash: tx.hash });
      const identity = 'ed25519:' + wallet.address, timestamp = String(world.clock.now() + 2);
      return await facade.rpc({ method: 'execute', params: [{ extra: 'broadcastTx', data: answer }] },
        { identity, timestamp, signature: wallet.signBytes(Buffer.from(sha(`${identity}:${timestamp}`))).toString('hex') });
    } finally { await facade.binding({ phase: 'release', address: wallet.address, leaseId: lease.leaseId }); }
  });
}
