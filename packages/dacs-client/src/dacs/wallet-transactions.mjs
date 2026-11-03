// Unsigned Demos transaction payloads handed to the user's wallet through the
// trusted portal (provider.request({method:"sendTransaction", params:[tx]})).
// The server never holds a user key and never broadcasts.
//
// Provenance:
//  - storage-program create shape, program naming and address derivation follow
//    Community dacs-directory@074f040 app/api/dacs/build-listing/route.ts and
//    src/catalog/chain.ts deriveStorageAddress (salt "", nonce = account nonce + 1);
//  - native send shape follows what the SDK observer
//    (@kynesyslabs/dacs observePayDemTransferCore) requires on readback:
//    content.type "native", data ["native", {nativeOperation:"send", args:[to, amount]}].
//
// UNVERIFIED UPSTREAM CONTRACT: whether a given Demos wallet extension accepts
// a pre-built native-send payload via sendTransaction (and preserves the
// supplied nonce) has not been exercised against a real wallet in this build.
// Readback verification below does not depend on it: a transaction is accepted
// only if the chain shows the exact payer, payee, amount and expected nonce.
import { createHash } from 'node:crypto';
import { canonicalize } from './listing.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

export function communityProgramName(logicalAddress) {
  return `dacs1-${Buffer.from(logicalAddress, 'utf8').toString('base64url')}`;
}

export function deriveStorageAddress(owner, programName, nonce, salt = '') {
  return `stor-${sha256Hex(`${owner.toLowerCase()}:${programName}:${nonce}:${salt}`).slice(0, 40)}`;
}

const ZERO_FEE = Object.freeze({ network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null });

// Post-denomination-fork nodes carry integer OS as a decimal string; pre-fork
// nodes carry whole DEM numbers. The encoding is an explicit deployment setting.
export function encodeNativeAmount(amountOs, encoding) {
  if (encoding === 'os-string') return String(BigInt(amountOs));
  if (encoding === 'dem-number') {
    const os = BigInt(amountOs);
    if (os % 1_000_000_000n !== 0n) throw new Error('pre-fork DEM amounts must be whole DEM');
    return Number(os / 1_000_000_000n);
  }
  throw new Error('unknown DEM amount encoding');
}

// The native send carries no chain identity and no purchase commitment, and
// none is added: SDK 4.0.16 TransactionContent has no chain-id/genesis field,
// INativeSend is exactly args [to, amount], and the pinned DACS observer
// rejects any other args. Network binding is enforced around this payload
// (src/purchases.mjs domain checks), never claimed for its signature.
export function buildNativeTransferPayload({ from, to, amountOs, nonce, timestamp, encoding }) {
  const amount = encodeNativeAmount(amountOs, encoding);
  return {
    content: {
      type: 'native',
      from,
      to,
      amount,
      data: ['native', { nativeOperation: 'send', args: [to, amount] }],
      nonce,
      timestamp,
      transaction_fee: { ...ZERO_FEE },
    },
    signature: null,
    hash: '',
    status: '',
    blockNumber: null,
  };
}

export function buildStorageProgramCreatePayload({ from, storageAddress, programName, logicalAddress, signedListing, nonce, timestamp }) {
  return {
    content: {
      type: 'storageProgram',
      from,
      to: storageAddress,
      amount: 0,
      data: [
        'storageProgram',
        {
          operation: 'CREATE_STORAGE_PROGRAM',
          storageAddress,
          programName,
          encoding: 'json',
          data: signedListing,
          metadata: { logicalAddress },
          acl: { mode: 'public' },
          salt: '',
          storageLocation: 'onchain',
        },
      ],
      nonce,
      timestamp,
      transaction_fee: { ...ZERO_FEE },
    },
    signature: null,
    hash: '',
    status: '',
    blockNumber: null,
  };
}

export function payloadHash(payload) {
  return sha256Hex(canonicalize(payload));
}

export function createCoordinateStore({ db, now = () => Date.now() }) {
  const iso = () => new Date(now()).toISOString();
  const insert = db.prepare(`INSERT INTO write_coordinates (operation_id, kind, network, from_address, nonce_fence, expected_nonce, target, amount_os, payload, payload_hash, saved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const get = db.prepare('SELECT * FROM write_coordinates WHERE operation_id = ?');
  const bumpHandoff = db.prepare('UPDATE write_coordinates SET handoffs = handoffs + 1 WHERE operation_id = ?');
  const report = db.prepare('UPDATE write_coordinates SET reported_tx_hash = ?, reported_at = ? WHERE operation_id = ? AND (reported_tx_hash IS NULL OR reported_tx_hash = ?)');
  // Never clears an existing verification: a later failed re-read cannot erase settlement evidence.
  const observe = db.prepare('UPDATE write_coordinates SET observation = ?, verified_at = COALESCE(verified_at, ?) WHERE operation_id = ? AND verified_at IS NULL AND reported_tx_hash IS ?');
  // A pointer may be replaced while it has not been shown to occupy this
  // operation's nonce slot (slotConsumed, fresh or carried over a later
  // unverified re-read) and is not verified: another hash's read must never
  // erase recorded nonce consumption. An alternate-signed body
  // (signedByAlternateKey) may leave the wallet's own nonce free for the
  // approved transfer, so its consumption never pins the pointer.
  const replace = db.prepare(`UPDATE write_coordinates SET reported_tx_hash = ?, reported_at = ?, observation = NULL
    WHERE operation_id = ? AND verified_at IS NULL AND reported_tx_hash IS NOT NULL
      AND (observation IS NULL OR COALESCE(json_extract(observation, '$.slotConsumed'), 0) = 0
        OR COALESCE(json_extract(observation, '$.signedByAlternateKey'), 0) = 1)`);
  const verifiedOwner = db.prepare('SELECT operation_id FROM write_coordinates WHERE reported_tx_hash = ? AND verified_at IS NOT NULL');
  // Explicit proof that the wallet's own nonce was used by a transfer it signed:
  // only the durable wallet_nonce_consumptions record (whatever the purchase's
  // status), which no later read, pointer move or supersession removes. A
  // settlement or observation without it carries no signer provenance (an
  // alternate signing key may leave the wallet's nonce free, and older state
  // never recorded the signer), so it never counts; it predates the guarded
  // handoff, whose fresh nonce read already covers it.
  const consumedNonce = db.prepare(`SELECT DISTINCT c.operation_id AS operationId FROM wallet_nonce_consumptions c JOIN operations o ON o.id = c.operation_id
    WHERE c.from_address = ? AND c.network = ? AND c.nonce = ? AND o.kind = 'purchase'`);
  // Insert-only: the same fact recorded twice is a no-op; nothing updates or deletes a row.
  const consumeNonce = db.prepare(`INSERT OR IGNORE INTO wallet_nonce_consumptions (from_address, network, nonce, tx_hash, operation_id, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  // Adds only the native source-reconciliation marker; evidence and verification stay as recorded.
  const markNonce = db.prepare(`UPDATE write_coordinates SET observation = json_set(observation, '$.nativeNonceResolved', json('true')) WHERE operation_id = ? AND observation IS NOT NULL`);
  // A rejected or failed re-read never detaches a pointer still carrying an
  // earlier confirmed read's slot consumption (slotConsumedCarried): a new
  // hash could then replace that evidence. A fresh supersession (supersededBy)
  // records its own consumption and is detached, and so is an alternate-signed
  // consumption (signedByAlternateKey), which never pins the pointer.
  const clearPointer = db.prepare(`UPDATE write_coordinates SET reported_tx_hash = NULL, reported_at = NULL WHERE operation_id = ? AND reported_tx_hash = ? AND verified_at IS NULL
    AND (COALESCE(json_extract(observation, '$.slotConsumedCarried'), 0) = 0 OR COALESCE(json_extract(observation, '$.signedByAlternateKey'), 0) = 1)`);
  // Purchases and publications share each wallet's nonce space. Callers pass
  // the blocking statuses: an open handoff (nonce slot not yet consumed) blocks
  // every new handoff; an unresolved payment additionally blocks new purchases.
  const unresolvedStmt = (n) => db.prepare(`SELECT w.operation_id AS operationId, o.kind AS kind, o.status AS status FROM write_coordinates w JOIN operations o ON o.id = w.operation_id
    WHERE w.from_address = ? AND w.operation_id != ? AND o.status IN (${Array(n).fill('?').join(', ')})`);

  function hydrate(row) {
    if (!row) return null;
    return {
      operationId: row.operation_id,
      kind: row.kind,
      network: row.network,
      from: row.from_address,
      nonceFence: row.nonce_fence,
      expectedNonce: row.expected_nonce,
      target: row.target,
      amountOs: row.amount_os,
      payload: JSON.parse(row.payload),
      payloadHash: row.payload_hash,
      savedAt: row.saved_at,
      handoffs: row.handoffs,
      reportedTxHash: row.reported_tx_hash,
      reportedAt: row.reported_at,
      observation: row.observation ? JSON.parse(row.observation) : null,
      verifiedAt: row.verified_at,
    };
  }

  return {
    save({ operationId, kind, network, from, nonceFence, expectedNonce, target, amountOs = null, payload }) {
      insert.run(operationId, kind, network, from, nonceFence, expectedNonce, target, amountOs, JSON.stringify(payload), payloadHash(payload), iso());
      return hydrate(get.get(operationId));
    },
    get: (operationId) => hydrate(get.get(operationId)),
    countHandoff: (operationId) => bumpHandoff.run(operationId),
    // A reported hash is a pointer to check, never proof. Once set it cannot be
    // replaced by a different hash (the UNIQUE column also stops reuse across operations).
    reportHash(operationId, hash) {
      const result = report.run(hash, iso(), operationId, hash);
      return result.changes === 1;
    },
    replaceUnobservedHash(operationId, hash) {
      return replace.run(hash, iso(), operationId).changes === 1;
    },
    verifiedOwnerOf(hash) {
      return verifiedOwner.get(hash)?.operation_id ?? null;
    },
    walletConsumedSenderNonce(from, network, expectedNonce) {
      return consumedNonce.all(from, network, expectedNonce);
    },
    // A confirmed body the wallet itself signed used this nonce (read through operationId's pointer).
    recordWalletNonceConsumption({ from, network, nonce, txHash, operationId }) {
      consumeNonce.run(from, network, nonce, txHash, operationId, iso());
    },
    clearRejectedPointer(operationId, hash) {
      clearPointer.run(operationId, hash);
    },
    markNativeNonceResolved(operationId) {
      markNonce.run(operationId);
    },
    unresolvedForSender(from, exceptOperationId, statuses) {
      return unresolvedStmt(statuses.length).all(from, exceptOperationId, ...statuses);
    },
    // Throws a UNIQUE violation if this hash already settled another operation.
    recordObservation(operationId, observation, verified, expectedTxHash = observation.txHash) {
      return observe.run(JSON.stringify(observation), verified ? iso() : null, operationId, expectedTxHash).changes === 1;
    },
  };
}
