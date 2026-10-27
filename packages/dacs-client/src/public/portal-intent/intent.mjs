// Bounded purchase intent for the embedded wallet's one Start approval
// (DACS_INTENT_APPROVAL=on; default off). Pure and DOM-free so the wallet gate
// (gate.mjs) and Node tests share it.
//
// The buyer approves an intent once: the Listing, seller, price, deliverable,
// delivery deadline term, network, the app session key and its window, the
// signatures and wallet writes it covers, a fee ceiling and an expiry. After
// that the wallet signs nothing the server hands it as bytes. For each later
// step it takes the server's structured draft (identity bundle, seller session
// delegation, Agreement draft, broker challenge, Agreement CREATE), rebuilds
// what it may sign from the intent, fixed protocol rules and the pinned
// Listing it hash-checked itself, and signs only those bytes, with the same
// separators and hashes as the server and the DACS SDK. Any mismatch throws
// IntentMismatch before anything is signed.
//
// Signed formats and hash domains are unchanged: these functions only
// re-derive what the server already asks the wallet to sign today.

export const INTENT_VERSION = 'dacs-chatgpt-plugin/start-intent/v1';
// Longest life of one approved intent; the server's own record expires too.
export const INTENT_MAX_TTL_MS = 10 * 60 * 1000;
const OS_PER_DEM = 1_000_000_000n;
// Per wallet write: storage fee, SDK gas and node fees together (the wallet fee
// policy bound of at most 4 DEM in fees per CREATE).
export const FEE_CEILING_PER_WRITE_OS = 4n * OS_PER_DEM;
// How far a server timestamp may lie ahead of this browser's clock.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAYMENT_PHASE_INDEX = 2;

export const FIXTURE_PROFILE = 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1';
export const OFFLINE_PROFILE = 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1';
export const DEVNET_SOURCE = 'devnet-agreement-transport/v1';
export const DEM_DELIVERY_CONTEXT = 'dacs-chatgpt-plugin/dem-delivery-context/v1';
const VET_NOT_PERFORMED = 'dacs-chatgpt-plugin/vet-not-performed/v1';
const PRESENTATION_SEPARATOR = 'dacs-bundle-presentation:v1:';
const AGREEMENT_SEPARATOR = 'dacs-payee-bound-agreement:v1:';
const FIXTURE_WRITE_PREFIX = 'dacs-chatgpt-plugin/fixture-sr2-write/v1:';
const SESSION_DELEGATION_PREFIX = 'dacs-chatgpt-plugin:seller-session-delegation:v1:';
export const DEVNET_CREATE_KIND = 'devnet-agreement-storage-create';
const BROKER_PURPOSE = 'offline-agreement-browser-session';
const BROKER_STATEMENT = 'Authenticate this linked wallet for one exact SIMULATED Agreement CREATE in this operation. This is not payment approval. The packaged wallet must separately show and approve the complete CREATE debit. No payment or completion is enabled.';
const BROKER_AUTHORIZATION = 'one immutable Agreement CREATE; no payment or completion';
const DEM_RAIL = 'demos-native:DEM';

const DID_PREFIX = 'did:demos:agent:';
const DID = /^did:demos:agent:[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const JOB = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const OS = /^[1-9][0-9]*$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
// Values the one dialog shows: one line each, no control, format or bidi
// characters, so server text cannot add or reorder lines.
const LISTING_ID = /^(?!\.+$)[A-Za-z0-9._~-]{1,128}$/; // the directory's Listing id
const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{1,64}$/;
const PURCHASE_ID = /^pur_[A-Za-z0-9_-]{1,64}$/;
const NETWORK = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// An absolute URI (urn: or https: in practice) in printable ASCII without
// spaces: the dialog wraps long values, and every line it shows has a space.
const SCHEMA_URL = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:[\x21-\x7e]{1,256}$/;
const SUPPORTED_PIPELINE = ['negotiate-fixed-price', 'commit-payee-bound-agreement', 'pay-dem', 'deliver-storage-program'];
const DELEGATION_KEYS = ['version', 'kind', 'buyer', 'sessionPublicKey', 'seller', 'listingPin', 'jobId', 'notBefore', 'expiresAt'];
const DELEGATION_MAX_LIFETIME_MS = DAY_MS; // seller-session-delegation.mjs bound

// Signature steps and writes, by the purchase profile the terms fix.
export const STEPS = Object.freeze({
  identity: 'your identity presentation (proves this wallet is the buyer)',
  delegation: 'the app-session authorization for this seller, Listing and job',
  agreement: 'the DACS Agreement (job, Listing, price, payee and parties checked)',
  anchorAuthorization: 'the authorization to anchor that exact Agreement on the fixture substrate',
  brokerSession: 'the browser session for this one Agreement record',
  agreementCreate: 'one wallet write: the Agreement record (storage CREATE)',
});
// Each planned wallet write, by step, as the dialog names it.
export const WRITES = Object.freeze({
  agreementCreate: 'the Agreement record',
});

export class IntentMismatch extends Error {
  constructor(field, reason) {
    super(`Nothing was signed: ${reason}`);
    this.name = 'IntentMismatch';
    this.code = 'intent_mismatch';
    this.field = field;
  }
}
const refuse = (field, reason) => { throw new IntentMismatch(field, reason); };

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (v, keys) => plain(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
const safeInt = (v) => Number.isSafeInteger(v) && !Object.is(v, -0);
const didOf = (address) => `${DID_PREFIX}${address.slice(2)}`;
const addressOf = (did) => `0x${did.slice(DID_PREFIX.length)}`;

// DACS CF-1 / RFC 8785 canonical JSON, as the SDK's canonicalize: object
// member names sorted by UTF-16 code units and kept byte-exact, string values
// NFC-normalised, only safe-integer-range finite numbers, plain JSON only.
export function canonicalJson(value, depth = 0, seen = new Set()) {
  const bad = () => refuse('canonical', 'the server sent data that has no canonical form');
  const str = (s, normalize) => {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)) bad();
    return JSON.stringify(normalize ? s.normalize('NFC') : s);
  };
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return str(value, true);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) bad();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || depth >= 64 || seen.has(value)) bad();
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) bad();
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== 'string')) bad();
  seen.add(value);
  let out;
  if (array) {
    if (keys.length !== value.length + 1) bad();
    out = `[${Array.from({ length: value.length }, (_, i) => (Object.hasOwn(value, i) ? canonicalJson(value[i], depth + 1, seen) : bad())).join(',')}]`;
  } else {
    out = `{${keys.filter((k) => value[k] !== undefined).sort().map((k) => `${str(k, false)}:${canonicalJson(value[k], depth + 1, seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return out;
}

const withoutKeys = (value, keys) => Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
const deepFreeze = (value) => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
const copy = (value) => JSON.parse(canonicalJson(value));

export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// DACS-2 composite address segment encoding (SDK encodeAddressSegment).
const segment = (value) => value.replace(/[:?&=%]/g, (c) => ({ ':': '%3A', '?': '%3F', '&': '%26', '=': '%3D', '%': '%25' })[c]);
const compositeAddress = (jobId, party) => `dacs2:composite:${segment(jobId)}:${segment(party)}`;
// The fixed not-performed Vet reference (purchase-protocol.mjs vetNotPerformedRef).
async function vetPlaceholder(jobId, party) {
  return { anchor: { kind: 'storage-program', locator: compositeAddress(jobId, party) }, contentHash: await sha256Hex(canonicalJson({ marker: VET_NOT_PERFORMED, jobId, party })) };
}

function decimalToOs(amount) {
  if (typeof amount !== 'string' || !DECIMAL.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > 9) return null;
  return BigInt(whole) * OS_PER_DEM + BigInt(fraction.padEnd(9, '0'));
}

export function formatDem(os) {
  const whole = os / OS_PER_DEM;
  const fraction = (os % OS_PER_DEM).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

// ---------------------------------------------------------------------------
// The intent
// ---------------------------------------------------------------------------

// What the profile in the signed purchase terms needs, or null when this
// purchase is not one the intent covers (it then keeps the per-step flow).
// An Agreement context (operator or DEM-delivery) is not covered: its Vet
// references name records the wallet can neither verify nor rebuild itself.
export function intentProfile(terms) {
  const p = terms?.protocol;
  if (!p || !JOB.test(p.jobId ?? '') || p.agreementContext !== undefined) return null;
  const delegation = Boolean(p.sellerTransport?.delegation);
  if (p.profile === FIXTURE_PROFILE && !p.transportBinding && terms.domain?.mode === 'simulated-fixture') {
    return { kind: 'fixture', delegation, steps: ['identity', ...(delegation ? ['delegation'] : []), 'agreement', 'anchorAuthorization'], writes: [] };
  }
  if (p.profile === OFFLINE_PROFILE && p.transportBinding?.source === DEVNET_SOURCE && terms.domain?.mode === 'public-chain-read') {
    return { kind: 'devnet', delegation, steps: ['identity', ...(delegation ? ['delegation'] : []), 'agreement', 'brokerSession', 'agreementCreate'], writes: ['agreementCreate'] };
  }
  return null;
}

// The pinned Listing, checked against the Listing hash in the terms, and the
// Agreement material derived from it exactly as the SDK's
// deriveFixedPriceAgreement does: deliverable, price, rail, deadline term,
// validity window and the seller identity hash.
async function listingTerms(listing, t, seller) {
  const bad = (reason) => refuse('listing', `the pinned Listing ${reason}`);
  if (!plain(listing)) bad('is missing from the purchase start');
  if (await sha256Hex(canonicalJson(withoutKeys(listing, ['signature', 'signatures']))) !== t.listing.contentHash) bad('does not match the Listing hash of this purchase');
  if (listing.listingId !== t.listing.listingId || listing.listingVersion !== t.listing.version) bad('is another Listing or version');
  const identity = listing.seller?.identity;
  if (!plain(identity) || identity.presentedBy !== seller) bad('belongs to another seller');
  const pipeline = listing.pipeline;
  if (!Array.isArray(pipeline) || canonicalJson(pipeline.map((x) => x?.kind ?? null)) !== canonicalJson(SUPPORTED_PIPELINE) || pipeline[PAYMENT_PHASE_INDEX].parameters?.rail !== DEM_RAIL) bad('is not the fixed-price pay-dem pipeline');
  const price = listing.pricing?.price;
  if (listing.pricing?.kind !== 'fixed' || !exactKeys(price, ['amount', 'currency']) || price.currency !== 'DEM' || price.amount !== t.price.amount) bad('price is not the purchase price');
  const rail = { railId: DEM_RAIL, railVersion: 1 };
  if (!Array.isArray(listing.acceptedRails) || !listing.acceptedRails.some((r) => plain(r) && canonicalJson(r) === canonicalJson(rail))) bad('does not accept the DEM rail');
  const deliverable = listing.offering?.deliverable;
  if (!plain(deliverable) || deliverable.kind !== 'storage-program') bad('deliverable is not a storage program');
  if (deliverable.schemaUrl !== undefined && (typeof deliverable.schemaUrl !== 'string' || !SCHEMA_URL.test(deliverable.schemaUrl))) bad('deliverable schema is malformed');
  const seconds = listing.terms?.deadlineSecAfterCommit;
  if (!safeInt(seconds) || seconds <= 0 || !safeInt(seconds * 1000) || listing.terms.acceptanceModel === 'auto-accept') bad('delivery deadline term is malformed');
  const validity = listing.validity;
  if (!plain(validity) || !safeInt(validity.notBefore) || (validity.notAfter !== undefined && !safeInt(validity.notAfter))) bad('validity window is malformed');
  return deepFreeze({
    deliverable: { deliverableType: deliverable.kind, hash: await sha256Hex(canonicalJson(deliverable)), ...(deliverable.schemaUrl === undefined ? {} : { schemaUrl: deliverable.schemaUrl }) },
    price: { amount: price.amount, currency: 'DEM' },
    rail,
    deadlineAfterMs: seconds * 1000,
    validity: { notBefore: validity.notBefore, ...(validity.notAfter === undefined ? {} : { notAfter: validity.notAfter }) },
    sellerBundleHash: await sha256Hex(canonicalJson(withoutKeys(identity, ['presentation']))),
  });
}

// The exact seller session delegation the dialog shows (the payload of
// seller-session-delegation.mjs). Its key is the plugin's app session key,
// held server-side, so the wallet binds and shows it rather than making it.
function boundDelegation(payload, { buyer, seller, listing, job, now, expiresAt }) {
  const bad = (reason) => refuse('delegation', `the app-session authorization ${reason}`);
  if (!exactKeys(payload, DELEGATION_KEYS) || payload.version !== '1' || payload.kind !== 'seller-session-delegation') bad('is missing or has an unexpected shape');
  if (payload.buyer !== buyer || payload.seller !== seller || payload.jobId !== job || !exactKeys(payload.listingPin, ['listingId', 'version', 'contentHash'])
    || canonicalJson(payload.listingPin) !== canonicalJson(listing)) bad('is for another buyer, seller, Listing or job');
  const key = payload.sessionPublicKey;
  if (!HEX64.test(key ?? '') || `${DID_PREFIX}${key}` === buyer || `${DID_PREFIX}${key}` === seller) bad('names a malformed session key or a party key');
  if (!safeInt(payload.notBefore) || !safeInt(payload.expiresAt) || payload.notBefore < 0 || payload.expiresAt <= payload.notBefore
    || payload.expiresAt - payload.notBefore > DELEGATION_MAX_LIFETIME_MS || payload.notBefore > now + CLOCK_SKEW_MS || payload.expiresAt <= now) bad('has a validity window out of range');
  if (payload.expiresAt > expiresAt + DAY_MS) bad('outlives this purchase start by more than a day');
  return deepFreeze(copy(payload));
}

// Builds the intent from the purchase view and the server's Start facts, or
// throws when the terms are not coherent enough to state in plain words.
// view: {id, termsHash, expiresAt, terms}; start: {intent: {id, expiresAt},
// listing, delegation: {payload} | null, wallet: {plannedNonce}}; wallet: the
// connected embedded wallet address.
export async function buildIntent({ view, start, wallet, now }) {
  const t = view?.terms;
  const profile = intentProfile(t);
  if (!profile) refuse('profile', 'this purchase profile is not covered by a Start approval');
  const address = String(wallet ?? '').toLowerCase();
  if (!ADDRESS.test(address) || t.buyer?.wallet !== address) refuse('wallet', 'the connected wallet is not the wallet bound to this purchase');
  if (typeof t.buyer.accountId !== 'string' || !ACCOUNT_ID.test(t.buyer.accountId)) refuse('account', 'the purchase names no well-formed account');
  const seller = t.seller?.claim;
  if (!DID.test(seller ?? '') || seller === didOf(address)) refuse('seller', 'the seller DID is malformed or is your own');
  if (t.seller.payee !== addressOf(seller)) refuse('seller', 'the payee is not the seller DID’s own address');
  const listing = t.listing;
  if (typeof listing?.listingId !== 'string' || !LISTING_ID.test(listing.listingId) || !safeInt(listing.version) || listing.version < 1 || !HEX64.test(listing.contentHash ?? '')) refuse('listing', 'the Listing reference is malformed');
  const amountOs = decimalToOs(t.price?.amount);
  if (amountOs === null || amountOs <= 0n || !OS.test(t.price.amountOs ?? '') || BigInt(t.price.amountOs) !== amountOs) refuse('price', 'the price is malformed');
  if (typeof t.network !== 'string' || !NETWORK.test(t.network) || t.rail !== DEM_RAIL || t.domain?.rail !== DEM_RAIL || t.domain.network !== t.network) refuse('network', 'the network or payment rail is malformed');
  let chainIdentity = null;
  if (profile.kind === 'devnet') {
    chainIdentity = t.domain.chainIdentity;
    if (!HEX64.test(chainIdentity ?? '') || t.protocol.transportBinding.chainIdentity !== chainIdentity || t.protocol.transportBinding.network !== t.network) refuse('network', 'the chain identity is not the pinned transport’s');
  }
  if (!HEX64.test(view.termsHash ?? '') || typeof view.id !== 'string' || !PURCHASE_ID.test(view.id)) refuse('purchase', 'the purchase reference is malformed');
  // The terms hash every later server binding names (purchases.mjs contentHash(terms)).
  if (await sha256Hex(canonicalJson(t)) !== view.termsHash) refuse('terms', 'the purchase terms do not match their terms hash');
  const server = start?.intent;
  if (typeof server?.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(server.id)) refuse('purchase', 'the server issued no Start record');
  const material = await listingTerms(start?.listing, t, seller);
  const generatedAt = start?.agreement?.generatedAt;
  if (!safeInt(generatedAt) || generatedAt > now + CLOCK_SKEW_MS || generatedAt < now - DAY_MS) refuse('agreement', 'the approved Agreement generation time is out of range');
  if (generatedAt < material.validity.notBefore || (material.validity.notAfter !== undefined && generatedAt > material.validity.notAfter)) refuse('agreement', 'the approved Agreement generation time is outside the Listing validity window');
  const identity = await identityMessage({ buyer: didOf(address), purchase: view.id, job: t.protocol.jobId }, start?.identity?.bundle, { now });
  if (generatedAt < identity.presentedAt) refuse('agreement', 'the Agreement generation time precedes its identity presentation');
  const agreement = deepFreeze({ ...material, generatedAt, deadline: generatedAt + material.deadlineAfterMs });
  const plannedNonce = profile.writes.length ? start?.wallet?.plannedNonce : null;
  if (profile.writes.length && (!safeInt(plannedNonce) || plannedNonce < 1)) refuse('nonce', 'the server did not plan a nonce for the wallet write');
  const expiresAt = Math.min(Date.parse(server.expiresAt), Date.parse(view.expiresAt), now + INTENT_MAX_TTL_MS);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) refuse('expiry', 'the purchase or its Start record has already expired');
  const job = t.protocol.jobId;
  const pin = { listingId: listing.listingId, version: listing.version, contentHash: listing.contentHash };
  const delegation = profile.delegation ? boundDelegation(start?.delegation?.payload, { buyer: didOf(address), seller, listing: pin, job, now, expiresAt }) : null;
  const perWrite = profile.writes.length ? FEE_CEILING_PER_WRITE_OS : 0n;
  return Object.freeze({
    version: INTENT_VERSION,
    record: server.id,
    purchase: view.id,
    account: t.buyer.accountId,
    wallet: address,
    buyer: didOf(address),
    termsHash: view.termsHash,
    profile: profile.kind,
    job,
    listing: Object.freeze(pin),
    seller: Object.freeze({ did: seller, address: t.seller.payee }),
    price: Object.freeze({ amount: t.price.amount, amountOs: amountOs.toString(), asset: 'DEM' }),
    network: Object.freeze({ name: t.network, rail: DEM_RAIL, mode: t.domain.mode, chainIdentity }),
    agreement,
    identity: Object.freeze(identity),
    delegation,
    vet: Object.freeze({ mode: 'placeholder' }),
    steps: Object.freeze([...profile.steps]),
    // Planned wallet writes, at back-to-back nonces in this order.
    writes: Object.freeze(profile.writes.map((step, i) => Object.freeze({ step, nonce: plannedNonce + i }))),
    fees: Object.freeze({ perWriteOs: perWrite.toString(), totalOs: (perWrite * BigInt(profile.writes.length)).toString() }),
    approvedAt: now,
    expiresAt,
  });
}

const duration = (ms) => (ms % DAY_MS === 0 ? `${ms / DAY_MS} day(s)` : ms % 3_600_000 === 0 ? `${ms / 3_600_000} hour(s)` : ms % 60_000 === 0 ? `${ms / 60_000} minute(s)` : `${ms / 1000} second(s)`);

// The Agreement CREATE's operator RPC auth signatures, by request: the source
// bind and signature phases (sdk-provider.mjs sourceAuthHeaders, through the
// SDK's signMessage), then the node's confirmTx before the record is issued
// and its broadcastTx after (the SDK's Demos.call signs those itself). The gate
// allows exactly these (gate.mjs holdCreate), and the dialog lists them.
export const OPERATOR_AUTH_SIGNATURES = Object.freeze({ source: 2, confirmTx: 1, broadcastTx: 1 });
export const OPERATOR_AUTH_TOTAL = Object.values(OPERATOR_AUTH_SIGNATURES).reduce((a, b) => a + b, 0);
export const operatorAuthLine = (wallet) => `   With the Agreement record the wallet also makes ${OPERATOR_AUTH_TOTAL} operator RPC auth signatures: ${OPERATOR_AUTH_SIGNATURES.source} for the source bind and signature requests, ${OPERATOR_AUTH_SIGNATURES.confirmTx} when the node validates the record (confirmTx) and ${OPERATOR_AUTH_SIGNATURES.broadcastTx} when it broadcasts it (broadcastTx). Each signs only SHA-256 of "ed25519:${wallet}:<current time>": no transaction, no funds moved. If this start is replaced, locked or expires before the record is issued, the wallet stops: no more of these signatures and no new operator or node request, except freeing the source lease. A request already sent, including the SDK's automatic retries of it, cannot be recalled; its answer is discarded.`;

// The one dialog: plain words, every value the later checks hold to.
export function describeIntent(intent) {
  const a = intent.agreement;
  const d = intent.delegation;
  const lines = [
    `Start this purchase with one approval (purchase ${intent.purchase}).`,
    '',
    `Listing: ${intent.listing.listingId}, version ${intent.listing.version}`,
    `Listing hash: ${intent.listing.contentHash}`,
    `Seller: ${intent.seller.address}`,
    `Seller DID: ${intent.seller.did}`,
    `Price: ${intent.price.amount} ${intent.price.asset} (${intent.price.amountOs} OS), paid later in a separate approval`,
    `Deliverable: ${a.deliverable.deliverableType}${a.deliverable.schemaUrl === undefined ? '' : ` (schema ${a.deliverable.schemaUrl})`}, hash ${a.deliverable.hash}`,
    `Agreement generated at: ${new Date(a.generatedAt).toISOString()}`,
    `Delivery deadline: ${new Date(a.deadline).toISOString()} (${duration(a.deadlineAfterMs)} after generation, from the Listing)`,
    `Buyer identity: hash ${intent.identity.bundleHash}, presented ${new Date(intent.identity.presentedAt).toISOString()}`,
    `Seller identity: hash ${a.sellerBundleHash}`,
    `Network: ${intent.network.name} · ${intent.network.rail}${intent.network.chainIdentity ? ` · chain ${intent.network.chainIdentity} (explicit independently supplied source pin; single node, finality not established)` : ' (SIMULATED fixture chain)'}`,
    `Your wallet: ${intent.wallet}`,
    `Account: ${intent.account}`,
    `Job: ${intent.job}`,
    `Terms hash: ${intent.termsHash}`,
    ...(d ? [`App session key: ${d.sessionPublicKey}, for this seller, Listing and job only, from ${new Date(d.notBefore).toISOString()} until ${new Date(d.expiresAt).toISOString()}`] : []),
    '',
    `This approval lets the wallet sign, in order and once each:`,
    ...intent.steps.map((step, i) => `${i + 1}. ${STEPS[step]}`),
    ...(intent.steps.includes('agreementCreate') ? [operatorAuthLine(intent.wallet)] : []),
    '',
    intent.writes.length
      ? `Wallet writes covered: ${intent.writes.length} (${intent.writes.map((w) => `${WRITES[w.step]}, nonce ${w.nonce}`).join('; ')}). Fee ceiling: ${formatDem(BigInt(intent.fees.perWriteOs))} DEM per write, ${formatDem(BigInt(intent.fees.totalOs))} DEM in total.`
      : 'Wallet writes covered: none (no network fee from this wallet).',
    'Vet records: not performed in this profile; only the fixed placeholder references are accepted.',
    `Valid until ${new Date(intent.expiresAt).toISOString()}, for this purchase, account and wallet only.`,
    '',
    `${intent.steps.includes('agreementCreate') ? 'Before each purchase signature the wallet checks the exact bytes against these values; it builds the operator RPC auth messages itself.' : 'Before each signature the wallet checks the exact bytes against these values.'} Anything different stops with nothing signed, and you are told why. Sending funds is not included: it needs its own approval.`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-step checks. Each returns the exact message the wallet signs.
// ---------------------------------------------------------------------------

// DACS-1 identity presentation (listing.mjs buildUnsignedIdentityBundle).
export async function identityMessage(intent, bundle, { now }) {
  if (!exactKeys(bundle, ['bundleVersion', 'presentedBy', 'presentedAt', 'sessionNonce', 'claims']) || bundle.bundleVersion !== '1') refuse('identity', 'the identity bundle has an unexpected shape');
  if (bundle.presentedBy !== intent.buyer || JSON.stringify(bundle.claims) !== JSON.stringify([{ ref: intent.buyer }])) refuse('parties', 'the identity bundle presents a different party than this wallet');
  if (!safeInt(bundle.presentedAt) || bundle.presentedAt > now + CLOCK_SKEW_MS || bundle.presentedAt < now - DAY_MS) refuse('identity', 'the identity presentation time is out of range');
  const nonce = await sha256Hex(`dacs-chatgpt-plugin:${intent.purchase}:${intent.job}:${intent.buyer}:${bundle.presentedAt}`);
  if (bundle.sessionNonce !== nonce) refuse('job', 'the identity bundle is bound to a different purchase or job');
  const bundleHash = await sha256Hex(canonicalJson(bundle));
  if (intent.identity && bundleHash !== intent.identity.bundleHash) refuse('identity', 'the identity presentation differs from the one approved at Start');
  return { message: `${PRESENTATION_SEPARATOR}${bundleHash}`, bundleHash, presentedAt: bundle.presentedAt };
}

// Seller session delegation (seller-session-delegation.mjs): exactly the
// payload the intent shows, still valid now; check is the portal's existing
// checker, injected.
export function delegationMessage(intent, payload, { now, check }) {
  if (typeof check !== 'function') refuse('delegation', 'no delegation checker is available');
  if (!intent.delegation) refuse('delegation', 'this purchase start shows no app-session authorization');
  let message;
  try { message = `${SESSION_DELEGATION_PREFIX}${canonicalJson(payload)}`; } catch { refuse('delegation', 'the delegation has no canonical form'); }
  if (message !== `${SESSION_DELEGATION_PREFIX}${canonicalJson(intent.delegation)}`) refuse('delegation', 'the delegation differs from the one you approved (session key, validity window, seller, Listing or job)');
  const terms = { buyer: { wallet: intent.wallet }, seller: { claim: intent.seller.did }, listing: { ...intent.listing }, protocol: { jobId: intent.job } };
  try { check({ payload, message }, terms, { now }); } catch (error) { refuse('delegation', String(error?.message ?? 'the delegation differs from this purchase')); }
  return { message };
}

const AGREEMENT_KEYS = ['payeeBoundAgreementVersion', 'jobId', 'listingRef', 'parties', 'derivedFromPattern', 'generatedAt', 'terms'];
const TERMS_KEYS = ['deliverable', 'price', 'rail', 'deadline', 'payoutBindings'];
const PARTY_KEYS = ['role', 'bundleHash', 'primaryClaim', 'vetRecordRef'];

// The Agreement the wallet will sign: everything from the intent, the fixed
// protocol rules and the hash-checked Listing; from the server only the
// generation time, within [identity presentation, now + skew] and the
// Listing's validity window.
async function derivedAgreement(intent, generatedAt, bundleHash) {
  const a = intent.agreement;
  return {
    payeeBoundAgreementVersion: '1',
    jobId: intent.job,
    listingRef: { ...intent.listing },
    parties: [
      { role: 'buyer', bundleHash, primaryClaim: intent.buyer, vetRecordRef: await vetPlaceholder(intent.job, intent.buyer) },
      { role: 'seller', bundleHash: a.sellerBundleHash, primaryClaim: intent.seller.did, vetRecordRef: await vetPlaceholder(intent.job, intent.seller.did) },
    ],
    derivedFromPattern: 'fixed-price',
    generatedAt,
    terms: {
      deliverable: { ...a.deliverable },
      price: { ...a.price },
      rail: { ...a.rail },
      deadline: generatedAt + a.deadlineAfterMs,
      payoutBindings: [{ railId: DEM_RAIL, phaseIndex: PAYMENT_PHASE_INDEX, payeeAddress: intent.seller.address }],
    },
  };
}

// DACS-3 payee-bound Agreement (SDK createFixedPriceAgreementSigningPlan):
// separator || sha256(JCS(agreement)), over the Agreement the wallet derived
// itself. The server draft must equal it exactly; each check below names the
// first field that differs.
export async function agreementMessage(intent, draft, { bundleHash, presentedAt, now }) {
  if (!exactKeys(draft, AGREEMENT_KEYS) || draft.payeeBoundAgreementVersion !== '1' || draft.derivedFromPattern !== 'fixed-price') refuse('agreement', 'the Agreement draft has an unexpected shape');
  if (draft.jobId !== intent.job) refuse('job', `the Agreement is for job ${draft.jobId}, not ${intent.job}`);
  const ref = draft.listingRef;
  if (!exactKeys(ref, ['listingId', 'version', 'contentHash'])) refuse('listing', 'the Agreement Listing reference is malformed');
  if (ref.listingId !== intent.listing.listingId) refuse('listing', `the Agreement names Listing ${ref.listingId}, not ${intent.listing.listingId}`);
  if (ref.version !== intent.listing.version) refuse('version', `the Agreement names Listing version ${ref.version}, not ${intent.listing.version}`);
  if (ref.contentHash !== intent.listing.contentHash) refuse('hash', 'the Agreement names a different Listing hash');
  const t = draft.terms;
  if (!exactKeys(t, TERMS_KEYS)) refuse('agreement', 'the Agreement terms have an unexpected shape');
  if (!exactKeys(t.price, ['amount', 'currency']) || t.price.currency !== 'DEM' || decimalToOs(t.price.amount)?.toString() !== intent.price.amountOs) refuse('price', `the Agreement price is ${t.price?.amount} ${t.price?.currency}, not ${intent.price.amount} DEM`);
  if (!exactKeys(t.rail, ['railId', 'railVersion']) || t.rail.railId !== DEM_RAIL || t.rail.railVersion !== 1) refuse('network', 'the Agreement uses a different payment rail');
  const payout = t.payoutBindings;
  if (!Array.isArray(payout) || payout.length !== 1 || !exactKeys(payout[0], ['payeeAddress', 'phaseIndex', 'railId'])) refuse('agreement', 'the Agreement payout binding is malformed');
  if (payout[0].payeeAddress !== intent.seller.address) refuse('seller', `the Agreement pays ${payout[0].payeeAddress}, not the seller ${intent.seller.address}`);
  if (canonicalJson(t.deliverable) !== canonicalJson(intent.agreement.deliverable)) refuse('deliverable', 'the Agreement names a different deliverable than the pinned Listing');
  const validity = intent.agreement.validity;
  if (!safeInt(draft.generatedAt) || !safeInt(presentedAt) || draft.generatedAt < presentedAt || draft.generatedAt > now + CLOCK_SKEW_MS) refuse('agreement', 'the Agreement generation time is out of range');
  if (draft.generatedAt !== intent.agreement.generatedAt) refuse('agreement', 'the Agreement generation time differs from the one approved at Start');
  if (draft.generatedAt < validity.notBefore || (validity.notAfter !== undefined && draft.generatedAt > validity.notAfter)) refuse('agreement', 'the Agreement is generated outside the Listing’s validity window');
  if (t.deadline !== draft.generatedAt + intent.agreement.deadlineAfterMs) refuse('deadline', 'the Agreement deadline is not the Listing’s delivery deadline term');
  const parties = draft.parties;
  if (!Array.isArray(parties) || parties.length !== 2 || !parties.every((p) => exactKeys(p, PARTY_KEYS))
    || parties[0].role !== 'buyer' || parties[1].role !== 'seller') refuse('parties', 'the Agreement does not name exactly one buyer and one seller');
  const [buyer, seller] = parties;
  if (buyer.primaryClaim !== intent.buyer) refuse('parties', 'the Agreement names a different buyer than this wallet');
  if (seller.primaryClaim !== intent.seller.did) refuse('seller', `the Agreement names seller ${seller.primaryClaim}, not ${intent.seller.did}`);
  if (buyer.bundleHash !== bundleHash) refuse('parties', 'the Agreement binds a different buyer identity presentation');
  if (seller.bundleHash !== intent.agreement.sellerBundleHash) refuse('parties', 'the Agreement binds a different seller identity than the pinned Listing’s');
  const expected = await derivedAgreement(intent, intent.agreement.generatedAt, bundleHash);
  for (const [i, role] of [[0, 'buyer'], [1, 'seller']]) {
    if (canonicalJson(parties[i].vetRecordRef ?? null) !== canonicalJson(expected.parties[i].vetRecordRef)) refuse('vet', `the ${role} vet record reference is not the fixed not-performed placeholder`);
  }
  const bytes = canonicalJson(expected);
  if (canonicalJson(draft) !== bytes) refuse('agreement', 'the Agreement differs from the one the wallet derived from the approved start and the pinned Listing');
  const agreementHash = await sha256Hex(bytes);
  return { message: `${AGREEMENT_SEPARATOR}${agreementHash}`, agreementHash };
}

// Fixture SR-2 write authorization (fixture-anchors.mjs anchorWriteMessage).
export function anchorAuthorizationMessage(intent, agreementHash) {
  if (intent.profile !== 'fixture' || !HEX64.test(agreementHash ?? '')) refuse('agreement', 'no checked Agreement to authorize');
  return { message: `${FIXTURE_WRITE_PREFIX}dacs3:agreement:${intent.job}:${agreementHash}` };
}

// Browser Agreement session challenge (challenges.mjs renderChallengeMessage
// with the devnet broker's scope). Re-rendered from the intent; only the
// server's nonce and times are taken from the message, after format checks.
export function brokerChallengeMessage(intent, message, { origin, agreementHash, now }) {
  if (typeof message !== 'string' || typeof origin !== 'string' || !HEX64.test(agreementHash ?? '')) refuse('broker', 'the browser session challenge is malformed');
  const field = (name) => new RegExp(`^${name}: (.+)$`, 'm').exec(message)?.[1];
  const nonce = field('nonce'), issuedAt = field('issued-at'), expiresAt = field('expires-at');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce ?? '') || !Number.isFinite(Date.parse(issuedAt)) || !Number.isFinite(Date.parse(expiresAt))
    || new Date(Date.parse(issuedAt)).toISOString() !== issuedAt || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt) refuse('broker', 'the browser session challenge is malformed');
  if (Date.parse(expiresAt) <= now || Date.parse(issuedAt) > now + CLOCK_SKEW_MS) refuse('expiry', 'the browser session challenge is expired or from the future');
  const binding = { account: intent.account, 'agreement-hash': agreementHash, authorization: BROKER_AUTHORIZATION, job: intent.job, network: intent.network.name, operation: intent.purchase, 'terms-hash': intent.termsHash, wallet: intent.wallet };
  const expected = [
    `${new URL(origin).host} requests a DACS wallet signature`, '', BROKER_STATEMENT, '',
    `origin: ${origin}`, `purpose: ${BROKER_PURPOSE}`, `address: ${intent.wallet}`,
    ...Object.keys(binding).sort().map((k) => `${k}: ${binding[k]}`),
    `nonce: ${nonce}`, `issued-at: ${issuedAt}`, `expires-at: ${expiresAt}`,
  ].join('\n');
  if (expected !== message) refuse('broker', 'the browser session challenge differs from this purchase, account, wallet or Agreement');
  return { message };
}

// The wallet's own Agreement CREATE approval request (sdk-provider.mjs
// storageProgramAnchor), checked before the session signs it.
export async function checkAgreementCreate(intent, content, { agreementHash, spentOs }) {
  const write = intent.writes.find((w) => w.step === 'agreementCreate');
  if (!write || !plain(content)) refuse('write', 'this intent covers no such wallet write');
  if (content.kind !== DEVNET_CREATE_KIND || content.artifactKind !== 'Agreement') refuse('write', 'the wallet write is not the Agreement record CREATE');
  if (content.jobId !== intent.job || content.logicalAddress !== `dacs3:agreement:${intent.job}`) refuse('job', 'the Agreement CREATE is for a different job');
  if (content.owner !== intent.buyer || content.wallet !== intent.wallet) refuse('parties', 'the Agreement CREATE is owned by a different wallet');
  if (content.contentHash !== agreementHash) refuse('agreement', 'the Agreement CREATE carries a different Agreement than the one checked');
  let stored;
  try { stored = JSON.parse(content.exactStorageBytes); } catch { refuse('agreement', 'the Agreement CREATE bytes are not JSON'); }
  if (!plain(stored)) refuse('agreement', 'the Agreement CREATE bytes are not an Agreement');
  const scope = Object.fromEntries(Object.entries(stored).filter(([k]) => k !== 'signature' && k !== 'signatures'));
  if (await sha256Hex(canonicalJson(scope)) !== agreementHash) refuse('agreement', 'the stored Agreement differs from the one checked');
  if (content.network !== intent.network.name || content.chainIdentity !== intent.network.chainIdentity) refuse('network', `the Agreement CREATE targets ${content.network} (${content.chainIdentity}), not ${intent.network.name}`);
  if (content.nonce !== write.nonce) refuse('nonce', `the Agreement CREATE uses nonce ${content.nonce}, not the planned ${write.nonce}`);
  const total = typeof content.debit?.totalOs === 'string' && /^(0|[1-9][0-9]*)$/.test(content.debit.totalOs) ? BigInt(content.debit.totalOs) : null;
  if (total === null) refuse('fee', 'the Agreement CREATE shows no exact debit');
  if (total > BigInt(intent.fees.perWriteOs)) refuse('fee', `the Agreement CREATE costs ${formatDem(total)} DEM, above the ${formatDem(BigInt(intent.fees.perWriteOs))} DEM ceiling per write`);
  if (spentOs + total > BigInt(intent.fees.totalOs)) refuse('fee', 'the wallet writes would exceed the approved total fee ceiling');
  return { totalOs: total };
}
