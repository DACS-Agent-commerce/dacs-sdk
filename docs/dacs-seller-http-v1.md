# `dacs-seller-http/v1`: the buyer-to-seller wire

> **Status: SDK wire definitions ready for review; composition qualification pending.**
> The implementation decisions below define this library change. Seller and
> client integration remains a release qualification requirement. The wire runs only
> under testnet profile TP-1 ([testnet-profile-tp1.md](testnet-profile-tp1.md)).

The internal `src/wire` module defines the HTTPS wire between a buyer and a seller's
own endpoint: the route table, the signed request and response envelopes, the
seller session delegation, the discovery document and endpoint proof, their
exact signing bytes, and validators. It has no HTTP server or client. Its one
store, and its only I/O, is the seller's request journal
(`openWireRequestJournal`), a local directory: on an effect route
`checkWireRequest` writes and syncs journal entries synchronously, so it
blocks the calling thread for those writes. The seller host (`@kynesyslabs/dacs-seller`) and the
buyer client (`@kynesyslabs/dacs-client`) are its intended consumers.

It is the wire the buyer plugins run today, ported from the plugin
implementation, with two enumerated changes (D6 domains and profile, D7
exact-bytes admission) and two new parts (discovery and endpoint proof, the
TP-1 identity gate). Host admission additionally requires the replay and
Agreement context checks described below. Unless a section says otherwise, behaviour is the
plugin's. The plugin implementation is not public. Where this SDK pins a ported
behaviour, the table names its own source and tests. Original-plugin captures and a parity comparison test are planned for a later
compatibility slice. Plugin parity is unverified at this prefix. Claims about
the plugin are taken from its implementation and require composition checks.

| What | Pinned in this SDK by |
|---|---|
| Route table, including the context route | `src/wire/routes.ts`; `test/wire/wire.test.ts` |
| Envelope, signing bytes, header | `src/wire/envelope.ts`, `src/wire/validate.ts`; `test/wire/envelope.test.ts` |
| Delegation | `src/wire/delegation.ts`; `test/wire/delegation.test.ts` |
| Response and client half | `src/wire/response.ts`; `test/wire/response.test.ts` |
| Limits | `DACS_SELLER_HTTP_LIMITS` in `src/wire/routes.ts`; `test/wire/wire.test.ts` |
| Raw JSON admission | dacs-sdk `3904d70` `src/canonical/rawJson.ts:92-212` (`admitRawJson`) |
| Discovery and endpoint proof | new: `src/wire/discovery.ts`; `test/wire/discoveryLifetime.test.ts` |

## Implementation decisions and release scope

The SDK implements one buyer-to-seller transport, `dacs-seller-http/v1`,
without a fallback to the plugin signing domains. Its definitions and validators
currently live in internal `src/wire`; the package wire entry point is pending;
HTTP hosting and clients belong to their consuming packages. The seller's durable
request journal ships here (`openWireRequestJournal`).
The only supported profile is experimental TP-1 on the approved Demos testnet
identity. This change does not enable a mainnet identity or a mainnet release.

These are the wire, package layout and profile choices implemented here.
Merging the library does not qualify a seller/client composition: the retained
effect paths and the checks listed in the TP-1 declaration remain pending
before that composition can be released. The declaration and register retain
that proposed status until the checks run.

## Routes

All signed routes are `POST` with a JSON body and the signed envelope in the
`x-dacs-seller-peer` header. A request goes to the seller's `publicEndpoint`,
which is an origin (see the discovery document), followed by the route path.
Paths are matched exactly against the raw request
target; a query string, trailing slash, other case or encoded alias is not a
route (`findDacsSellerHttpRoute`).

| Route | Effect | Mounted |
|---|---|---|
| `POST /dacs/v1/agreements/proposals` | effect | always |
| `POST /dacs/v1/agreements/state` | read | always |
| `POST /dacs/v1/commitments` | effect | always |
| `POST /dacs/v1/payments` | effect | always |
| `POST /dacs/v1/bundles/request` | effect | always |
| `POST /dacs/v1/bundles/countersignature` | effect | always |
| `POST /dacs/v1/bundles/buyer-copy` | read | always |
| `POST /dacs/v1/commitments/signature` | effect | seller option commit-on-signature |
| `POST /dacs/v1/agreements/context` | effect | seller option context route |
| `GET /.well-known/dacs-seller.json` | read | always; signed document, no envelope |

## Limits (unchanged)

| Limit | Value |
|---|---|
| Request body | 64 KiB |
| Response body | 512 KiB |
| Receiver's window (`expiresAt - now` by the receiver's clock) | at most 60 s, as in the plugin; the seller's override (`checkWireRequest`'s `maxLifetimeMs`) must be an integer from 1 to 60,000 ms or the call fails with `seller_configuration_invalid`. The buyer's window for answers is 60 s. A seller window below the buyer's request lifetime plus the clock difference refuses honest requests |
| Signer's lifetime (`expiresAt - now` by the signer's clock) | **new:** at most 30 s (`maxSignedLifetimeMs`), default 30 s, for requests (`signWireRequest`'s `lifetimeMs`; above it is a `TypeError`) and answers (`signWireResponse`'s `lifetimeMs`; above it, or a `maxLifetimeMs` given to `signWireResponse`, fails with `seller_configuration_invalid`) |
| Clock difference tolerated (`maxClockSkewMs`) | **new:** 30 s. A signer's 30 s lifetime inside a receiver's 60 s window passes with the signer's clock up to 30 s ahead of or behind the receiver's (less transit time); a buyer backdates a delegation's `notBefore` by 30 s; the request journal never drops a reservation, so no journal clock can release one a worker still accepts. The plugin signed 60 s answers into a 60 s window, so any seller clock lead refused every answer after the seller had acted |
| Envelope header | at most 4,096 base64url characters |
| Seller session delegation | at most 24 h (`expiresAt - notBefore`) |
| Discovery document | at most 16 KiB, valid at most 10 minutes (new) |

## Signing domains

The signed bytes of every wire message are its domain followed by the RFC 8785
(JCS, with CF-1 values-NFC) canonical form of its payload:

| Message | Domain | Replaces (plugin) |
|---|---|---|
| Request | `dacs-seller-http:v1:request:` | `dacs-chatgpt-plugin:loopback-seller-peer:v1:` |
| Response | `dacs-seller-http:v1:response:` | the same request domain (the plugin signed both kinds under one domain) |
| Seller session delegation | `dacs-seller-http:v1:delegation:` | `dacs-chatgpt-plugin:seller-session-delegation:v1:` |
| Discovery document | `dacs-seller-http:v1:discovery:` | none (new) |

**These are SDK wire domains, not DACS-Standard artifact domains.** The
Standard's signature domain separators (the registry of CORE §B.7,
`spec/CORE.md:470-521` at `d45c0a2`; the SDK's `SIGNATURE_DOMAIN_SEPARATORS`) sign DACS artifacts:
Listings, bundles, Agreements, settlement evidence and the rest. A wire
signature authenticates one transport message between two parties and is
never a DACS artifact signature: it does not authorize an identity
presentation, a storage write, an Agreement or a payment. No wire domain is a
Standard signature domain or hash-domain tag (`dacs-sealed-bid:v1:`,
`dacs-sb3:v1:`, `dacs-ap2-idem:v1:`), and none is a prefix of one or has one
as its prefix. The Standard does not standardise this transport yet. CORE
SIG-4 (`spec/CORE.md:590` at `d45c0a2`) gives an artifact kind outside the
registry the form `dacs-x-<kind>:v<version>:`. These domains do not take
that form, because the SDK reads SIG-4 as covering artifact kinds, not
transport messages. They also sign `domain ‖ canonical(payload)`, not
§B.7's `separator ‖ artifact_hash`. The Standard has not ruled on this, and the register
records it as G12. Making it normative is a separate proposal to the Standard
until the Standard adopts it, this document is the SDK's own
description. There is no compatibility arm for the old plugin domains.

## Request and response envelopes

Header `x-dacs-seller-peer` is the base64url (no padding) encoding of the
canonical JSON `{payload, signature, delegation?}`. `signature` is the 64-byte
Ed25519 signature. Producers write canonical base64url; receivers also accept
128 hex characters, with or without one `0x` prefix. The same holds for the
discovery document's `signature`. `delegation` is optional on a request and
never present on an answer. A buyer may send one to any seller, and the seller
verifies it whenever it is present (`openWireEnvelope`), with the full delegated
checks below. A seller that requires delegated sessions (`requireDelegation`)
also refuses a request without one (`peer_delegation_required`). So a buyer
never needs to know that setting: one that signs with a delegated session key
is accepted by every seller, and one that signs with its wallet key is told
plainly when a seller requires a delegation.

Request payload, exact fields:

| Field | Value |
|---|---|
| `version` | `"1"` |
| `kind` | `"request"` |
| `method` | `"POST"` |
| `path` | exactly one of the route table's signed paths (no other spelling: a trailing slash, double slash or other case is `peer_envelope_invalid` at signing and opening, before anything is reserved) |
| `bodyHash` | sha256 hex of the exact body bytes sent |
| `jobId` | canonical job ID (26-character uppercase Crockford ULID) |
| `buyer`, `seller` | `did:demos:agent:<64 lowercase hex>`, different |
| `listingPin` | `{listingId (1–128 URL-safe ASCII characters: [A-Za-z0-9._~-]), version (positive integer), contentHash (64 hex)}` |
| `agreementHash` | 64 hex: the Agreement's hash; for the context route, the hash of the exact context scope |
| `nonce` | canonical base64url, 22-86 characters |
| `expiresAt` | Unix ms; the buyer signs at most 30 s after its own clock, and the seller requires `now < expiresAt <= now + 60 s` by its clock |
| `profile` | **new (D6):** `{id, revision, base, chainIdentity, pinVersion}`, see below |

A response payload is the request payload with `kind: "response"`, `bodyHash`
of the exact response body bytes, its own `expiresAt` (at most 30 s after the seller's clock; the buyer accepts
`now < expiresAt <= now + 60 s` by its clock), and two more
fields: `requestHash` (sha256 of the canonical request payload, profile
included) and `status` (the HTTP status, 200-599). The seller signs every
answer to a request it opened, refusals by `checkWireRequest` and its handlers
included, with its Listing key. A request that `openWireEnvelope` refuses was
never authenticated, so it has no payload to answer: the seller answers it
unsigned, and the buyer treats an unsigned answer as no answer (the request may
or may not have been received, and is retried or read back, never taken as a
refusal or a result). The buyer verifies a signed answer against
the seller claim of the verified Listing and requires every request field,
the profile among them, to be echoed exactly.
No delegation ever authenticates or accompanies an answer. A response header
with a `delegation` member is refused (`peer_envelope_invalid`), including
when `openWireEnvelope` is called with `requireDelegation`; a response never
meets that requirement (`peer_delegation_required`). `signWireEnvelope` also
refuses an answer given a delegation, before its signer is called.

Request signers: the buyer key directly, or a session key the buyer's wallet
delegated (below). The seller additionally binds the request to the HTTP
exchange: audience, expiry and lifetime, method, path and `bodyHash`, Listing
pin, and the delegation's scope, Agreement deadline and expiry
(`checkWireRequest`). `checkWireRequest` takes only the frozen envelope that
`openWireEnvelope` returned, verified under the same binding; the SDK keeps a
private record of the envelopes it verified, so a payload, delegation or copy a
caller assembles is refused (`peer_request_unverified`) and no unverified
request reaches effect handling. `checkWireRequest` also admits the exact received body
bytes (D7) before comparing their hash, and returns the admitted body; effect
handling uses that body, never a separately parsed copy. A request
authenticated only by an expired delegation, or one that outlives a live
delegation, can reach only declared read routes, where it is `readbackOnly`.
The buyer decides readback by its own clock, so a readback request signed just
after the delegation expired by the buyer's clock is answered even while the
seller's clock is still before that expiry. Effect routes fail with
`peer_delegation_expired` before a checked body reaches their handlers. The
wire refuses even a retry of a journaled effect on an effect route after
delegation expiry; a nonce reservation never extends that authority. The plugin's
request body checks and its context-scope check stay with the seller package.

**The seller's order of checks.** Each seller entry point reads its options
once and checks its TP-1 binding and current connection first. Then, in
order (`purchaseProfile` is the tuple the seller kept for the purchase,
below):
1. `openWireEnvelope(header, "request", options)`: the kept tuple, before the
   header is read; the header's admission (D7) and members; the received
   profile (below); the payload; the delegation (its wallet signature, then
   its participants' authority); the signature; then the participants'
   authority for the job. The trusted `readAuthority` is asked about
   participants and a job only once a signature authenticates them (the same
   holds in `verifySellerSessionDelegation` and `verifyEndpointProof`), so an
   unsigned header triggers no participant or session read. A refused
   request is never decoded into a value the seller holds, so it gets no
   signed answer (above).
2. `checkWireRequest(opened, check)`: the envelope `openWireEnvelope`
   verified under that binding; the kept tuple again; the lifetime override;
   audience; expiry and lifetime; the body's admission; method, path and body
   hash; the Listing pin; the job and Agreement the host retained; a required
   delegation; the delegation's scope, Agreement deadline and expiry.
   Every request, on every signed route, direct or delegated, requires
   `retained: {jobId, agreementHash, buyer, seller}`: what the seller host
   retained for that job before this request (the retained Agreement's hash
   and parties; for an initial proposal, see below; for the context route, the
   exact context-scope hash). It is read once, as data, and never taken from
   the request's envelope.
   An initial proposal has no earlier retained state: the host admits the
   body bytes with `admitWireRequestBody`, validates the draft Agreement in it
   against its own Listing and offer, and then retains that draft's `jobId`
   and its Agreement hash (`contentHash` over the unsigned draft, as the SDK's
   fixed-price exchange computes it; computed by the host,
   never read from the envelope), and the draft's buyer and seller. For that
   route the comparison proves only
   that the signed envelope and the admitted body name the same draft; the
   draft itself goes in `artifacts`. A missing or
   malformed record fails with `seller_retained_agreement_required` (500); a
   signed `jobId` or `agreementHash` that differs fails with `peer_job_mismatch`
   or `peer_agreement_mismatch` (409), and a signed `buyer` or `seller` that
   differs fails with `peer_agreement_party_mismatch` (409). These refusals
   come before the delegation scope, the reservation and any returned
   body, so a correctly signed request naming another job, Agreement or party
   never reaches a handler. Agreements are public on testnet (G1): the
   retained parties, not the artifacts, are what refuse another key that knows
   the job and its Agreement hash.
   Every artifact given in `artifacts`, on a direct request as on a delegated
   one, must also name the signed `jobId`, Listing pin, buyer and seller
   (parties found by role); otherwise a direct request fails with
   `peer_agreement_party_mismatch` (409) before the reservation.
   Delegated requests also require at least one host-owned proposal draft or
   retained Agreement in `artifacts`; omission, an empty list or only null
   entries fails with `peer_delegation_agreement_required`. For an initial
   proposal, the host supplies the admitted proposal draft; it must not
   substitute request-derived scope for its retained Agreement.
3. On every route that starts or commits a purchase (proposals, commitments,
   commitment signature, context), `checkWireRequest` then requires the
   seller's own current `ready` and refuses the request while it is `false`
   (`seller_not_ready`, 503), before any reservation; the payment, delivery
   and read routes do not read it.
   On the payment and delivery routes (`payments`, `bundles/request`,
   `bundles/countersignature`), `checkWireRequest` instead requires the job's
   finalized commitment, as the exact bytes the seller read itself
   (`commitment`), its SR-2 receipt reader (`readCommitmentReceipt`), the
   retained Agreement both parties signed (`agreement`, as bytes too), and
   its own signed Listing that the request's pin names (`signedListing`, as
   bytes too). The Listing's commit phase, validity window and
   `deadlineSecAfterCommit` are read from that Listing, never from a host's
   statement of them. It checks them as the buyer's signers do (see the
   endpoint proof section), against the retained job, Agreement hash, parties
   and Listing pin, before any reservation, including the Standard's
   post-finality checks 5 and 6 at the receipt time, TP-1's Listing shape and
   the Agreement's terms against the Listing (DACS-3 §8.5.2 checks 1-4).
   `commitment: null`, the host's own reader having found none,
   refuses the request as `peer_agreement_uncommitted` (409); omitted, it is
   `seller_commitment_required` (500).
   Before returning a checked body on an effect route, `checkWireRequest`
   requires `requestJournal`: the handle `openWireRequestJournal(directory)`
   returned, the only journal `checkWireRequest` accepts. Any other object, a
   host's own journal that declares itself durable included, is refused
   (`seller_replay_guard_required`) before anything is reserved. The journal
   is a local directory that every worker of the seller host opens at
   startup. It must be an existing absolute directory, not a link, owned by
   the host's user and writable by no one else; otherwise it is refused
   (`seller_replay_guard_invalid`). Each entry is written under a temporary
   name, synced, then published with `link()`, and the directory is synced
   before the call returns. Publishing is atomic and exclusive: of workers
   racing on one entry, exactly one publishes it. So an entry published
   before a crash or restart is still there after it.
   `test/wire/requestJournal.test.ts` kills workers (SIGKILL) and races two
   worker processes against it.

   Each request publishes its key (SHA-256 of canonical `{buyer, seller,
   profile, nonce}`). The same signed request again is
   `peer_request_replayed` (409), and the journal never drops a key. Each
   effect is an operation, one per job and route. Its `operationId`
   (`wireOperationId`) is SHA-256 of canonical `{seller, jobId, path}`, so a
   fresh nonce, other incidental body fields, or another Agreement hash,
   buyer or tuple name the same operation. Its first attempt records the
   operation's binding, SHA-256 of canonical `{profile, buyer,
   agreementHash}`, and every later request for the operation must carry the
   same one: a job whose retained Agreement, buyer or tuple changed is
   refused (`peer_operation_mismatch`, 409) and never gets a second effect,
   before or after its outcome and across a restart.

   The operation's state is durable. The checked request's `effect` is one
   of:
   - `new`: no attempt has run. Run the effect.
   - `recover`: an earlier attempt's lease ended with no outcome, and this
     attempt now holds the operation alone. That earlier attempt may have
     acted, so check the effect's own source of truth (the chain, the
     delivery store) before acting.
   - `completed`: the outcome is recorded. Answer with it, signed again for
     this request, and run nothing. It is the answer this seller gave, not a
     new reading: where it states chain or delivery state, check that again
     at its source before answering.

   While an attempt's lease (60 s by default) is live, another request for
   the operation is `seller_effect_pending` (503: retry later). Once the
   effect's own write is durable, the handler records its outcome with
   `completeWireEffect(journal, effect, { status, text })`. The outcome is
   kept once (a different one is `seller_effect_conflict`). The text must be
   a body the wire can sign: well-formed UTF-8 that CF-5 admission admits as a
   JSON object (NFC strings, no duplicate members), or `completeWireEffect`
   refuses it as `wire_input_invalid`, detail `OUTCOME-INVALID`, before it
   publishes anything. It is stored as its bytes, so a repeat returns exactly
   what the handler signed (canonical JSON would normalize its Unicode), and
   a stored record whose bytes are not well-formed UTF-8 is a corrupt store,
   never decoded with replacement characters.
   `completeWireEffect(journal, effect, null)` ends an attempt that caused no
   effect, so the next request recovers at once without spending the crash
   budget. Each attempt ends exactly once, in one exclusive journal entry:
   by its own outcome (or `null`), or,
   once its lease has run out, by the request that recovers it. Whichever is
   published first stands, so an attempt ended that way records nothing
   (`seller_effect_superseded`), and no attempt starts after an outcome. An
   operation stops with `seller_effect_unresolved` (500) after 16 attempts
   have been superseded, including when clean `null` ends occur between them.
   There is no automatic reset: operator recovery must reconcile the operation
   against the chain or delivery store first. An entry the journal did not
   write (not a file, too large, a malformed outcome, attempt or end record,
   an outcome with no first attempt)
   fails closed (`seller_replay_guard_invalid`); an unreadable attempt is
   never taken as a lapsed lease. The journal refuses to open on Windows,
   where a directory cannot be synced. Each open also runs a bounded probe:
   its publisher exits before a fresh process checks retained bytes and
   exclusive retry. Failure refuses the open with `seller_replay_guard_invalid`,
   detail `RESTART-NOT-QUALIFIED`, before a handle is issued. Read
   routes need no reservation and have `effect: null`. All authentication,
   body, retained-Agreement, commitment, scope and deadline checks precede
   the reservation.

   The host must still do three things: keep the directory on durable local
   storage shared by all its workers; make each effect idempotent at its own
   sink by `operationId`, because a worker that overruns its lease may still
   be running when another recovers; and reconcile on `recover`. That
   composition is a `not checked` entry in the TP-1 register's composition
   qualification list.
4. `signWireResponse(request, status, text, ctx)`: the kept tuple, before the
   request or the body is read; the retained request's complete shape and hash;
   the lifetime override; the body's size and
   admission; the signer's claim; then `signWireEnvelope`, which checks the
   kept tuple and the profile again before it calls the signer.

The buyer's `verifyWireResponse` takes the exact received response body bytes,
not a decoded string. It admits them before hashing and returns the admitted
body with the receipt. `authenticationHash` is SHA-256 of the base64url
canonical header after normalizing its signature to canonical base64url; it
is stable across accepted hex encodings and JSON member order or whitespace.
The hash remains unchanged for headers produced by this SDK. Both signers (`signWireRequest`, `signWireResponse`)
apply the same admission profile to the body they are about to sign
(`outgoing_body_rejected`), so neither signs a body its peer must refuse.
This changes seller behaviour: the plugin signed any `JSON.stringify(answer)`.
The seller port must produce NFC, in-profile JSON before it signs, by
normalizing its answer or refusing it earlier.
