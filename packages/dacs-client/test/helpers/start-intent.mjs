// Shared fixtures for the one Start approval (DACS_INTENT_APPROVAL=on) tests.
// The wallet is the real embedded SDK session (sdk-provider.mjs over the
// built demos-runtime.mjs), its approve() wrapped by the intent gate and its
// SDK class fenced by that gate exactly as public/portal-intent/start.mjs does. "Dialogs" are the requests that
// reach the UI approval controller; "signed" are the SDK signMessage calls.
import { fileURLToPath } from 'node:url';
import { generateCanonicalJobId, canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { applyIntentHooks } from '../../src/portal/intent-hooks.mjs';
import { createIntentGate } from '../../public/portal-intent/gate.mjs';
import { checkSellerSessionDelegation } from '../../public/portal/seller-session-delegation.mjs';
import { createEphemeralWallet } from '../fixtures/wallet.mjs';
import { fixtureListing } from '../fixtures/listings.mjs';
import { buildUnsignedIdentityBundle } from '../../src/dacs/listing.mjs';

globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const runtime = await import('../../public/portal/embedded-wallet/demos-runtime.mjs');

// sdk-provider.mjs as the server serves it with the switch on: with its
// source-phase hook (src/portal/intent-hooks.mjs). The module imports nothing.
const served = applyIntentHooks(fileURLToPath(new URL('../../public/portal/', import.meta.url))).get('embedded-wallet/sdk-provider.mjs').body;
export const hookedProvider = await import(`data:text/javascript;base64,${served.toString('base64')}`);
const { createSdkWalletSession, EmbeddedWalletError } = hookedProvider;

// Every SDK signature this process makes, by message.
export const signedMessages = [];
export class CountingDemos extends runtime.Demos {
  async signMessage(message, options) {
    signedMessages.push(String(message));
    return super.signMessage(message, options);
  }
}

// dialog(request) answers the UI dialog; it defaults to approving. DemosCtor:
// a CountingDemos subclass, to pause the SDK inside a step (inside the gate's
// fence). around(Fenced): a subclass of the fenced class, to pause before it.
export async function gatedWallet({ transactionTransport, anchorJournal, now = () => Date.now(), dialog = () => true, mnemonic, DemosCtor = CountingDemos, around = (Fenced) => Fenced } = {}) {
  const dialogs = [];
  const uiApprove = async (request) => { dialogs.push(structuredClone(request)); return dialog(request); };
  const gate = createIntentGate({ approve: uiApprove, checkDelegation: checkSellerSessionDelegation, now });
  const session = createSdkWalletSession({ DemosCtor: around(gate.fenceSdk(DemosCtor, EmbeddedWalletError)), IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, approve: gate.approve,
    ...(transactionTransport ? { transactionTransport } : {}), ...(anchorJournal ? { anchorJournal: gate.fenceJournal(anchorJournal, EmbeddedWalletError) } : {}) });
  if (mnemonic) await session.importMnemonic(mnemonic);
  else await session.create();
  gate.attach(session);
  return { gate, session, dialogs, address: session.getPublicAccount().address };
}

export const DAY = 24 * 60 * 60 * 1000;

// A purchase view as the portal receives it, for the fixture profile, with
// the drafts the server would build (same functions the server uses).
export function fixturePurchase({ address, now = Date.now(), devnet = false, demContext = false } = {}) {
  const seller = createEphemeralWallet();
  const listing = fixtureListing(seller, { now: now - 60_000 });
  const jobId = generateCanonicalJobId();
  const id = `pur_${jobId.slice(-12)}`;
  const chainIdentity = 'ab'.repeat(32);
  const network = devnet ? 'demos-devnet' : 'demos-testnet';
  const terms = {
    profile: 'dacs-chatgpt-plugin/fixed-price-dem-purchase/v1', operation: 'purchase', network, rail: 'demos-native:DEM',
    domain: devnet ? { network, rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity } : { network, rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null },
    buyer: { accountId: 'acct_test_1', wallet: address },
    seller: { claim: seller.claim, payee: seller.address },
    listing: { listingId: listing.listingId, version: listing.listingVersion, contentHash: null },
    price: { amount: '2.5', amountOs: '2500000000' },
    approvalExpiresAt: new Date(now + DAY).toISOString(),
    protocol: devnet
      ? { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', jobId, transportBinding: { source: 'devnet-agreement-transport/v1', network, chainIdentity }, ...(demContext ? { agreementContext: 'dacs-chatgpt-plugin/dem-delivery-context/v1' } : {}) }
      : { profile: 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1', jobId, ...(demContext ? { agreementContext: 'dacs-chatgpt-plugin/dem-delivery-context/v1' } : {}) },
  };
  return { seller, listing, jobId, id, terms, chainIdentity, network };
}

export async function withListingHash(p) {
  const { contentHash } = await import('@kynesyslabs/dacs');
  p.terms.listing.contentHash = contentHash(p.listing);
  return p;
}

// The Start view: the pinned Listing as the server returns it, and the seller
// session delegation payload when the terms carry one.
export function viewFor(p, { now = Date.now(), recordId = 'rec_aaaaaaaaaaaaaaaaaaaaaa', plannedNonce = 1, delegation = null, listing = p.listing, recordTtlMs = 10 * 60_000 } = {}) {
  return {
    id: p.id, status: 'agreement_pending', terms: p.terms, termsHash: sha256Hex(canonicalize(p.terms)), expiresAt: new Date(now + DAY).toISOString(),
    start: { intent: { id: recordId, expiresAt: new Date(now + recordTtlMs).toISOString() }, listing, agreement: { generatedAt: now }, identity: { bundle: identityFor(p, p.terms.buyer.wallet, now).bundle }, delegation: delegation ? { payload: delegation } : null, wallet: { plannedNonce } },
  };
}

// A seller session delegation payload for p, as seller-transport-auth.mjs builds it.
export function delegationFor(p, address, { now = Date.now(), session = createEphemeralWallet(), notBefore = now - 1000, expiresAt = now + 3_600_000 } = {}) {
  return { version: '1', kind: 'seller-session-delegation', buyer: `did:demos:agent:${address.slice(2)}`, sessionPublicKey: session.claim.slice('did:demos:agent:'.length), seller: p.seller.claim,
    listingPin: { listingId: p.listing.listingId, version: p.listing.listingVersion, contentHash: p.terms.listing.contentHash }, jobId: p.jobId, notBefore, expiresAt };
}

export function identityFor(p, address, presentedAt = Date.now()) {
  return buildUnsignedIdentityBundle({ address, presentedAt, sessionSeed: `${p.id}:${p.jobId}` });
}
