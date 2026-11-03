// Embedded (extension-free) Demos wallet session over the real Demos SDK.
// EXPERIMENTAL and default-off, pending the independent security review and
// actual host/live checks.
//
// Contract (docs/EMBEDDED-WALLET-SDK.md):
//  - DemosCtor is the upstream @kynesyslabs/demosdk 4.0.16 `Demos` class (the
//    browser build is ./demos-runtime.mjs). Its local wallet primitives are
//    used for every session: newMnemonic, connectWallet(…, {algorithm:"ed25519"}),
//    getAddress, signMessage, disconnect. Creating, importing and signing
//    messages never contact a node.
//  - validateMnemonic must be the SDK's own check (demos-runtime.mjs exports
//    it). connectWallet treats a string that fails it as a BIP-39 passphrase
//    and silently derives a different identity, so import refuses such input
//    and fails closed when no validator was injected.
//  - request() answers the existing provider envelope {success, data, error}.
//    It never returns the mnemonic or key material. exportMnemonicForUser is a
//    separate local UI-only function and is not reachable through request().
//  - Writes (sendTransaction for a native DEM send or the storage-program
//    create that publishes a signed DACS listing, addGithubIdentity,
//    addTwitterIdentity, removeWeb2Identity) exist only with a valid
//    transactionTransport {profile:"simulated-loopback", rpcUrl, network,
//    resolveGithubUser?}. The SDK's only network seam is the rpc_url set by its
//    public connect(rpc_url); every node call then goes there through the SDK's
//    own axios. rpcUrl is the server's same-origin relay to a loopback chain
//    fixture (src/portal/wallet-rpc.mjs). Without a transport every write
//    answers not_configured; with any other transport, unsupported.
//  - The explicit testnet transport {profile:"testnet-held", network} is HELD
//    for the required independent review and live gates: it labels the
//    session with the configured network, and every write answers
//    held_for_review before any node call. No configuration un-holds it.
//  - Each write: read-only preparation (connect, node fee/nonce or the
//    identity facts the SDK reads), then one deliberate approval of the exact
//    content, then SDK sign, SDK confirm (node validation, nothing executed),
//    then exactly one SDK broadcast. Once broadcast has started the result is
//    success, broadcast_rejected or outcome_unknown, never retried here. A
//    wallet result is not settlement, publication or identity proof: the
//    server decides from its own chain readback.
//  - A native DEM send shows its complete debit before approval (seller
//    amount, the SDK's fixed 1 DEM gas edit, the node-reported fees, total),
//    then refuses to send unless the signed transaction and the node's
//    confirmation carry exactly that: the four SDK edits (amount debit, payee
//    credit, gas debit, nonce), those fees, no additional fee or custom charge.
//  - Network: the session's only network is its transport (the simulated
//    relay, or the held testnet label). A native send's signed bytes carry no
//    chain identity, so no signature here is network-bound.
//  - Separately declared dacs-storage-anchor-create requests are offline-only:
//    literal loopback relay, synthetic fixture identity, exact SDK signed-scope
//    and CF-1 envelope hashes, independent owner, immutable CREATE, full debit,
//    and an injected atomic journal. Signed network fields label fixture scope;
//    they are not authenticated real-chain identity or finality. Production
//    durable journaling, arbitrary normative receipt hashes and purchase/adapter
//    integration remain held. Existing Listing validation is unchanged.

const ADDRESS = /^0x[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^(0x)?[0-9a-f]{128}$/;
const HASH = /^[0-9a-f]{64}$/;
const HANDLE = /^[A-Za-z0-9_-]{1,39}$/;
const OS_STRING = /^(0|[1-9][0-9]*)$/;
const IDENTITY_WRITES = ['addGithubIdentity', 'addTwitterIdentity', 'addDiscordIdentity', 'addTelegramIdentity', 'removeWeb2Identity', 'inferWeb2Identity', 'inferXmIdentity', 'removeXmIdentity'];
const TRANSACTION_METHODS = ['sendTransaction', 'signTransaction', 'pay', 'transfer', 'broadcast', 'confirm'];
// Writes this wallet performs when a valid transport is configured.
const WRITES = ['sendTransaction', 'addGithubIdentity', 'addTwitterIdentity', 'removeWeb2Identity'];
// Existing server payloads. The offline SR-2 kind is separately declared and
// requires an explicit lane journal; it is never inferred from storage data.
const TRANSACTION_KINDS = ['native-send', 'storage-program-create'];
export const DACS_STORAGE_ANCHOR_KIND = 'dacs-storage-anchor-create';
export const DACS_STORAGE_ANCHOR_CHAIN_IDENTITY = '834375ad6381d9eedbaea18bfe841416fe680e00fa74b09ab711fde45d08e8e2';
const OS_PER_DEM = 1_000_000_000n;
const STORAGE_ADDRESS = /^stor-[0-9a-f]{40}$/;
const PROGRAM_NAME = /^dacs1-[A-Za-z0-9_-]{1,1024}$/;
// buildStorageProgramCreatePayload (src/dacs/wallet-transactions.mjs) fields.
const STORAGE_CREATE_FIELDS = ['acl', 'data', 'encoding', 'metadata', 'operation', 'programName', 'salt', 'storageAddress', 'storageLocation'];
// SDK 4.0.16 STORAGE_PROGRAM_CONSTANTS.PRICING_CHUNK_BYTES / FEE_PER_CHUNK and
// the fixed GCRGeneration gas edit (gasAmount = 1 DEM) on non-identity txs.
const STORAGE_CHUNK_BYTES = 10240;
const SDK_GAS_OS = OS_PER_DEM;
// SDK 4.0.16 Identities.formats.web2 prefixes for the two supported contexts.
const PROOF_PREFIXES = {
  github: ['https://gist.github.com', 'https://raw.githubusercontent.com', 'https://gist.githubusercontent.com'],
  twitter: ['https://x.com', 'https://twitter.com'],
};

export const EMBEDDED_NETWORK = 'unconfigured';
export const EMBEDDED_EVIDENCE_MODE = 'local-key-only';
export const TRANSPORT_PROFILE = 'simulated-loopback';
export const TRANSPORT_EVIDENCE_MODE = 'simulated-fixture';
export const HELD_TRANSPORT_PROFILE = 'testnet-held';
export const HELD_EVIDENCE_MODE = 'testnet-held-no-writes';
export const DEVNET_NATIVE_TRANSPORT_PROFILE = 'devnet-native';
export const DEVNET_AGREEMENT_TRANSPORT_PROFILE = 'devnet-agreement';
export const DEVNET_AGREEMENT_STORAGE_KIND = 'devnet-agreement-storage-create';
export const DEVNET_SETTLEMENT_STORAGE_KIND = 'devnet-settlement-evidence-storage-create';
export const DEVNET_SETTLEMENT_POLICY = 'dacs-native-settlement-publication/v1';
export const DEVNET_DELIVERY_STORAGE_KIND = 'devnet-deliverable-storage-create';
export const DEVNET_DELIVERY_POLICY = 'dacs-native-delivery-publication/v1';
export const DEVNET_DEMO_STORAGE_KIND = 'devnet-demo-artifact-storage-create';
export const DEVNET_DEMO_ARTIFACT_POLICY = 'dacs-devnet-demo-artifacts/v1';
export const DEVNET_DEMO_ARTIFACT_TYPES = Object.freeze(['CompositeVerificationRecord', 'Deliverable', 'FinalityCommitmentRecord', 'Listing']);
export const DEVNET_NATIVE_EVIDENCE_MODE = 'explicit-pinned-transport-single-node';
export const HELD_GATES = Object.freeze(['security-review', 'live-wallet-compatibility', 'testnet-network-identity', 'human-approval']);
const HELD_MESSAGE = 'Testnet writes are held for the required independent security review and live gates. Nothing was signed or sent.';
const EVIDENCE_LABEL = 'SIMULATED loopback fixture (not Demos testnet; no real funds)';
const SENDING_NOTE = 'Signed in this page, validated by the node, then broadcast exactly once. Never retried automatically; the server confirms the result from its own chain readback.';

// Keep this statically served provider self-contained. Equivalence with the
// package helpers is pinned by d11-seam-parameters.test.mjs.
export class EmbeddedWalletError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function nativePayloadDigest(content) {
  const address = (v) => (typeof v === 'string' ? `0x${v.toLowerCase().replace(/^0x/, '')}` : null);
  return sha256HexOfText(anchorJson({ type: content?.type ?? null, from: address(content?.from), to: address(content?.to), amount: content?.amount ?? null,
    data: content?.data ?? null, nonce: content?.nonce ?? null, timestamp: content?.timestamp ?? null }));
}

export function storageConfirmationShapeMatches(data) {
  return hasKeys(data?.transaction, ['content', 'signature', 'hash', 'status', 'blockNumber'])
    && Object.keys(data).every((k) => ['valid', 'reference_block', 'message', 'gas_operation', 'transaction', 'custom_charges'].includes(k))
    && data.custom_charges == null
    && (data.gas_operation == null || (hasKeys(data.gas_operation, ['fees'])
      && hasKeys(data.gas_operation.fees, ['network_fee', 'rpc_fee', 'additional_fee'])));
}

function ok(data) {
  return { success: true, data, error: null };
}

function fail(code, message) {
  return { success: false, data: null, error: { code, message } };
}

// SDK-generated mnemonics are lowercase words joined by single spaces, and
// connectWallet hashes the exact string, so import uses that same form.
function normalizeMnemonic(value) {
  if (typeof value !== 'string') throw new EmbeddedWalletError('invalid_mnemonic', 'recovery phrase must be text');
  return value.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
}

// The transport is honoured only in its exact documented shape; its members
// are read once here and never invoked unless the shape matches. A held
// testnet transport carries only its network label: it has no rpcUrl and
// never reaches a node.
function readTransport(candidate) {
  if (candidate === null || typeof candidate !== 'object') return null;
  const { profile, rpcUrl, network, resolveGithubUser } = candidate;
  if (typeof network !== 'string' || !network) return null;
  if (profile === HELD_TRANSPORT_PROFILE) return Object.freeze({ held: true, network });
  if (profile === DEVNET_NATIVE_TRANSPORT_PROFILE || profile === DEVNET_AGREEMENT_TRANSPORT_PROFILE) {
    const agreement=profile===DEVNET_AGREEMENT_TRANSPORT_PROFILE;
    const settlement=agreement && candidate.settlementPublication !== undefined;
    const delivery=settlement && candidate.deliveryPublication !== undefined;
    const demo=delivery && candidate.demoArtifactPublication !== undefined;
    const expectedKeys=agreement ? ['bindingUrl',...(delivery?['deliveryPublication']:[]),...(demo?['demoArtifactPublication']:[]),'network','profile','rpcUrl',...(settlement?['settlementPublication']:[]),'transportBinding'].sort().join(',') : 'bindingUrl,network,profile,rpcUrl';
    if (Object.keys(candidate).sort().join(',') !== expectedKeys || typeof candidate.bindingUrl !== 'string') return null;
    try {
      const rpc=new URL(rpcUrl), binding=new URL(candidate.bindingUrl);
      if (!globalThis.location?.origin || rpc.origin !== globalThis.location.origin || binding.origin !== rpc.origin
        || !['http:','https:'].includes(rpc.protocol) || rpc.username || rpc.password || rpc.search || rpc.hash || binding.username || binding.password || binding.search || binding.hash
        || rpc.pathname !== '/portal/api/devnet-native-wallet-rpc' || binding.pathname !== '/portal/api/devnet-native-wallet-binding') return null;
      const bindingKeys=['source','bindingVersion','bindingId','network','chainIdentity','pinVersion','endpoint','transportAuthority',...(settlement?['settlementPublication']:[]),...(delivery?['deliveryPublication']:[]),...(demo?['demoArtifactPublication']:[])];
      if(agreement && (!hasKeys(candidate.transportBinding,bindingKeys) || candidate.transportBinding.source !== 'devnet-agreement-transport/v1' || candidate.transportBinding.bindingVersion !== 'dacs-demos-network-binding/v1' || candidate.transportBinding.network !== network || !HASH.test(candidate.transportBinding.bindingId) || !HASH.test(candidate.transportBinding.chainIdentity) || new URL(candidate.transportBinding.endpoint).protocol !== 'https:')) return null;
      if(settlement && (!hasKeys(candidate.settlementPublication,['policy','artifactKind','phase','railId','phaseIndex','authority']) || candidate.settlementPublication.policy!==DEVNET_SETTLEMENT_POLICY || candidate.settlementPublication.artifactKind!=='SettlementEvidence' || candidate.settlementPublication.phase!=='pay-dem' || candidate.settlementPublication.railId!=='demos-native:DEM' || candidate.settlementPublication.phaseIndex!==2 || typeof candidate.settlementPublication.authority!=='string' || !candidate.settlementPublication.authority.startsWith('TEST-') || anchorJson(candidate.transportBinding.settlementPublication)!==anchorJson(candidate.settlementPublication))) return null;
      if(delivery && (!hasKeys(candidate.deliveryPublication,['policy','artifactKind','phase','phaseIndex','authority']) || candidate.deliveryPublication.policy!==DEVNET_DELIVERY_POLICY || candidate.deliveryPublication.artifactKind!=='Deliverable' || candidate.deliveryPublication.phase!=='deliver-storage-program' || !Number.isSafeInteger(candidate.deliveryPublication.phaseIndex) || candidate.deliveryPublication.phaseIndex<0 || typeof candidate.deliveryPublication.authority!=='string' || !candidate.deliveryPublication.authority.startsWith('TEST-') || anchorJson(candidate.transportBinding.deliveryPublication)!==anchorJson(candidate.deliveryPublication))) return null;
      if(demo && (!hasKeys(candidate.demoArtifactPublication,['policy','artifactKinds','authority']) || candidate.demoArtifactPublication.policy!==DEVNET_DEMO_ARTIFACT_POLICY || ![DEVNET_DEMO_ARTIFACT_TYPES,[...DEVNET_DEMO_ARTIFACT_TYPES,'SettlementEvidence']].some(kinds=>anchorJson(candidate.demoArtifactPublication.artifactKinds)===anchorJson(kinds)) || typeof candidate.demoArtifactPublication.authority!=='string' || !/^TEST-RUN-[A-Za-z0-9._-]{8,80}$/.test(candidate.demoArtifactPublication.authority) || anchorJson(candidate.transportBinding.demoArtifactPublication)!==anchorJson(candidate.demoArtifactPublication))) return null;
      return Object.freeze({ held:false,devnetNative:true,devnetAgreement:agreement,devnetSettlement:settlement,devnetDelivery:delivery,devnetDemo:demo,rpcUrl:rpc.href,bindingUrl:binding.href,network,...(agreement?{transportBinding:JSON.parse(JSON.stringify(candidate.transportBinding)),...(settlement?{settlementPublication:JSON.parse(JSON.stringify(candidate.settlementPublication))}:{}),...(delivery?{deliveryPublication:JSON.parse(JSON.stringify(candidate.deliveryPublication))}:{}),...(demo?{demoArtifactPublication:JSON.parse(JSON.stringify(candidate.demoArtifactPublication))}:{})}:{}) });
    } catch { return null; }
  }
  if (profile !== TRANSPORT_PROFILE || typeof rpcUrl !== 'string') return null;
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  return Object.freeze({ held: false, rpcUrl, network, resolveGithubUser: typeof resolveGithubUser === 'function' ? resolveGithubUser : null });
}

// Actual same-origin server capability descriptor, not approval/verification
// supplied by the model. Every signature/send still consumes fresh server
// network-binder fences and the normal exact wallet debit approval.
export function createDevnetNativeWalletTransport(profile) {
  const candidate={ profile:profile?.profile,network:profile?.network,rpcUrl:profile?.rpcUrl,bindingUrl:profile?.bindingUrl };
  if(!readTransport(candidate)?.devnetNative) throw new EmbeddedWalletError('held_for_review','no same-origin native source capability is available');
  return Object.freeze(candidate);
}

// Wire amount (post-fork OS string or pre-fork DEM number) -> OS bigint.
function wireToOs(value) {
  if (typeof value === 'string' && OS_STRING.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value) * OS_PER_DEM;
  return null;
}

function formatDem(os) {
  const whole = os / OS_PER_DEM;
  const frac = (os % OS_PER_DEM).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase().replace(/^0x/, '') === b.toLowerCase().replace(/^0x/, '');

// The native-send payload the server hands over (src/dacs/wallet-transactions.mjs
// buildNativeTransferPayload). Only that exact shape is accepted.
function nativeSendPlan(tx, address) {
  const content = tx?.content;
  const op = Array.isArray(content?.data) && content.data.length === 2 && content.data[0] === 'native' ? content.data[1] : null;
  if (!content || content.type !== 'native' || !op || op.nativeOperation !== 'send' || !Array.isArray(op.args) || op.args.length !== 2) {
    throw new EmbeddedWalletError('invalid_params', 'sendTransaction expects params: [native DEM send transaction]');
  }
  const [argTo, argAmount] = op.args;
  const amountOs = wireToOs(argAmount);
  if (typeof content.to !== 'string' || !ADDRESS.test(content.to.toLowerCase()) || !sameAddress(argTo, content.to) || amountOs === null || amountOs <= 0n
    || wireToOs(content.amount) !== amountOs || !Number.isSafeInteger(content.nonce) || content.nonce < 1) {
    throw new EmbeddedWalletError('invalid_params', 'the transaction recipient, amount or nonce is malformed');
  }
  if (!sameAddress(content.from, address)) throw new EmbeddedWalletError('wrong_wallet', 'this transaction is for a different wallet');
  return { to: content.to.toLowerCase(), amountOs, nonce: content.nonce, data: JSON.stringify(content.data) };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' ? String(value) : '(missing)');

// Signed wire amount -> OS bigint, by the signed content's own form: after the
// denomination fork every amount and fee is a decimal OS string, before it a
// whole-DEM number. Anything else is unreadable (null).
function osOf(value, postFork) {
  if (postFork) return typeof value === 'string' && OS_STRING.test(value) ? BigInt(value) : null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) * OS_PER_DEM : null;
}

// Everything a signed native send commits to debiting from this wallet. SDK
// 4.0.16 Demos.sign writes the node's getNetworkParameters networkFee/rpcFee
// into transaction_fee as whole DEM (additional_fee 0); any other fee value
// cannot be shown exactly before signing and is refused (null).
function nativeDebit(plan, fee) {
  const feeOs = (value) => (Number.isSafeInteger(value) && value >= 0 ? BigInt(value) * OS_PER_DEM : null);
  const networkFeeOs = feeOs(fee.networkFee);
  const rpcFeeOs = feeOs(fee.rpcFee);
  if (networkFeeOs === null || rpcFeeOs === null) return null;
  return { amountOs: plan.amountOs, gasOs: SDK_GAS_OS, networkFeeOs, rpcFeeOs, additionalFeeOs: 0n, totalOs: plan.amountOs + SDK_GAS_OS + networkFeeOs + rpcFeeOs };
}

const debitView = (d) => ({
  sellerAmountDem: formatDem(d.amountOs),
  sdkGasDem: formatDem(d.gasOs),
  networkFeeDem: formatDem(d.networkFeeOs),
  rpcFeeDem: formatDem(d.rpcFeeOs),
  additionalFeeDem: formatDem(d.additionalFeeOs),
  totalDem: formatDem(d.totalOs),
  totalOs: d.totalOs.toString(),
  note: 'Everything this transaction commits to taking from this wallet: the seller amount, the SDK gas edit and the node fees. The wallet does not send if the signed or node-confirmed transaction differs.',
});

const FEE_KEYS = JSON.stringify(['additional_fee', 'network_fee', 'rpc_address', 'rpc_fee']);
function feesMatch(fees, debit, postFork) {
  return isPlainObject(fees) && JSON.stringify(Object.keys(fees).sort()) === FEE_KEYS
    && osOf(fees.network_fee, postFork) === debit.networkFeeOs && osOf(fees.rpc_fee, postFork) === debit.rpcFeeOs
    && osOf(fees.additional_fee, postFork) === debit.additionalFeeOs;
}

// SDK 4.0.16 GCRGeneration for a native send, in order: the amount debit from
// this wallet, the payee credit, the fixed gas debit (gasAmount 1 DEM) and the
// nonce increment, each exactly {type, operation, isRollback, account, txhash,
// amount}. Any other or extra edit is refused.
const EDIT_KEYS = JSON.stringify(['account', 'amount', 'isRollback', 'operation', 'txhash', 'type']);
function nativeEditsMatch(edits, plan, address, postFork) {
  const expected = [
    ['balance', 'remove', address, plan.amountOs],
    ['balance', 'add', plan.to, plan.amountOs],
    ['balance', 'remove', address, SDK_GAS_OS],
    ['nonce', 'add', address, null],
  ];
  return Array.isArray(edits) && edits.length === expected.length && edits.every((edit, i) => {
    const [type, operation, account, os] = expected[i];
    return isPlainObject(edit) && JSON.stringify(Object.keys(edit).sort()) === EDIT_KEYS
      && edit.type === type && edit.operation === operation && edit.isRollback === false && typeof edit.txhash === 'string'
      && sameAddress(edit.account, account) && (os === null ? edit.amount === 1 : osOf(edit.amount, postFork) === os);
  });
}

// The node's confirmation of the signed native send must keep everything that
// moves funds: nonce, parties, amount, data, the exact edit set and the
// approved fees. A post-fork node may fill only transaction_fee.rpc_address
// (its own key; it routes the rpc fee and adds no debit) and may project
// content.amount as an OS number (as the pinned DACS pay-DEM rail accepts; the
// data args still bind the exact amount). A node fee view (gas_operation.fees)
// must equal the approved fees; custom charges are refused.
function confirmationMatches(validity, plan, debit, address, postFork) {
  const data = validity?.response?.data;
  const c = data?.transaction?.content;
  if (!isPlainObject(c) || data.custom_charges != null || c.custom_charges != null) return false;
  const amountOs = postFork && Number.isSafeInteger(c.amount) && c.amount >= 0 ? BigInt(c.amount) : osOf(c.amount, postFork);
  if (c.type !== 'native' || c.nonce !== plan.nonce || !sameAddress(c.from, address) || !sameAddress(c.from_ed25519_address, address)
    || !sameAddress(c.to, plan.to) || amountOs !== plan.amountOs || JSON.stringify(c.data) !== plan.data
    || !nativeEditsMatch(c.gcr_edits, plan, address, postFork)) return false;
  const rpcAddress = c.transaction_fee?.rpc_address;
  if (!feesMatch(c.transaction_fee, debit, postFork) || !(rpcAddress === null || (typeof rpcAddress === 'string' && ADDRESS.test(rpcAddress.toLowerCase())))) return false;
  if (data.gas_operation == null) return true;
  const g = data.gas_operation.fees;
  return isPlainObject(g) && osOf(g.network_fee, postFork) === debit.networkFeeOs && osOf(g.rpc_fee, postFork) === debit.rpcFeeOs
    && osOf(g.additional_fee, postFork) === debit.additionalFeeOs;
}

async function sha256HexOfText(value) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The native source's bind and signature phases take the same RPC auth headers
// the SDK sends with confirmTx/broadcastTx: this wallet's ed25519 signature over
// sha256("ed25519:<address>:<timestamp>"). It signs no transaction.
async function sourceAuthHeaders(demos, address) {
  const identity = `ed25519:${address}`, timestamp = String(Date.now());
  const signed = await demos.signMessage(await sha256HexOfText(`${identity}:${timestamp}`), { algorithm: 'ed25519' });
  const signature = String(signed?.data ?? '').toLowerCase();
  if (signed?.type !== 'ed25519' || !SIGNATURE_HEX.test(signature)) throw new EmbeddedWalletError('sdk_error', 'the wallet could not authenticate its source binding request; nothing was signed or sent');
  return { identity, timestamp, signature: signature.replace(/^0x/, '') };
}

// The source refuses auth headers stamped more than 2 minutes from its clock;
// say so plainly rather than as an unavailable binding.
function sourceRefusal(code, fallback) {
  return new EmbeddedWalletError(code, code === 'wallet_auth_stale'
    ? 'the operator refused this wallet\'s request time: this device\'s clock is more than 2 minutes off. Correct the clock and try again; nothing was signed or sent.'
    : code === 'payment_cancelled' ? 'the operator refused this transfer: it has the terms of a cancelled payment. This attempt was refused and not sent. An earlier attempt may have been sent; the purchase\'s readback shows it.'
    : fallback);
}

function base64UrlOfText(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The storage-program create the server hands over to publish a signed DACS
// listing (src/dacs/wallet-transactions.mjs buildStorageProgramCreatePayload).
// Only that exact shape is accepted, and the storage address must be the one
// SDK 4.0.16 StorageProgram.deriveStorageAddress gives for this wallet:
// "stor-" + sha256(`${deployer}:${programName}:${nonce}:${salt}`)[0..40].
async function storageCreatePlan(tx, address) {
  const content = tx?.content;
  const op = Array.isArray(content?.data) && content.data.length === 2 && content.data[0] === 'storageProgram' ? content.data[1] : null;
  if (!content || content.type !== 'storageProgram' || !isPlainObject(op) || op.operation !== 'CREATE_STORAGE_PROGRAM') {
    throw new EmbeddedWalletError('invalid_params', 'sendTransaction expects params: [storage program create transaction]');
  }
  const listing = op.data;
  const logicalAddress = op.metadata?.logicalAddress;
  if (JSON.stringify(Object.keys(op).sort()) !== JSON.stringify(STORAGE_CREATE_FIELDS) || typeof op.storageAddress !== 'string' || !STORAGE_ADDRESS.test(op.storageAddress)
    || content.to !== op.storageAddress || typeof op.programName !== 'string' || !PROGRAM_NAME.test(op.programName)
    || op.encoding !== 'json' || op.salt !== '' || op.storageLocation !== 'onchain' || JSON.stringify(op.acl) !== '{"mode":"public"}'
    || !isPlainObject(op.metadata) || Object.keys(op.metadata).length !== 1 || typeof logicalAddress !== 'string' || !logicalAddress
    || !isPlainObject(listing) || wireToOs(content.amount) !== 0n || !Number.isSafeInteger(content.nonce) || content.nonce < 1) {
    throw new EmbeddedWalletError('invalid_params', 'the storage program address, name, listing or nonce is malformed');
  }
  if (!sameAddress(content.from, address)) throw new EmbeddedWalletError('wrong_wallet', 'this transaction is for a different wallet');
  if (listing.seller?.identity?.presentedBy !== `did:demos:agent:${address.slice(2)}`) {
    throw new EmbeddedWalletError('wrong_wallet', 'this listing names a different seller wallet');
  }
  if (op.programName !== `dacs1-${base64UrlOfText(logicalAddress)}`) {
    throw new EmbeddedWalletError('invalid_params', 'the storage program name does not match the listing address');
  }
  const derived = `stor-${(await sha256HexOfText(`${address}:${op.programName}:${content.nonce}:${op.salt}`)).slice(0, 40)}`;
  if (derived !== op.storageAddress) {
    throw new EmbeddedWalletError('invalid_params', 'the storage address is not derived from this wallet, program name and nonce');
  }
  const listingBytes = new TextEncoder().encode(JSON.stringify(listing)).length;
  const storageFeeOs = BigInt(Math.max(1, Math.ceil(listingBytes / STORAGE_CHUNK_BYTES))) * OS_PER_DEM;
  const price = listing.pricing?.price;
  return {
    storageAddress: op.storageAddress,
    programName: op.programName,
    logicalAddress,
    nonce: content.nonce,
    data: JSON.stringify(content.data),
    payload: JSON.stringify(op),
    listingBytes,
    storageFeeOs,
    summary: {
      listingId: text(listing.listingId, 64),
      listingVersion: text(listing.listingVersion, 16),
      title: text(listing.offering?.title),
      price: `${text(price?.amount, 32)} ${text(price?.currency, 16)} (${text(listing.pricing?.kind, 32)})`,
      sellerName: text(listing.seller?.displayName, 100),
      sellerClaim: listing.seller.identity.presentedBy,
      endpoint: text(listing.seller?.publicEndpoint, 512),
    },
  };
}

// The SDK's own gcr_edits for an approved storage create: exactly one
// storage-program create of this payload at this address, and balance
// removals from this wallet of exactly the storage fee plus the SDK gas edit.
function storageEditsMatch(edits, plan, address) {
  if (!Array.isArray(edits)) return false;
  const creates = edits.filter((e) => e?.type === 'storageProgram');
  const balances = edits.filter((e) => e?.type === 'balance');
  const create = creates[0];
  if (creates.length !== 1 || create.target !== plan.storageAddress || create.context?.operation !== 'CREATE_STORAGE_PROGRAM'
    || !sameAddress(create.context?.sender, address) || JSON.stringify(create.context?.data?.variables) !== plan.payload) return false;
  if (balances.length !== 2 || balances.some((e) => e.operation !== 'remove' || !sameAddress(e.account, address))) return false;
  const amounts = balances.map((e) => wireToOs(e.amount));
  return amounts[0] === plan.storageFeeOs && amounts[1] === SDK_GAS_OS;
}

// Browser-local CF-1/JCS subset for the new offline request. Only bounded,
// plain JSON is accepted. Signature carriers are omitted at the artifact's
// top level for the explicitly supported SDK contentHash profile.
function anchorJson(value, depth = 0, ancestors = new Set()) {
  const invalid = () => { throw new EmbeddedWalletError('invalid_params', 'the anchor must be bounded plain canonical JSON'); };
  const string = (v, normalize) => {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) invalid();
    return JSON.stringify(normalize ? v.normalize('NFC') : v);
  };
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return string(value, true);
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || depth >= 64 || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) && !(Object.getPrototypeOf(value) === null && !array)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== 'string' || (!(array && k === 'length') && (!Object.getOwnPropertyDescriptor(value, k)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, k)))))) invalid();
  ancestors.add(value);
  let result;
  if (array) {
    if (keys.length !== value.length + 1 || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)) invalid();
    result = `[${value.map((v) => anchorJson(v, depth + 1, ancestors)).join(',')}]`;
  } else {
    result = `{${keys.sort().map((k) => `${string(k, false)}:${anchorJson(value[k], depth + 1, ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

const hasKeys = (value, keys) => isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

const ANCHOR_FIELDS = ['kind', 'profile', 'network', 'owner', 'artifactKind', 'jobId', 'logicalAddress', 'contentHash', 'envelopeHash', 'transaction'];
const ANCHOR_CONTENT_FIELDS = ['type', 'from', 'to', 'amount', 'data', 'nonce', 'timestamp', 'transaction_fee', 'network', 'chainIdentity'];
const boundedLabel = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v);

// Explicit out-of-band kind for the pinned SDK's signed payee-bound document
// (which has NO artifactType). Require the buyer-owned DEM profile and both
// original detached signatures. Never alter/inject fields into its JSON.
async function normativeAgreementMatches(r, data) {
  if (r.artifactKind !== 'Agreement' || data.payeeBoundAgreementVersion !== '1' || Object.hasOwn(data, 'artifactType') || Object.hasOwn(data, 'agreementVersion')
    || data.derivedFromPattern !== 'fixed-price' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(data.jobId ?? '') || r.logicalAddress !== `dacs3:agreement:${data.jobId}` || !Array.isArray(data.parties) || data.parties.length !== 2
    || !Array.isArray(data.signatures) || data.signatures.length !== 2) return false;
  const buyer = data.parties.filter((p) => p.role === 'buyer');
  const seller = data.parties.filter((p) => p.role === 'seller');
  const claim = /^did:demos:agent:[0-9a-f]{64}$/;
  if (buyer.length !== 1 || seller.length !== 1 || buyer[0].primaryClaim !== r.owner || !claim.test(r.owner) || !claim.test(seller[0].primaryClaim)
    || r.owner === seller[0].primaryClaim || data.terms?.price?.currency !== 'DEM'
    || !hasKeys(data.terms?.rail, ['railId', 'railVersion']) || data.terms.rail.railId !== 'demos-native:DEM' || data.terms.rail.railVersion !== 1
    || JSON.stringify(data.terms.payoutBindings) !== JSON.stringify([{ payeeAddress: `0x${seller[0].primaryClaim.slice('did:demos:agent:'.length)}`, phaseIndex: 2, railId: 'demos-native:DEM' }])) return false;
  const scope = anchorJson(Object.fromEntries(Object.entries(data).filter(([k]) => !['signature', 'signatures'].includes(k))));
  const signedBytes = new TextEncoder().encode(`dacs-payee-bound-agreement:v1:${await sha256HexOfText(scope)}`);
  for (const party of [r.owner, seller[0].primaryClaim]) {
    const sigs = data.signatures.filter((s) => s.party === party && s.algorithm === 'ed25519');
    if (sigs.length !== 1 || typeof sigs[0].value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sigs[0].value)) return false;
    try {
      const signature = Uint8Array.from(atob(sigs[0].value.replace(/-/g, '+').replace(/_/g, '/') + '=='), (c) => c.charCodeAt(0));
      if (signature.length !== 64 || btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== sigs[0].value) return false;
      const keyBytes = Uint8Array.from(party.slice('did:demos:agent:'.length).match(/../g), (b) => Number.parseInt(b, 16));
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
      if (!await crypto.subtle.verify('Ed25519', key, signature, signedBytes)) return false;
    } catch { return false; }
  }
  return true;
}

// Explicit out-of-band kind for the pinned SDK's seller-signed pay-dem
// SettlementEvidence (which also has NO artifactType). This is intentionally
// the exact success variant emitted by the seller intake/publication path, not
// a generic opaque no-artifactType escape hatch.
async function normativeSettlementMatches(r, data) {
  const claim = /^did:demos:agent:[0-9a-f]{64}$/;
  if (r.artifactKind !== 'SettlementEvidence' || Object.hasOwn(data, 'artifactType')
    || !hasKeys(data, ['evidenceVersion', 'jobId', 'phase', 'outcome', 'paymentTxRefs', 'paymentAmount', 'settlementFinality', 'observedAt', 'signature'])
    || data.evidenceVersion !== '1' || data.phase !== 'pay-dem' || data.outcome !== 'success'
    || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(data.jobId ?? '')
    || r.logicalAddress !== `dacs4:payment:${data.jobId}:demos-native%3ADEM:2`
    || !Array.isArray(data.paymentTxRefs) || data.paymentTxRefs.length !== 1
    || !hasKeys(data.paymentTxRefs[0], ['kind', 'txHash', 'blockNumber']) || data.paymentTxRefs[0].kind !== 'demos'
    || !HASH.test(data.paymentTxRefs[0].txHash) || !Number.isSafeInteger(data.paymentTxRefs[0].blockNumber) || data.paymentTxRefs[0].blockNumber < 0
    || !hasKeys(data.paymentAmount, ['amount', 'currency']) || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(data.paymentAmount.amount ?? '')
    || data.paymentAmount.amount === '0' || data.paymentAmount.currency !== 'DEM'
    || !hasKeys(data.settlementFinality, ['model', 'finalityObservedAt']) || data.settlementFinality.model !== 'bft-final'
    || !Number.isSafeInteger(data.observedAt) || data.observedAt < 0 || data.settlementFinality.finalityObservedAt !== data.observedAt
    || !hasKeys(data.signature, ['algorithm', 'signer', 'value']) || data.signature.algorithm !== 'ed25519'
    || data.signature.signer !== r.owner || !claim.test(r.owner) || !/^[A-Za-z0-9_-]{86}$/.test(data.signature.value ?? '')) return false;
  try {
    const signature = Uint8Array.from(atob(data.signature.value.replace(/-/g, '+').replace(/_/g, '/') + '=='), (c) => c.charCodeAt(0));
    if (signature.length !== 64 || btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== data.signature.value) return false;
    const scope = anchorJson(Object.fromEntries(Object.entries(data).filter(([k]) => !['signature', 'signatures'].includes(k))));
    const signedBytes = new TextEncoder().encode(`dacs-evidence:v1:${await sha256HexOfText(scope)}`);
    const keyBytes = Uint8Array.from(r.owner.slice('did:demos:agent:'.length).match(/../g), (b) => Number.parseInt(b, 16));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, signature, signedBytes);
  } catch { return false; }
}

// The SDK storage-program delivery payload has no normative artifactType.
// `Deliverable` is an out-of-band transport admission bound in CREATE metadata;
// the report bytes remain exactly the SDK candidate supplied by the seller.
function nativeDeliverableMatches(r, data, metadata, transport) {
  const binding=metadata?.deliveryBinding, policy=transport.deliveryPublication;
  return r.artifactKind==='Deliverable' && transport.devnetDelivery && !Object.hasOwn(data,'artifactType')
    && hasKeys(data,['reportVersion','kind','jobId','agreementHash','listing','title','settlementId','body'])
    && data.reportVersion==='1' && data.kind==='dacs-chatgpt-plugin/fixture-test-report'
    && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(data.jobId ?? '') && HASH.test(data.agreementHash ?? '')
    && r.jobId===data.jobId && r.logicalAddress===`dacs4:deliverable:${data.jobId}`
    && hasKeys(binding,['version','profile','jobId','phase','phaseIndex','listing','agreementHash','fulfilmentId','purchaseAmount','payloadHash'])
    && binding.version==='1' && binding.profile===DEVNET_DELIVERY_POLICY && binding.jobId===data.jobId
    && binding.phase===policy.phase && binding.phaseIndex===policy.phaseIndex
    && anchorJson(binding.listing)===anchorJson(data.listing) && binding.agreementHash===data.agreementHash
    && typeof binding.fulfilmentId==='string' && binding.fulfilmentId.length>0 && binding.fulfilmentId.length<=128
    && hasKeys(binding.purchaseAmount,['amount','currency']) && binding.purchaseAmount.currency==='DEM'
    && /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(binding.purchaseAmount.amount ?? '') && binding.purchaseAmount.amount!=='0'
    && binding.payloadHash===r.contentHash && Array.isArray(data.body) && data.body.every((line)=>typeof line==='string')
    && typeof data.title==='string' && typeof data.settlementId==='string';
}

async function devnetDemoArtifactMatches(r, data, metadata, transport) {
  const policy=transport.demoArtifactPublication, writer=`did:demos:agent:${r.owner.slice('did:demos:agent:'.length)}`;
  const binding=metadata?.artifactBinding;
  if(!transport.devnetDemo || !policy.artifactKinds.includes(r.artifactKind)
    || !hasKeys(binding,['version','policy','authority','artifactKind','jobId','logicalAddress','writer'])
    || binding.version!=='1' || binding.policy!==DEVNET_DEMO_ARTIFACT_POLICY || binding.authority!==policy.authority
    || binding.artifactKind!==r.artifactKind || binding.logicalAddress!==r.logicalAddress || binding.writer!==writer
    || binding.jobId!==(data.jobId ?? `listing:${data.listingId}`) || r.jobId!==binding.jobId) return false;
  if(r.artifactKind==='Deliverable') {
    const db=metadata.deliveryBinding;
    return !Object.hasOwn(data,'artifactType') && data.reportVersion==='1'
      && data.kind==='dacs-chatgpt-plugin/devnet-purchased-report' && data.jobId===r.jobId && data.producer===writer
      && r.logicalAddress===`dacs4:deliverable:${data.jobId}` && hasKeys(data.content,['mediaType','text'])
      && data.content.mediaType==='text/plain; charset=utf-8' && typeof data.content.text==='string' && data.content.text.length>0 && data.content.text.length<=16384
      && anchorJson(db)===anchorJson({version:'1',profile:DEVNET_DELIVERY_POLICY,jobId:data.jobId,phase:transport.deliveryPublication.phase,
        phaseIndex:transport.deliveryPublication.phaseIndex,listing:data.listing,agreementHash:data.agreementHash,fulfilmentId:db?.fulfilmentId,
        purchaseAmount:db?.purchaseAmount,payloadHash:r.contentHash}) && typeof db?.fulfilmentId==='string' && db.fulfilmentId.length>0 && db.fulfilmentId.length<=128
      && db.purchaseAmount?.currency==='DEM' && typeof db.purchaseAmount?.amount==='string';
  }
  if(r.artifactKind==='SettlementEvidence' && (!hasKeys(data,['evidenceVersion','jobId','phase','outcome','dacsSdkAuditSourceHash','deliverableContentHash','deliverableAnchor','observedAt','signature'])
    ||data.evidenceVersion!=='1'||data.phase!=='deliver-storage-program'||data.outcome!=='success'||r.logicalAddress!==`dacs4:evidence:${r.jobId}`
    ||!HASH.test(data.dacsSdkAuditSourceHash??'')||!HASH.test(data.deliverableContentHash??'')||!hasKeys(data.deliverableAnchor,['kind','locator'])||data.deliverableAnchor.kind!=='storage-program'||data.deliverableAnchor.locator!==`dacs4:deliverable:${r.jobId}`
    ||!Number.isSafeInteger(data.observedAt)||data.observedAt<0))return false;
  const signature=data.signature;
  const separator=r.artifactKind==='Listing'?'dacs-listing:v1:':r.artifactKind==='CompositeVerificationRecord'?'dacs-composite:v1:':r.artifactKind==='SettlementEvidence'?'dacs-evidence:v1:':'dacs-finality-commitment:v1:';
  if(!hasKeys(signature,['algorithm','signer','value']) || signature.algorithm!=='ed25519' || signature.signer!==writer || !/^[A-Za-z0-9_-]{86}$/.test(signature.value ?? '')) return false;
  if(r.artifactKind==='Listing' && (data.seller?.identity?.presentedBy!==writer || data.listingVersion<1)) return false;
  if(r.artifactKind==='CompositeVerificationRecord' && (data.recordVersion!=='1' || data.jobId!==r.jobId || typeof data.evaluatedParty!=='string')) return false;
  if(r.artifactKind==='FinalityCommitmentRecord' && (data.finalityCommitmentVersion!=='1' || data.jobId!==r.jobId || data.pattern!=='fixed-price')) return false;
  try {
    const scope=anchorJson(Object.fromEntries(Object.entries(data).filter(([k])=>!['signature','signatures'].includes(k))));
    const message=new TextEncoder().encode(`${separator}${await sha256HexOfText(scope)}`);
    const sig=Uint8Array.from(atob(signature.value.replace(/-/g,'+').replace(/_/g,'/')+'=='),c=>c.charCodeAt(0));
    const keyBytes=Uint8Array.from(writer.slice('did:demos:agent:'.length).match(/../g),b=>Number.parseInt(b,16));
    const key=await crypto.subtle.importKey('raw',keyBytes,{name:'Ed25519'},false,['verify']);
    return sig.length===64 && await crypto.subtle.verify('Ed25519',key,sig,message);
  } catch { return false; }
}

async function storageAnchorPlan(request, address, transport) {
  const url = new URL(transport.rpcUrl);
  // Use the existing relay that converts retryable SDK HTTP failures to 500.
  // A direct/public RPC URL is not an authorized route for this offline kind.
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/portal/api/wallet-rpc') {
    throw new EmbeddedWalletError('unsupported', 'the SR-2 anchor requires the literal loopback wallet relay');
  }
  const serialized = anchorJson(request);
  if (new TextEncoder().encode(serialized).length > 96 * 1024) throw new EmbeddedWalletError('invalid_params', 'the anchor request exceeds the offline bound');
  const r = JSON.parse(serialized);
  const tx = r.transaction;
  const c = tx?.content;
  const op = c?.data?.[1];
  const explicitKind = op?.metadata && Object.hasOwn(op.metadata, 'artifactKind');
  const contentKeys = c && Object.hasOwn(c, 'from_ed25519_address') ? [...ANCHOR_CONTENT_FIELDS, 'from_ed25519_address'] : ANCHOR_CONTENT_FIELDS;
  if (!hasKeys(r, ANCHOR_FIELDS) || r.kind !== DACS_STORAGE_ANCHOR_KIND || r.profile !== TRANSPORT_PROFILE || r.network !== transport.network
    || !hasKeys(tx, ['content', 'signature', 'hash', 'status', 'blockNumber']) || tx.signature !== null || tx.hash !== '' || tx.status !== '' || tx.blockNumber !== null
    || !hasKeys(c, contentKeys) || c.type !== 'storageProgram' || !Array.isArray(c.data) || c.data.length !== 2 || c.data[0] !== 'storageProgram'
    || !hasKeys(op, STORAGE_CREATE_FIELDS) || op.operation !== 'CREATE_STORAGE_PROGRAM' || op.encoding !== 'json' || op.salt !== '' || op.storageLocation !== 'onchain'
    || !hasKeys(op.acl, ['mode']) || op.acl.mode !== 'public' || !hasKeys(op.metadata, ['logicalAddress', 'contentHash', 'envelopeHash', ...(explicitKind ? ['artifactKind'] : [])])
    || !boundedLabel(r.logicalAddress, 256) || !boundedLabel(r.artifactKind, 80) || !boundedLabel(r.jobId, 256) || !isPlainObject(op.data)
    || (r.artifactKind === 'SettlementEvidence' && Object.hasOwn(op.data, 'artifactType'))
    || (Object.hasOwn(op.data, 'artifactType') ? op.data.artifactType !== r.artifactKind : !explicitKind)
    || (explicitKind && op.metadata.artifactKind !== r.artifactKind) || op.data.jobId !== r.jobId || !HASH.test(r.contentHash) || !HASH.test(r.envelopeHash)
    || op.metadata.logicalAddress !== r.logicalAddress || op.metadata.contentHash !== r.contentHash || op.metadata.envelopeHash !== r.envelopeHash
    || op.programName !== r.logicalAddress.replace(/:/g, '%3A') || op.programName.length > 256
    || !STORAGE_ADDRESS.test(op.storageAddress) || c.to !== op.storageAddress || wireToOs(c.amount) !== 0n
    || !Number.isSafeInteger(c.nonce) || c.nonce < 1 || !Number.isSafeInteger(c.timestamp) || c.timestamp < 0
    || c.network !== transport.network || c.chainIdentity !== DACS_STORAGE_ANCHOR_CHAIN_IDENTITY
    || !hasKeys(c.transaction_fee, ['network_fee', 'rpc_fee', 'additional_fee', 'rpc_address']) || c.transaction_fee.rpc_address !== null
    || ['network_fee', 'rpc_fee', 'additional_fee'].some((k) => wireToOs(c.transaction_fee[k]) !== 0n)) {
    throw new EmbeddedWalletError('invalid_params', 'the explicit anchor scope, immutable CREATE or network is malformed');
  }
  if (r.owner !== `did:demos:agent:${address.slice(2)}` || c.from !== address || (Object.hasOwn(c, 'from_ed25519_address') && c.from_ed25519_address !== address)) {
    throw new EmbeddedWalletError('wrong_wallet', 'the independently declared anchor owner is not this wallet');
  }
  if (!Object.hasOwn(op.data, 'artifactType')
    && !await normativeAgreementMatches(r, op.data)
    && !await normativeSettlementMatches(r, op.data)) throw new EmbeddedWalletError('invalid_params', 'explicit Agreement/SettlementEvidence kind, profile bindings or exact original signatures differ');
  const envelope = anchorJson(op.data);
  const scope = anchorJson(Object.fromEntries(Object.entries(op.data).filter(([k]) => !['signature', 'signatures'].includes(k))));
  if (await sha256HexOfText(envelope) !== r.envelopeHash || await sha256HexOfText(scope) !== r.contentHash) {
    throw new EmbeddedWalletError('invalid_params', 'the artifact envelope or SDK signed-scope hash differs');
  }
  const derived = `stor-${(await sha256HexOfText(`${address}:${op.programName}:${c.nonce}:`)).slice(0, 40)}`;
  if (derived !== op.storageAddress) throw new EmbeddedWalletError('invalid_params', 'the native anchor address differs from its owner, encoded name or nonce');
  const storageBytes = new TextEncoder().encode(envelope).length;
  // The unchanged relay has a 64 KiB request cap. Signing duplicates the
  // artifact in its storage edit, so keep ample space for the SDK envelope.
  if (storageBytes > 24 * 1024) throw new EmbeddedWalletError('invalid_params', 'the artifact exceeds the offline wallet relay storage bound');
  return { ...r, transaction: tx, storageAddress: c.to, programName: op.programName, nonce: c.nonce,
    storageBytes, storageFeeOs: BigInt(Math.max(1, Math.ceil(storageBytes / STORAGE_CHUNK_BYTES))) * OS_PER_DEM,
    exactCreate: JSON.stringify(op), exactStorageBytes: JSON.stringify(op.data), data: JSON.stringify(c.data) };
}

async function devnetAgreementAnchorPlan(request, address, transport) {
  const url = new URL(transport.rpcUrl);
  // Use the existing relay that converts retryable SDK HTTP failures to 500.
  // A direct/public RPC URL is not an authorized route for this offline kind.
  if (url.origin !== globalThis.location?.origin || url.pathname !== '/portal/api/devnet-native-wallet-rpc') {
    throw new EmbeddedWalletError('unsupported', 'the SR-2 anchor requires the literal loopback wallet relay');
  }
  const serialized = anchorJson(request);
  if (new TextEncoder().encode(serialized).length > 96 * 1024) throw new EmbeddedWalletError('invalid_params', 'the anchor request exceeds the offline bound');
  const r = JSON.parse(serialized);
  const tx = r.transaction;
  const c = tx?.content;
  const op = c?.data?.[1];
  const explicitKind = op?.metadata && Object.hasOwn(op.metadata, 'artifactKind');
  const contentKeys = c && Object.hasOwn(c, 'from_ed25519_address') ? [...ANCHOR_CONTENT_FIELDS, 'from_ed25519_address'] : ANCHOR_CONTENT_FIELDS;
  // Demo transport admission: the four demo artifact kinds (as before this
  // lane) plus exactly one new shape, the seller's demo-kind delivery
  // SettlementEvidence, only when the demo publication declares it. Every
  // other request keeps its pre-existing routing below.
  const generic=transport.devnetDemo && (DEVNET_DEMO_ARTIFACT_TYPES.includes(r.artifactKind)
    || (r.artifactKind==='SettlementEvidence' && r.kind===DEVNET_DEMO_STORAGE_KIND && transport.demoArtifactPublication.artifactKinds.includes('SettlementEvidence')));
  const expectedKind=generic ? DEVNET_DEMO_STORAGE_KIND : r.artifactKind==='SettlementEvidence' ? DEVNET_SETTLEMENT_STORAGE_KIND : r.artifactKind==='Deliverable' ? DEVNET_DELIVERY_STORAGE_KIND : DEVNET_AGREEMENT_STORAGE_KIND;
  if (!hasKeys(r, ANCHOR_FIELDS) || r.kind !== expectedKind || (r.artifactKind==='SettlementEvidence' && !transport.devnetSettlement) || r.profile !== DEVNET_AGREEMENT_TRANSPORT_PROFILE || r.network !== transport.network
    || !hasKeys(tx, ['content', 'signature', 'hash', 'status', 'blockNumber']) || tx.signature !== null || tx.hash !== '' || tx.status !== '' || tx.blockNumber !== null
    || !hasKeys(c, contentKeys) || c.type !== 'storageProgram' || !Array.isArray(c.data) || c.data.length !== 2 || c.data[0] !== 'storageProgram'
    || !hasKeys(op, STORAGE_CREATE_FIELDS) || op.operation !== 'CREATE_STORAGE_PROGRAM' || op.encoding !== 'json' || op.salt !== '' || op.storageLocation !== 'onchain'
    || !hasKeys(op.acl, ['mode']) || op.acl.mode !== 'public' || !hasKeys(op.metadata, ['logicalAddress', 'contentHash', 'envelopeHash', 'artifactKind','networkBinding',...(generic?['artifactBinding',...(r.artifactKind==='Deliverable'?['deliveryBinding']:[])]:r.artifactKind==='Deliverable'?['deliveryBinding']:[])])
    || !boundedLabel(r.logicalAddress, 256) || !boundedLabel(r.artifactKind, 80) || !boundedLabel(r.jobId, 256) || !isPlainObject(op.data)
    || (Object.hasOwn(op.data, 'artifactType') ? op.data.artifactType !== r.artifactKind : !explicitKind)
    || (explicitKind && op.metadata.artifactKind !== r.artifactKind) || (!generic && op.data.jobId !== r.jobId) || !HASH.test(r.contentHash) || !HASH.test(r.envelopeHash)
    || op.metadata.logicalAddress !== r.logicalAddress || op.metadata.contentHash !== r.contentHash || op.metadata.envelopeHash !== r.envelopeHash
    || op.programName !== r.logicalAddress.replace(/:/g, '%3A') || op.programName.length > 256
    || !STORAGE_ADDRESS.test(op.storageAddress) || c.to !== op.storageAddress || wireToOs(c.amount) !== 0n
    || !Number.isSafeInteger(c.nonce) || c.nonce < 1 || !Number.isSafeInteger(c.timestamp) || c.timestamp < 0
    || c.network !== transport.network || c.chainIdentity !== transport.transportBinding.chainIdentity || anchorJson(op.metadata.networkBinding) !== anchorJson(transport.transportBinding)
    || !hasKeys(c.transaction_fee, ['network_fee', 'rpc_fee', 'additional_fee', 'rpc_address']) || c.transaction_fee.rpc_address !== null
    || ['network_fee', 'rpc_fee', 'additional_fee'].some((k) => wireToOs(c.transaction_fee[k]) !== 0n)) {
    throw new EmbeddedWalletError('invalid_params', 'the explicit anchor scope, immutable CREATE or network is malformed');
  }
  if (r.owner !== `did:demos:agent:${address.slice(2)}` || c.from !== address || (Object.hasOwn(c, 'from_ed25519_address') && c.from_ed25519_address !== address)) {
    throw new EmbeddedWalletError('wrong_wallet', 'the independently declared anchor owner is not this wallet');
  }
  if (!(await normativeAgreementMatches(r, op.data) || (transport.devnetSettlement && await normativeSettlementMatches(r,op.data)) || nativeDeliverableMatches(r,op.data,op.metadata,transport) || await devnetDemoArtifactMatches(r,op.data,op.metadata,transport))) throw new EmbeddedWalletError('invalid_params', 'explicit Agreement/SettlementEvidence/demo artifact kind, bindings or original bytes differ');
  const envelope = anchorJson(op.data);
  const scope = anchorJson(Object.fromEntries(Object.entries(op.data).filter(([k]) => !['signature', 'signatures'].includes(k))));
  if (await sha256HexOfText(envelope) !== r.envelopeHash || await sha256HexOfText(scope) !== r.contentHash) {
    throw new EmbeddedWalletError('invalid_params', 'the artifact envelope or SDK signed-scope hash differs');
  }
  const derived = `stor-${(await sha256HexOfText(`${address}:${op.programName}:${c.nonce}:`)).slice(0, 40)}`;
  if (derived !== op.storageAddress) throw new EmbeddedWalletError('invalid_params', 'the native anchor address differs from its owner, encoded name or nonce');
  const storageBytes = new TextEncoder().encode(envelope).length;
  // The unchanged relay has a 64 KiB request cap. Signing duplicates the
  // artifact in its storage edit, so keep ample space for the SDK envelope.
  if (storageBytes > 24 * 1024) throw new EmbeddedWalletError('invalid_params', 'the artifact exceeds the offline wallet relay storage bound');
  return { ...r, transaction: tx, storageAddress: c.to, programName: op.programName, nonce: c.nonce,
    storageBytes, storageFeeOs: BigInt(Math.max(1, Math.ceil(storageBytes / STORAGE_CHUNK_BYTES))) * OS_PER_DEM,
    exactCreate: JSON.stringify(op), exactStorageBytes: JSON.stringify(op.data), data: JSON.stringify(c.data) };
}


export function createDevnetAgreementWalletTransport(profile) {
  const candidate={profile:profile?.profile,network:profile?.network,rpcUrl:profile?.rpcUrl,bindingUrl:profile?.bindingUrl,transportBinding:profile?.transportBinding,...(profile?.settlementPublication?{settlementPublication:profile.settlementPublication}:{}),...(profile?.deliveryPublication?{deliveryPublication:profile.deliveryPublication}:{}),...(profile?.demoArtifactPublication?{demoArtifactPublication:profile.demoArtifactPublication}:{})};
  if(!readTransport(candidate)?.devnetAgreement) throw new EmbeddedWalletError('held_for_review','no exact same-origin Agreement source capability is available');
  return Object.freeze(candidate);
}

// SDK 4.0.16 exact storage edit projection, including rollback flags, nonce,
// txhash carriers, duplicated metadata and the complete edit field sets.
const anchorOs = (value, postFork, executed) => executed && postFork && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : osOf(value, postFork);
const anchorInteger = (value, expected, executed) => value === expected || (executed && value === String(expected));
function anchorFeesMatch(fees, debit, postFork, executed) {
  return hasKeys(fees, ['additional_fee', 'network_fee', 'rpc_address', 'rpc_fee'])
    && anchorOs(fees.network_fee, postFork, executed) === debit.networkFeeOs && anchorOs(fees.rpc_fee, postFork, executed) === debit.rpcFeeOs
    && anchorOs(fees.additional_fee, postFork, executed) === 0n;
}
function anchorEditsMatch(edits, plan, address, postFork, txHash = '') {
  if (!Array.isArray(edits) || edits.length !== 4) return false;
  const expected = [['balance', 'remove', plan.storageFeeOs], ['storageProgram'], ['balance', 'remove', SDK_GAS_OS], ['nonce', 'add', null]];
  return edits.every((e, i) => {
    if (!isPlainObject(e) || e.type !== expected[i][0] || e.isRollback !== false || !(e.txhash === '' || (txHash && e.txhash === txHash))) return false;
    if (i === 1) return hasKeys(e, ['type', 'target', 'isRollback', 'txhash', 'context']) && e.target === plan.storageAddress
      && hasKeys(e.context, ['operation', 'sender', 'data']) && e.context.operation === 'CREATE_STORAGE_PROGRAM' && e.context.sender === address
      && hasKeys(e.context.data, ['variables', 'metadata']) && JSON.stringify(e.context.data.variables) === plan.exactCreate
      && JSON.stringify(e.context.data.metadata) === JSON.stringify(plan.transaction.content.data[1].metadata);
    return hasKeys(e, ['type', 'operation', 'isRollback', 'account', 'txhash', 'amount']) && e.operation === expected[i][1] && e.account === address
      && (i === 3 ? anchorInteger(e.amount, 1, Boolean(txHash)) : anchorOs(e.amount, postFork, Boolean(txHash)) === expected[i][2]);
  });
}

function anchorContentMatches(c, plan, debit, address, postFork, txHash = '') {
  if (!hasKeys(c, [...ANCHOR_CONTENT_FIELDS, 'from_ed25519_address', 'gcr_edits'])) return false;
  const initial = plan.transaction.content;
  return c.type === 'storageProgram' && c.from === address && c.from_ed25519_address === address && c.to === plan.storageAddress
    && anchorInteger(c.nonce, plan.nonce, Boolean(txHash)) && anchorInteger(c.timestamp, initial.timestamp, Boolean(txHash)) && anchorOs(c.amount, postFork, Boolean(txHash)) === 0n && JSON.stringify(c.data) === plan.data
    && c.network === initial.network && c.chainIdentity === initial.chainIdentity && anchorEditsMatch(c.gcr_edits, plan, address, postFork, txHash)
    && anchorFeesMatch(c.transaction_fee, debit, postFork, Boolean(txHash)) && c.transaction_fee.rpc_address === null;
}

async function anchorSignatureMatches(signed, address) {
  if (!hasKeys(signed, ['content', 'signature', 'hash', 'status', 'blockNumber']) || signed.status !== '' || signed.blockNumber !== null
    || !hasKeys(signed.signature, ['type', 'data']) || !HASH.test(signed?.hash ?? '') || signed.signature?.type !== 'ed25519' || !SIGNATURE_HEX.test(signed.signature.data ?? '')
    || await sha256HexOfText(JSON.stringify(signed.content)) !== signed.hash) return false;
  try {
    const bytes = (v) => Uint8Array.from(v.replace(/^0x/, '').match(/../g), (b) => Number.parseInt(b, 16));
    const key = await crypto.subtle.importKey('raw', bytes(address), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes(signed.signature.data), new TextEncoder().encode(signed.hash));
  } catch { return false; }
}

// Proof URL checks as SDK 4.0.16 applies them (formats.web2 prefixes; the
// github handle is proof.split("/")[3]), plus the handle shape the server uses.
function proofHandle(context, proofUrl) {
  if (typeof proofUrl !== 'string' || !PROOF_PREFIXES[context].some((prefix) => proofUrl.startsWith(`${prefix}/`))) {
    throw new EmbeddedWalletError('invalid_params', `expects params: [public ${context} proof URL]`);
  }
  const handle = proofUrl.split('/')[3];
  if (!HANDLE.test(handle ?? '')) throw new EmbeddedWalletError('invalid_params', 'the proof URL does not name a valid handle');
  return handle;
}

export function createSdkWalletSession({ DemosCtor, IdentitiesCtor, approve, transactionTransport, validateMnemonic, anchorJournal } = {}) {
  if (typeof DemosCtor !== 'function') throw new TypeError('createSdkWalletSession requires the Demos SDK class as DemosCtor');
  const transport = readTransport(transactionTransport);
  // Explicit caller-owned atomic journal. RAM implementations are offline
  // evidence only; production persistence/recovery is a separate integration.
  const journal = anchorJournal && ['get', 'put', 'withWalletLock'].every((k) => typeof anchorJournal[k] === 'function') ? anchorJournal : null;

  // Live authority: the SDK instance holding the keypair, and the phrase kept
  // only for the explicit local backup view. Both are dropped by lock().
  let live = null;
  let generation = 0;
  let busy = false;

  const publicView = () => (live
    ? {
        address: live.address,
        publicKey: live.address.slice(2),
        network: transport ? transport.network : EMBEDDED_NETWORK,
        evidenceMode: !transport ? EMBEDDED_EVIDENCE_MODE : transport.held ? HELD_EVIDENCE_MODE : transport.devnetNative ? DEVNET_NATIVE_EVIDENCE_MODE : TRANSPORT_EVIDENCE_MODE,
      }
    : null);

  function discard() {
    generation += 1;
    const previous = live;
    live = null;
    if (previous) {
      previous.mnemonic = null;
      try {
        previous.demos.disconnect();
      } catch {
        // The instance is unreachable either way once the reference is gone.
      }
    }
  }

  async function open(mnemonic) {
    const demos = new DemosCtor();
    await demos.connectWallet(mnemonic, { algorithm: 'ed25519' });
    const address = String(demos.getAddress()).toLowerCase();
    if (!ADDRESS.test(address)) {
      demos.disconnect();
      throw new EmbeddedWalletError('sdk_error', 'Demos SDK produced an unexpected address format');
    }
    discard();
    live = { demos, address, mnemonic };
    return publicView();
  }

  async function exclusive(task) {
    if (busy) throw new EmbeddedWalletError('busy', 'another wallet operation is in progress');
    busy = true;
    try {
      return await task();
    } finally {
      busy = false;
    }
  }

  async function approved(request) {
    if (typeof approve !== 'function') throw new EmbeddedWalletError('not_configured', 'no approval handler is configured for this wallet');
    const startedAt = generation;
    const answer = await approve(request);
    if (startedAt !== generation || !live) throw new EmbeddedWalletError('locked', 'the wallet was locked or replaced while waiting for approval');
    if (answer !== true) throw new EmbeddedWalletError('user_rejected', 'the request was not approved');
  }

  async function sign(params) {
    const message = Array.isArray(params) ? params[0] : undefined;
    if (!Array.isArray(params) || params.length !== 1 || typeof message !== 'string') {
      throw new EmbeddedWalletError('invalid_params', 'sign expects params: [message string]');
    }
    const { address } = live;
    await approved({ method: 'sign', address, message });
    const signed = await live.demos.signMessage(message, { algorithm: 'ed25519' });
    const signature = String(signed?.data ?? '').toLowerCase();
    if (signed?.type !== 'ed25519' || !SIGNATURE_HEX.test(signature)) {
      throw new EmbeddedWalletError('sdk_error', 'Demos SDK produced an unexpected signature format');
    }
    // Bare 128-hex of the 64-byte Ed25519 signature over the exact UTF-8 bytes.
    return { signature: signature.replace(/^0x/, ''), type: 'ed25519', address };
  }

  async function web2ProofPayload(params) {
    if (typeof IdentitiesCtor !== 'function') throw new EmbeddedWalletError('not_configured', 'Demos Identities is not available in this runtime');
    if (Array.isArray(params) && params.length) throw new EmbeddedWalletError('invalid_params', 'getWeb2IdentityProofPayload takes no parameters');
    const { address } = live;
    await approved({ method: 'getWeb2IdentityProofPayload', address, purpose: 'Create the Demos web2 identity proof text (a local signature over "dw2p") for you to publish yourself. Nothing is sent.' });
    // SDK 4.0.16 Identities.createWeb2ProofPayload signs locally; no RPC.
    const proof = await new IdentitiesCtor().createWeb2ProofPayload(live.demos);
    if (typeof proof !== 'string' || !proof.startsWith('demos:dw2p:ed25519:')) {
      throw new EmbeddedWalletError('sdk_error', 'Demos SDK produced an unexpected proof format');
    }
    return proof;
  }

  // ---------------- writes (only with a valid transport) ----------------

  // The unlocked session a write started on; anything else is a lock.
  function stillCurrent(started) {
    if (started !== generation || !live) throw new EmbeddedWalletError('locked', 'the wallet was locked or replaced; nothing was sent');
  }

  // Public SDK seam: Demos.connect(rpc_url) probes the URL (GET) and then
  // routes every SDK node call there.
  async function connectRpc(demos, started) {
    if (demos.rpc_url !== transport.rpcUrl) {
      try {
        await demos.connect(transport.rpcUrl);
      } catch {
        stillCurrent(started);
        throw new EmbeddedWalletError('upstream_unavailable', 'the configured Demos node could not be reached; nothing was signed');
      }
    }
    stillCurrent(started);
    if (demos.rpc_url !== transport.rpcUrl) throw new EmbeddedWalletError('upstream_unavailable', 'the configured Demos node could not be reached; nothing was signed');
  }

  // A read through the SDK's public nodeCall. A failed read comes back from
  // the SDK as an error envelope, never as a usable value.
  async function nodeRead(demos, started, message, data, accept) {
    let value;
    try {
      value = await demos.nodeCall(message, data);
    } catch {
      value = undefined;
    }
    stillCurrent(started);
    if (!accept(value)) throw new EmbeddedWalletError('upstream_unavailable', `the configured Demos node did not answer ${message}; nothing was signed`);
    return value;
  }

  async function nextNonce(demos, started, address) {
    const current = await nodeRead(demos, started, 'getAddressNonce', { address }, (v) => Number.isSafeInteger(v) && v >= 0);
    return current + 1;
  }

  async function approvedWrite(started, request) {
    if (typeof approve !== 'function') throw new EmbeddedWalletError('not_configured', 'no approval handler is configured for this wallet');
    const answer = await approve(request);
    stillCurrent(started);
    if (answer !== true) throw new EmbeddedWalletError('user_rejected', 'the request was not approved; nothing was signed');
  }

  // SDK confirm (node validation; nothing is executed). A thrown "[Confirm]"
  // error is the node's refusal; anything else means it could not be asked.
  async function confirmed(run, started) {
    let validity;
    try {
      validity = await run();
    } catch (error) {
      if (/^\[Confirm\]/.test(String(error?.message))) throw new EmbeddedWalletError('confirm_rejected', 'the node refused to validate this transaction; it was not broadcast');
      stillCurrent(started);
      throw new EmbeddedWalletError('upstream_unavailable', 'the transaction could not be validated by the configured node; it was not broadcast');
    }
    const tx = validity?.response?.data?.transaction;
    if (validity?.result !== 200 || validity?.response?.data?.valid !== true || !tx || typeof tx.hash !== 'string' || !HASH.test(tx.hash.toLowerCase().replace(/^0x/, ''))) {
      throw new EmbeddedWalletError('confirm_rejected', 'the node did not validate this transaction; it was not broadcast');
    }
    return validity;
  }

  // Exactly one SDK broadcast. From here on nothing is retried and a lock no
  // longer changes the answer: the request may already have reached the node.
  async function broadcastOnce(demos, validity, nonce) {
    const hash = validity.response.data.transaction.hash.toLowerCase().replace(/^0x/, '');
    let res;
    try {
      res = await demos.broadcast(validity);
    } catch {
      res = null;
    }
    const status = res && typeof res === 'object' ? res.result : null;
    if (status === 200) return { hash, nonce, status: 'broadcast_accepted', ...(transport.devnetNative && res.writeProof?.disposition==='included' && res.writeProof.receipt?.hash===hash ? {writeProof:structuredClone(res.writeProof)} : {}), evidenceMode: transport.devnetNative ? DEVNET_NATIVE_EVIDENCE_MODE : TRANSPORT_EVIDENCE_MODE };
    // The node's own JSON answer with a 4xx result. The SDK reports transport
    // failures (including relay refusals) as result 500: unknown.
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      throw Object.assign(new EmbeddedWalletError('broadcast_rejected', 'the node answered the broadcast with a refusal; check the status with the server before doing anything else'), { data: { hash, nonce } });
    }
    throw Object.assign(new EmbeddedWalletError('outcome_unknown', 'the broadcast may or may not have reached the node. It is not retried; the server checks the chain for this transaction'), { data: { hash, nonce } });
  }

  async function sendTransaction(params) {
    if (!Array.isArray(params) || params.length !== 1) throw new EmbeddedWalletError('invalid_params', 'sendTransaction expects params: [transaction]');
    const tx = params[0];
    const sourceCreate=transport.devnetAgreement && (tx?.kind===DEVNET_AGREEMENT_STORAGE_KIND || (transport.devnetSettlement && tx?.kind===DEVNET_SETTLEMENT_STORAGE_KIND) || (transport.devnetDelivery && tx?.kind===DEVNET_DELIVERY_STORAGE_KIND) || (transport.devnetDemo && tx?.kind===DEVNET_DEMO_STORAGE_KIND));
    if (transport.devnetNative && !sourceCreate && (tx?.kind === DACS_STORAGE_ANCHOR_KIND || tx?.content?.type !== 'native')) throw new EmbeddedWalletError('held_for_review','the native-only source capability does not enable this CREATE, listing or identity write');
    if (tx?.kind === DACS_STORAGE_ANCHOR_KIND || sourceCreate) return storageProgramAnchor(tx);
    if (tx?.content?.type === 'storageProgram') return storageProgramCreate(tx);
    const { demos, address } = live;
    const started = generation;
    const plan = nativeSendPlan(tx, address);
    let networkFence=null, lease=null;
    const bindingCall = async (body) => {
      const auth=['bind','signature'].includes(body.phase) ? await sourceAuthHeaders(demos,address) : null; if(auth) stillCurrent(started);
      const r=await fetch(transport.bindingUrl,{ method:'POST',headers:{ 'content-type':'application/json',...auth },credentials:'same-origin',body:JSON.stringify({ address,...body }) });
      const result=await r.json(); stillCurrent(started);
      if(!r.ok) throw sourceRefusal(result.error ?? 'network_binding_unavailable','the independently supplied network binding is unavailable; nothing is retried');
      return result;
    };
    if(transport.devnetNative) {
      const bound=await bindingCall({ phase:'bind' });
      if(bound.pending) throw Object.assign(new EmbeddedWalletError('outcome_unknown','an issued native transfer is retained; read it back, never resend'),{ data:{ hash:bound.pending.hash,nonce:bound.pending.nonce } });
      networkFence=bound.binding;
      if(networkFence?.bindingVersion !== 'dacs-demos-network-binding/v1' || networkFence.network !== transport.network || !HASH.test(networkFence.chainIdentity ?? '')) throw new EmbeddedWalletError('network_binding_unavailable','the actual network-binding capability did not return an authenticated source pin');
    }
    try {
    await connectRpc(demos, started);
    if(transport.devnetNative && await nextNonce(demos,started,address) !== plan.nonce) throw new EmbeddedWalletError('stale_plan','the actual native wallet nonce differs; nothing was signed');
    const fee = await nodeRead(demos, started, 'getNetworkParameters', {}, (v) => typeof v?.networkFee === 'number' && typeof v?.rpcFee === 'number');
    const debit = nativeDebit(plan, fee);
    if (!debit) throw new EmbeddedWalletError('unsupported', 'the node reported fees this wallet cannot show exactly before signing; nothing was signed');
    await approvedWrite(started, {
      method: 'sendTransaction',
      address,
      purpose: `Send ${formatDem(plan.amountOs)} DEM from this embedded wallet to ${plan.to}. Total debit ${formatDem(debit.totalOs)} DEM: the amount, the SDK's ${formatDem(SDK_GAS_OS)} DEM gas and the node fees (${transport.devnetNative ? 'explicit independently supplied transport pin; single node, not finality' : 'SIMULATED loopback fixture'}).`,
      content: {
        action: 'native DEM transfer',
        from: address,
        to: plan.to,
        amountOs: plan.amountOs.toString(),
        amountDem: formatDem(plan.amountOs),
        nonce: plan.nonce,
        debit: debitView(debit),
        network: transport.network,
        evidence: transport.devnetNative ? 'Explicit source-supplied network pin; native signature is NOT chain/purchase-bound; single-node readback is not finality.' : EVIDENCE_LABEL,
        ...(transport.devnetNative ? { networkBinding:{ network:networkFence.network,chainIdentity:networkFence.chainIdentity,pinVersion:networkFence.pinVersion,endpoint:networkFence.endpoint,transportAuthority:networkFence.transportAuthority,connectionId:networkFence.connectionId } } : {}),
        sending: SENDING_NOTE,
      },
    });
    if(transport.devnetNative) {
      // The lease names its transfer and the digest of its exact payload, so
      // the operator's source refuses it, before anything is signed, if a
      // payment with its terms was cancelled meanwhile, and holds the lease to
      // it. A payload without its own time names none: Demos.sign would stamp
      // a new one.
      const prepared=Number.isSafeInteger(tx.content.timestamp) && tx.content.timestamp > 0;
      lease=await bindingCall({ phase:'signature',binding:networkFence,...(prepared ? { transfer:{ nonce:plan.nonce,to:plan.to,amountOs:plan.amountOs.toString(),payloadDigest:await nativePayloadDigest(tx.content) } } : {}) });
      if(demos.rpc_url !== transport.rpcUrl || lease.binding?.network !== networkFence.network || lease.binding?.chainIdentity !== networkFence.chainIdentity) throw new EmbeddedWalletError('network_binding_unavailable','the approved native binding differs; nothing was signed');
      if(await nextNonce(demos,started,address) !== plan.nonce) throw new EmbeddedWalletError('stale_plan','the native nonce changed during approval; nothing was signed');
    }
    // SDK sign of the exact server payload with its exact nonce; the SDK fills
    // from/from_ed25519_address, gcr_edits and the node-reported fee.
    let signed;
    try {
      signed = await demos.sign(structuredClone(tx), { nonce: plan.nonce });
    } catch {
      stillCurrent(started);
      throw new EmbeddedWalletError('sdk_error', 'the Demos SDK could not sign this transaction; nothing was sent');
    }
    stillCurrent(started);
    const c = signed?.content;
    const postFork = typeof c?.amount === 'string';
    if (!c || c.type !== 'native' || c.nonce !== plan.nonce || !sameAddress(c.to, plan.to) || osOf(c.amount, postFork) !== plan.amountOs
      || JSON.stringify(c.data) !== plan.data || !sameAddress(c.from, address) || !sameAddress(c.from_ed25519_address, address)
      || c.custom_charges != null || !nativeEditsMatch(c.gcr_edits, plan, address, postFork)
      || !feesMatch(c.transaction_fee, debit, postFork) || c.transaction_fee.rpc_address !== null
      || typeof signed.hash !== 'string' || !HASH.test(signed.hash) || signed.signature?.type !== 'ed25519') {
      throw new EmbeddedWalletError('payload_mismatch', 'the signed transaction differs from what was approved; nothing was sent');
    }
    if(transport.devnetNative && !await anchorSignatureMatches(signed,address)) throw new EmbeddedWalletError('payload_mismatch','the SDK native signature/hash does not authenticate the original bytes');
    const originalSignedBytes=transport.devnetNative ? JSON.stringify(signed) : null;
    const validity = await confirmed(() => demos.confirm(signed), started);
    if (validity.response.data.transaction.hash.toLowerCase().replace(/^0x/, '') !== signed.hash) {
      throw new EmbeddedWalletError('confirm_rejected', 'the node validated a different transaction; it was not broadcast');
    }
    if (!confirmationMatches(validity, plan, debit, address, postFork)) {
      throw new EmbeddedWalletError('confirm_rejected', 'the node confirmed a different amount, recipient, balance edit set or fee than was approved; it was not broadcast');
    }
    stillCurrent(started);
    if(transport.devnetNative) {
      if(demos.rpc_url !== transport.rpcUrl || JSON.stringify(validity.response.data.transaction) !== originalSignedBytes) throw new EmbeddedWalletError('confirm_rejected','the native capability never changes the original signed payload bytes');
      const fresh=await bindingCall({ phase:'broadcast',leaseId:lease.leaseId,hash:signed.hash });
      for(const k of ['network','chainIdentity','bindingId','endpoint','transportAuthority','connectionId']) if(fresh.binding?.[k] !== lease.binding?.[k]) throw new EmbeddedWalletError('network_binding_unavailable','the fenced transport changed before native broadcast');
    }
    return await broadcastOnce(demos, validity, plan.nonce);
    } finally {
      if(lease?.leaseId) { try { await bindingCall({ phase:'release',leaseId:lease.leaseId }); } catch { /* no retry: app/owner close must release a lost lease */ } }
    }
  }

  async function storageProgramAnchor(request) {
    if (!journal) throw new EmbeddedWalletError('not_configured', 'an explicit atomic anchor journal is required');
    const { demos, address } = live;
    const started = generation;
    const plan = await (transport.devnetAgreement ? devnetAgreementAnchorPlan : storageAnchorPlan)(request,address,transport);
    let binding,lease;
    const sourcePhase=async(body)=>{const auth=['bind','signature'].includes(body.phase)?await sourceAuthHeaders(demos,address):null;if(auth)stillCurrent(started);
      const r=await fetch(transport.bindingUrl,{method:'POST',headers:{'content-type':'application/json',...auth},body:JSON.stringify({...body,address}),credentials:'same-origin',redirect:'error'});const v=await r.json();if(!r.ok || v.error)throw sourceRefusal(v.error ?? 'network_binding_required','fresh source network binding is unavailable');return v;};
    if(transport.devnetAgreement){const bound=await sourcePhase({phase:'bind'});if(bound.pending)throw new EmbeddedWalletError('outcome_unknown','an issued source transaction requires readback, never resend');binding=bound.binding;
      if(binding.chainIdentity!==transport.transportBinding.chainIdentity || binding.bindingId!==transport.transportBinding.bindingId)throw new EmbeddedWalletError('network_binding_required','fresh binding differs from signed source terms');}
    const lane = JSON.stringify([transport.network, transport.devnetAgreement ? transport.transportBinding.chainIdentity : DACS_STORAGE_ANCHOR_CHAIN_IDENTITY, address]);
    try { return await journal.withWalletLock(lane, async () => {
      const previous = await journal.get(lane);
      if (previous && previous.stage !== 'broadcast-accepted') throw Object.assign(new EmbeddedWalletError('outcome_unknown', 'an issued anchor owns this wallet nonce lane; no other payload may be issued'), { data: { hash: previous.hash, nonce: previous.nonce } });
      stillCurrent(started);
      await connectRpc(demos, started);
      const network = await nodeRead(demos, started, 'getNetworkInfo', {}, (v) => (transport.devnetAgreement || (v?.simulated === true && v?.chainIdentity === DACS_STORAGE_ANCHOR_CHAIN_IDENTITY)) && typeof v?.forks?.osDenomination?.activated === 'boolean');
      const postFork = network.forks.osDenomination.activated;
      if (await nextNonce(demos, started, address) !== plan.nonce) throw new EmbeddedWalletError('stale_plan', 'the wallet nonce differs from the approved CREATE coordinate');
      const fee = await nodeRead(demos, started, 'getNetworkParameters', {}, (v) => typeof v?.networkFee === 'number' && typeof v?.rpcFee === 'number');
      const debit = nativeDebit({ amountOs: plan.storageFeeOs }, fee);
      if (!debit) throw new EmbeddedWalletError('unsupported', 'the anchor fees cannot be shown exactly before signing');
      await approvedWrite(started, { method: 'sendTransaction', address,
        purpose: `Create immutable ${plan.artifactKind} for job ${plan.jobId}. Total debit ${formatDem(debit.totalOs)} DEM (${transport.devnetAgreement ? 'explicit independently supplied source pin; single node, finality not established' : 'SIMULATED fixture; no real consensus'}).`,
        content: { kind: plan.kind, action: 'immutable DACS storage anchor CREATE', artifactKind: plan.artifactKind, jobId: plan.jobId,
          owner: plan.owner, wallet: address, logicalAddress: plan.logicalAddress, storageAddress: plan.storageAddress, programName: plan.programName,
          contentHash: plan.contentHash, contentHashProfile: 'SDK CF-1 signed scope (top-level signature/signatures omitted)', envelopeHash: plan.envelopeHash,
          ...(plan.artifactKind==='Deliverable'?{deliveryBinding:plan.transaction.content.data[1].metadata.deliveryBinding}:{}),
          storageBytes: plan.storageBytes, exactStorageBytes: plan.exactStorageBytes, exactCreate: plan.exactCreate,
          nonce: plan.nonce, timestamp: plan.transaction.content.timestamp, debit: { storageFeeDem: formatDem(plan.storageFeeOs), ...debitView(debit), sellerAmountDem: '0',
            note: 'Complete debit: storage fee, SDK gas, network fee, RPC fee and zero additional fee. Exact CREATE bytes, signed fields and every edit are checked before one broadcast.' },
          network: transport.network, chainIdentity: transport.devnetAgreement ? transport.transportBinding.chainIdentity : DACS_STORAGE_ANCHOR_CHAIN_IDENTITY, ...(transport.devnetAgreement ? {networkBinding:transport.transportBinding}:{}), evidence: transport.devnetAgreement ? 'Explicit TEST/source pin; not independent review or consensus finality' : EVIDENCE_LABEL, sending: SENDING_NOTE } });
      if (demos.rpc_url !== transport.rpcUrl) throw new EmbeddedWalletError('payload_mismatch', 'the approved anchor RPC route changed; nothing was signed');
      const recheckedNetwork = await nodeRead(demos, started, 'getNetworkInfo', {}, (v) => isPlainObject(v));
      if ((!transport.devnetAgreement && (recheckedNetwork.simulated !== true || recheckedNetwork.chainIdentity !== DACS_STORAGE_ANCHOR_CHAIN_IDENTITY)) || recheckedNetwork.forks?.osDenomination?.activated !== postFork) {
        throw new EmbeddedWalletError('payload_mismatch', 'the approved fixture network or denomination changed; nothing was signed');
      }
      if (await nextNonce(demos, started, address) !== plan.nonce) throw new EmbeddedWalletError('stale_plan', 'the wallet nonce changed during approval; nothing was signed');
      if(transport.devnetAgreement){lease=await sourcePhase({phase:'signature',binding});binding=lease.binding;}
      let signed;
      try { signed = await demos.sign(structuredClone(plan.transaction), { nonce: plan.nonce }); }
      catch { stillCurrent(started); throw new EmbeddedWalletError('sdk_error', 'the SDK could not sign the anchor; nothing was sent'); }
      stillCurrent(started);
      if (demos.rpc_url !== transport.rpcUrl || !anchorContentMatches(signed?.content, plan, debit, address, postFork) || !await anchorSignatureMatches(signed, address)) {
        throw new EmbeddedWalletError('payload_mismatch', 'the signed anchor differs from the approved scope, CREATE, network or debit; nothing was sent');
      }
      const validity = await confirmed(() => demos.confirm(signed), started);
      const data = validity.response.data;
      const c = data.transaction.content;
      const gas = data.gas_operation?.fees;
      if (demos.rpc_url !== transport.rpcUrl || !storageConfirmationShapeMatches(data) || data.transaction.status !== signed.status || data.transaction.blockNumber !== signed.blockNumber
        || data.transaction.hash !== signed.hash || JSON.stringify(data.transaction.signature) !== JSON.stringify(signed.signature)
        || !anchorContentMatches(c, plan, debit, address, postFork, signed.hash)
        || (data.gas_operation != null && (anchorOs(gas.network_fee, postFork, true) !== debit.networkFeeOs
          || anchorOs(gas.rpc_fee, postFork, true) !== debit.rpcFeeOs || anchorOs(gas.additional_fee, postFork, true) !== 0n))) {
        throw new EmbeddedWalletError('confirm_rejected', 'the node changed the approved anchor or debit; it was not broadcast');
      }
      const confirmedNetwork = await nodeRead(demos, started, 'getNetworkInfo', {}, (v) => isPlainObject(v));
      if ((!transport.devnetAgreement && (confirmedNetwork.simulated !== true || confirmedNetwork.chainIdentity !== DACS_STORAGE_ANCHOR_CHAIN_IDENTITY)) || confirmedNetwork.forks?.osDenomination?.activated !== postFork) {
        throw new EmbeddedWalletError('confirm_rejected', 'the fixture network changed during confirmation; it was not broadcast');
      }
      if(transport.devnetAgreement){if(JSON.stringify(data.transaction)!==JSON.stringify(signed))throw new EmbeddedWalletError('confirm_rejected','the original signed CREATE bytes changed');await sourcePhase({phase:'broadcast',leaseId:lease.leaseId,hash:signed.hash});}
      stillCurrent(started);
      // A failed/ambiguous persistence operation prevents sending. Preserve
      // the issued lane even when the broadcast answer is lost or refused.
      const issued = { lane, stage: 'broadcast-started', nonce: plan.nonce, hash: signed.hash, signedTransaction: structuredClone(signed), approved: { ...structuredClone(plan), storageFeeOs: plan.storageFeeOs.toString() } };
      await journal.put(lane, issued);
      const retained = await journal.get(lane);
      if (JSON.stringify(retained) !== JSON.stringify(issued)) throw new EmbeddedWalletError('journal_error', 'the issued anchor was not retained exactly; nothing was sent');
      stillCurrent(started);
      const result = await broadcastOnce(demos, validity, plan.nonce);
      try {
        await journal.put(lane, { ...issued, stage: 'broadcast-accepted' });
      } catch {
        throw Object.assign(new EmbeddedWalletError('outcome_unknown', 'the sent anchor outcome was not durably recorded; the nonce lane remains fenced'), { data: { hash: signed.hash, nonce: plan.nonce } });
      }
      return result;
    }); } finally {if(lease)await sourcePhase({phase:'release',leaseId:lease.leaseId});}
  }

  // Publication of the seller's already signed DACS listing: the server's
  // exact storage-program create, with its pre-derived address and nonce.
  async function storageProgramCreate(tx) {
    const { demos, address } = live;
    const started = generation;
    const plan = await storageCreatePlan(tx, address);
    stillCurrent(started);
    await connectRpc(demos, started);
    const fee = await nodeRead(demos, started, 'getNetworkParameters', {}, (v) => typeof v?.networkFee === 'number' && typeof v?.rpcFee === 'number');
    const s = plan.summary;
    await approvedWrite(started, {
      method: 'sendTransaction',
      address,
      purpose: `Publish your signed DACS listing "${s.title}" as a storage program at ${plan.storageAddress} from this embedded wallet (SIMULATED loopback fixture).`,
      content: {
        action: 'publish DACS listing (storage program create)',
        from: address,
        storageAddress: plan.storageAddress,
        programName: plan.programName,
        logicalAddress: plan.logicalAddress,
        listing: { ...s },
        listingBytes: plan.listingBytes,
        storageFeeDem: formatDem(plan.storageFeeOs),
        sdkGasDem: formatDem(SDK_GAS_OS),
        nonce: plan.nonce,
        networkFee: fee.networkFee,
        rpcFee: fee.rpcFee,
        network: transport.network,
        evidence: EVIDENCE_LABEL,
        sending: SENDING_NOTE,
      },
    });
    // SDK sign of the exact server payload with its exact nonce; the SDK fills
    // the sender, gcr_edits (storage create + fee burn + gas) and node fees.
    let signed;
    try {
      signed = await demos.sign(structuredClone(tx), { nonce: plan.nonce });
    } catch {
      stillCurrent(started);
      throw new EmbeddedWalletError('sdk_error', 'the Demos SDK could not sign this transaction; nothing was sent');
    }
    stillCurrent(started);
    const c = signed?.content;
    const fees = c?.transaction_fee ?? {};
    if (!c || c.type !== 'storageProgram' || c.nonce !== plan.nonce || c.to !== plan.storageAddress || wireToOs(c.amount) !== 0n
      || JSON.stringify(c.data) !== plan.data || !sameAddress(c.from_ed25519_address, address) || !storageEditsMatch(c.gcr_edits, plan, address)
      || wireToOs(fees.network_fee) !== wireToOs(fee.networkFee) || wireToOs(fees.rpc_fee) !== wireToOs(fee.rpcFee)
      || typeof signed.hash !== 'string' || !HASH.test(signed.hash) || signed.signature?.type !== 'ed25519') {
      throw new EmbeddedWalletError('payload_mismatch', 'the signed transaction differs from what was approved; nothing was sent');
    }
    const validity = await confirmed(() => demos.confirm(signed), started);
    if (validity.response.data.transaction.hash.toLowerCase().replace(/^0x/, '') !== signed.hash) {
      throw new EmbeddedWalletError('confirm_rejected', 'the node validated a different transaction; it was not broadcast');
    }
    stillCurrent(started);
    return broadcastOnce(demos, validity, plan.nonce);
  }

  async function identityWrite(method, params) {
    if (typeof IdentitiesCtor !== 'function') throw new EmbeddedWalletError('not_configured', 'Demos Identities is not available in this runtime');
    if (!Array.isArray(params) || params.length !== 1) throw new EmbeddedWalletError('invalid_params', `${method} expects one parameter`);
    const { demos, address } = live;
    const started = generation;
    const remove = method === 'removeWeb2Identity';
    let context;
    let proofUrl = null;
    let handle;
    if (remove) {
      const target = params[0];
      context = target?.context;
      handle = target?.username;
      if (!['github', 'twitter'].includes(context) || typeof handle !== 'string' || !HANDLE.test(handle)) {
        throw new EmbeddedWalletError('invalid_params', 'removeWeb2Identity expects params: [{context: "github" | "twitter", username}]');
      }
    } else {
      context = method === 'addGithubIdentity' ? 'github' : 'twitter';
      proofUrl = params[0];
      handle = proofHandle(context, proofUrl);
    }
    await connectRpc(demos, started);

    // The facts SDK addGithubIdentity/addTwitterIdentity read before building
    // the payload, read first so the person approves them.
    let username = handle;
    let userId = null;
    if (!remove && context === 'github') {
      if (!transport.resolveGithubUser) throw new EmbeddedWalletError('not_configured', 'GitHub user lookup is not configured for this wallet');
      let user;
      try {
        user = await transport.resolveGithubUser(handle);
      } catch {
        user = null;
      }
      stillCurrent(started);
      if (typeof user?.login !== 'string' || !HANDLE.test(user.login) || !Number.isSafeInteger(user?.id)) throw new EmbeddedWalletError('upstream_unavailable', 'the GitHub user could not be read; nothing was signed');
      username = user.login;
      userId = user.id;
    } else if (!remove) {
      const data = await nodeRead(demos, started, 'getTweet', { tweetUrl: proofUrl }, (v) => v?.success === true && typeof v?.tweet?.username === 'string' && v.tweet.userId != null);
      username = data.tweet.username;
      userId = data.tweet.userId;
    }
    if (!remove && username.toLowerCase() !== handle.toLowerCase()) {
      throw new EmbeddedWalletError('identity_mismatch', `the proof belongs to ${username}, not ${handle}; nothing was signed`);
    }
    const nonce = await nextNonce(demos, started, address);
    await approvedWrite(started, {
      method,
      address,
      purpose: remove
        ? `Remove the ${context} identity ${handle} from this embedded wallet (SIMULATED loopback fixture).`
        : `Link the ${context} identity ${username} to this embedded wallet using your public proof (SIMULATED loopback fixture).`,
      content: {
        action: remove ? 'remove web2 identity' : 'add web2 identity',
        wallet: address,
        context,
        username,
        ...(remove ? {} : { userId, proofUrl }),
        nonce,
        network: transport.network,
        evidence: EVIDENCE_LABEL,
        sending: SENDING_NOTE,
      },
    });
    const identities = new IdentitiesCtor();
    // SDK 4.0.16: inferWeb2Identity / removeWeb2Identity build the identity
    // transaction, sign it and run confirm (node validation); no broadcast.
    // The add payload is exactly what addGithubIdentity/addTwitterIdentity pass.
    const validity = await confirmed(() => (remove
      ? identities.removeWeb2Identity(demos, { context, username: handle }, { nonce })
      : identities.inferWeb2Identity(demos, { context, proof: proofUrl, username, userId, referralCode: undefined }, { nonce })), started);
    const c = validity.response.data.transaction.content;
    const op = Array.isArray(c?.data) ? c.data[1] : null;
    const payload = op?.payload;
    if (c?.type !== 'identity' || c.nonce !== nonce || !sameAddress(c.from_ed25519_address, address) || !sameAddress(c.to, address)
      || op?.context !== 'web2' || op?.method !== (remove ? 'web2_identity_remove' : 'web2_identity_assign')
      || payload?.context !== context || payload?.username !== (remove ? handle : username) || (!remove && payload?.proof !== proofUrl)) {
      throw new EmbeddedWalletError('payload_mismatch', 'the validated identity transaction differs from what was approved; it was not broadcast');
    }
    stillCurrent(started);
    return broadcastOnce(demos, validity, nonce);
  }

  async function write(method, params) {
    const run = () => method === 'sendTransaction' ? sendTransaction(params) : identityWrite(method, params);
    // The native source transport consumes its injected durable public host
    // journal. It must not reuse or reinterpret the synthetic SR-2 lane.
    if(transport.devnetNative && !transport.devnetAgreement) return run();
    if (!journal || (method === 'sendTransaction' && [DACS_STORAGE_ANCHOR_KIND,DEVNET_AGREEMENT_STORAGE_KIND,DEVNET_SETTLEMENT_STORAGE_KIND,DEVNET_DELIVERY_STORAGE_KIND,DEVNET_DEMO_STORAGE_KIND].includes(params?.[0]?.kind))) return run();
    const started = generation;
    const lane = JSON.stringify([transport.network, transport.devnetAgreement ? transport.transportBinding.chainIdentity : DACS_STORAGE_ANCHOR_CHAIN_IDENTITY, live.address]);
    return journal.withWalletLock(lane, async () => {
      stillCurrent(started);
      const previous = await journal.get(lane);
      stillCurrent(started);
      if (previous && previous.stage !== 'broadcast-accepted') throw Object.assign(new EmbeddedWalletError('outcome_unknown', 'an issued anchor owns this wallet nonce lane; no other payload may be issued'), { data: { hash: previous.hash, nonce: previous.nonce } });
      return run();
    });
  }

  return {
    async create({ strength = 256 } = {}) {
      if (strength !== 128 && strength !== 256) throw new EmbeddedWalletError('invalid_params', 'strength must be 128 or 256');
      return exclusive(async () => {
        const mnemonic = new DemosCtor().newMnemonic(strength);
        return open(mnemonic);
      });
    },

    async importMnemonic(mnemonic) {
      return exclusive(async () => {
        if (typeof validateMnemonic !== 'function') {
          throw new EmbeddedWalletError('not_configured', 'recovery phrase validation is not configured; pass validateMnemonic from demos-runtime.mjs');
        }
        const normalized = normalizeMnemonic(mnemonic);
        if (!validateMnemonic(normalized)) throw new EmbeddedWalletError('invalid_mnemonic', 'this is not a valid Demos recovery phrase');
        return open(normalized);
      });
    },

    getPublicAccount() {
      return publicView();
    },

    // Public: which writes this session can perform (null: none).
    getWriteProfile() {
      if (!transport) return null;
      if (transport.held) {
        return { profile: HELD_TRANSPORT_PROFILE, network: transport.network, evidenceMode: HELD_EVIDENCE_MODE, methods: [], transactionKinds: [], held: true, gates: [...HELD_GATES] };
      }
      if(transport.devnetAgreement) return {profile:DEVNET_AGREEMENT_TRANSPORT_PROFILE,network:transport.network,evidenceMode:DEVNET_NATIVE_EVIDENCE_MODE,methods:['sendTransaction','readNativeTransfer'],transactionKinds:['native-send',...(journal?[DEVNET_AGREEMENT_STORAGE_KIND,...(transport.devnetSettlement?[DEVNET_SETTLEMENT_STORAGE_KIND]:[]),...(transport.devnetDelivery?[DEVNET_DELIVERY_STORAGE_KIND]:[]),...(transport.devnetDemo?[DEVNET_DEMO_STORAGE_KIND]:[])]:[])],transportBinding:transport.transportBinding,...(transport.devnetSettlement?{settlementPublication:transport.settlementPublication}:{}),...(transport.devnetDelivery?{deliveryPublication:transport.deliveryPublication}:{}),...(transport.devnetDemo?{demoArtifactPublication:transport.demoArtifactPublication}:{}),nativeOnly:false};
      if(transport.devnetNative) return { profile:DEVNET_NATIVE_TRANSPORT_PROFILE,network:transport.network,evidenceMode:DEVNET_NATIVE_EVIDENCE_MODE,methods:['sendTransaction','readNativeTransfer'],transactionKinds:['native-send'],nativeOnly:true };
      return { profile: TRANSPORT_PROFILE, network: transport.network, evidenceMode: TRANSPORT_EVIDENCE_MODE, methods: [...WRITES], transactionKinds: [...TRANSACTION_KINDS, ...(journal ? [DACS_STORAGE_ANCHOR_KIND] : [])] };
    },

    // LOCAL UI ONLY: explicit backup display/encryption by the user. Never
    // forward the result to request(), MCP, HTTP, logs or parent messages.
    exportMnemonicForUser() {
      if (!live) throw new EmbeddedWalletError('locked', 'the wallet is locked');
      return live.mnemonic;
    },

    async request({ method, params } = {}) {
      try {
        if (typeof method !== 'string') throw new EmbeddedWalletError('invalid_params', 'method must be a string');
        const isWrite = TRANSACTION_METHODS.includes(method) || IDENTITY_WRITES.includes(method);
        if (transport?.held && isWrite) throw new EmbeddedWalletError('held_for_review', HELD_MESSAGE);
        const writable = Boolean(transport) && !transport.held && WRITES.includes(method) && (!transport.devnetNative || method === 'sendTransaction');
        if (!writable && isWrite) {
          if (transport) throw new EmbeddedWalletError('unsupported', `${method} is not supported by the embedded wallet`);
          throw new EmbeddedWalletError(
            transactionTransport ? 'unsupported' : 'not_configured',
            `${method} is not available in the embedded wallet: Demos SDK 4.0.16 sends it through its own network client, so a loopback-only path is not proven. Use the Demos wallet extension.`,
          );
        }
        if (!live) throw new EmbeddedWalletError('locked', 'the wallet is locked');
        if(method === 'readNativeTransfer' && transport?.devnetNative) {
          if(!Array.isArray(params) || params.length !== 1 || !HASH.test(params[0]?.hash ?? '')) throw new EmbeddedWalletError('invalid_params','readNativeTransfer expects the retained public native hash');
          const r=await fetch(transport.bindingUrl,{ method:'POST',headers:{ 'content-type':'application/json' },credentials:'same-origin',body:JSON.stringify({ phase:'readback',address:live.address,hash:params[0].hash }) });
          const result=await r.json(); if(!r.ok)throw new EmbeddedWalletError(result.error ?? 'readback_unavailable','native readback is unavailable; no resend is allowed');
          return ok(result);
        }
        if (writable) return ok(await exclusive(() => write(method, params)));
        if (method === 'connect') return ok(live.address);
        if (method === 'sign') return ok(await sign(params));
        if (method === 'getWeb2IdentityProofPayload') return ok(await web2ProofPayload(params));
        throw new EmbeddedWalletError('unsupported', `${method} is not supported by the embedded wallet`);
      } catch (error) {
        // A write that may have reached the node keeps its hash and nonce.
        if (error instanceof EmbeddedWalletError) return error.data ? { success: false, data: error.data, error: { code: error.code, message: error.message } } : fail(error.code, error.message);
        // SDK/approval errors are not echoed: they could carry request detail.
        return fail('internal_error', 'the embedded wallet could not complete the request');
      }
    },

    lock() {
      discard();
    },

    isLocked() {
      return live === null;
    },
  };
}
