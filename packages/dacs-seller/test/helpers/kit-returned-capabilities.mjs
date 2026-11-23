// Builds, with the guard on, the capability each constructor in RETURNED_CLASSIFICATION returns, over fixtures that already build
// it, so kit-operation-guard.test.mjs can enumerate what each one hands out. Keys are '<file>#<constructor>'.
// The wallet-session world comes first: it installs the client's purchase-admission hook before any module reaches the client.
import { walletSessionWorld } from './seller-wallet-session-world.mjs';
import { contextWireWorld } from './context-wire-world.mjs';
import { countedKeyRoles } from './counted-key-roles.mjs';
import { HOST_CONTEXT_CALLBACKS } from './host-context-callbacks.mjs';
import { orchestratorFixture } from './vet-orchestrator-fixture.mjs';
import { readOnlyRoleOf, TEST_BINDING, testEffectBoundary, testRunCreate } from './agent-signing.mjs';
import { world as wireWorld } from './wire-routes-world.mjs';
import { TEST_CONNECTION } from './wire-authority-fixture.mjs';
import { seller } from './protocol-fixture.mjs';
import { createAnswerSigners } from '../../src/dacs/answer-signers.mjs';
import { createDemDeliveryContext, demDeliveryContextHost } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { createContextOutcomeRevalidation } from '../../src/dacs/seller-context-continuation.mjs';
import { resumeContext } from '../../src/dacs/seller-context-recovery.mjs';
import { createSellerAgentClient } from '../../src/dacs/seller-http.mjs';
import { wireAuthenticator } from '../../src/dacs/seller-wire-requests.mjs';
import { lateSellerCreatePass } from '../../src/devnet-demo/create-pass.mjs';
import { createDevnetDemoListingPublisher } from '../../src/devnet-demo/listing.mjs';

/** Map of '<file>#<constructor>' to the capability that constructor returned. */
export async function returnedCapabilities(t) {
  const vet = await orchestratorFixture(t);
  const provider = vet.provider();
  const session = await walletSessionWorld(t);
  const key = await countedKeyRoles(t);
  const wire = await wireWorld(t);
  const context = await contextWireWorld(t);
  const signer = { claim: seller.claim, sign: seller.signBytes };
  const capability = createDemDeliveryContext({ authority: 'TEST-inventory', resolveBuyer: async () => null, resolveSeller: async () => null, ...HOST_CONTEXT_CALLBACKS });
  return new Map([
    ['src/devnet-demo/agreement-context.mjs#createDevnetDemoAgreementContextProvider', provider],
    ['src/devnet-demo/seller-wallet-session.mjs#createSellerWalletSession', session.port],
    ['src/devnet-demo/listing.mjs#createDevnetDemoListingPublisher', createDevnetDemoListingPublisher({ anchor: { publish: async () => {}, read: async () => {}, verifyReceipt: async () => {} },
      sign: signer.sign, scanOwnListings: async () => ({ status: 'ok', anchors: [] }), loadRailResolution: async () => null, runCreate: testRunCreate().runCreate })],
    ['src/devnet-demo/create-pass.mjs#createSellerCreatePass', testRunCreate()],
    ['src/devnet-demo/create-pass.mjs#lateSellerCreatePass', lateSellerCreatePass(() => testRunCreate().runCreate)],
    ['src/seller-key.mjs#openSellerKey', key.key],
    ['src/dacs/seller-http.mjs#createSellerAgentClient', createSellerAgentClient({ url: 'http://127.0.0.1:1', commitOnSignature: true })],
    ['src/dacs/answer-signers.mjs#createAnswerSigners', createAnswerSigners({ roles: { ...signer, readOnlyAnswerSigner: readOnlyRoleOf(signer) }, effectBoundary: testEffectBoundary().effectBoundary,
      binding: TEST_BINDING, local: () => ({ ...TEST_CONNECTION }) })],
    ['src/dacs/seller-wire-requests.mjs#wireAuthenticator', wireAuthenticator(wire.handle.wire, wire.agent)],
    ['src/dacs/seller-context-route.mjs#createWireSellerContextRoute', context.route],
    ['src/dacs/seller-context-recovery.mjs#resumeContext', resumeContext(provider, vet.input)],
    ['src/dacs/seller-context-continuation.mjs#createContextOutcomeRevalidation', createContextOutcomeRevalidation({ provider, retainedBody: vet.input })],
    ['src/dacs/dem-delivery-context-consumer.mjs#demDeliveryContextHost', demDeliveryContextHost(capability)],
  ]);
}
