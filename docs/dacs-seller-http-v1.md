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

## Seller session delegation

The buyer's wallet signs, under `dacs-seller-http:v1:delegation:`:

`{version: "1", kind: "seller-session-delegation", buyer, sessionPublicKey, seller, listingPin, jobId, notBefore, expiresAt, profile}`

with `notBefore < expiresAt`, a lifetime of at most 24 h, and the new `profile`
member. A verifier refuses it before `notBefore` by its own clock, as the
plugin does, so a buyer sets `notBefore` at least 30 s (`maxClockSkewMs`)
before its own clock; a refusal comes before any seller effect. The delegation lets that session key authenticate transport toward
that seller, Listing and job until expiry; it never authorizes an identity
presentation, a storage write, an Agreement or a payment. Wallet signatures are
accepted as the 64 raw bytes, or as a string of hex or canonical base64url,
after surrounding whitespace is trimmed and any leading `0x` or `0X` prefixes
(one or more) are removed, as the plugin's `decodeSignature` does; a canonical
base64url signature that itself begins with `0x` is read as written. The
delegation always carries the canonical base64url form. Producing the bytes to sign
(`sellerSessionDelegationSigningBytes`) already requires the wallet side's TP-1
binding, so a wallet with no approved identity is never asked to sign.

## Discovery document and endpoint proof (new)

The seller serves `GET /.well-known/dacs-seller.json`: the canonical JSON
`{payload, signature}` with the payload signed by the
key of the seller claim named by `payload.seller` (the Listing signer can differ)
under `dacs-seller-http:v1:discovery:`.

| Field | Value |
|---|---|
| `format` | `"dacs-seller-discovery/v1"` |
| `profile` | the TP-1 profile member |
| `seller` | the seller claim |
| `publicEndpoint` | an HTTPS origin: the literal `https://` and an authority, then at most one `/`; no credentials, path, query or fragment; no backslash, tab or line break, and no trailing space or control character (spellings the URL parser would repair into another URL). Other spellings the parser normalizes (letter case, a default port) are kept as written and compared byte for byte, so a Listing must name the endpoint exactly as the document does. A request goes to the origin followed by the route path (`new URL(path, publicEndpoint)`, the same as dropping a trailing `/` and appending the path), and discovery to the origin's `/.well-known/dacs-seller.json` (RFC 8615); a seller behind a path-prefix proxy serves these paths at its origin |
| `transport` | `["dacs-seller-http/v1"]` |
| `listings` | 1-32 Listing pins served here |
| `capabilities` | exactly `TP1_CAPABILITIES` (listed below) |
| `ready` | whether the seller accepts new purchases |
| `issuedAt`, `expiresAt` | Unix ms, at most 10 minutes apart; `issuedAt` may be at most 60 s after the verifier's clock |

The **endpoint proof** is this document checked against the verified Listing
(`verifyEndpointProof`): the signer must be the Listing's seller, the
signature must verify, `publicEndpoint` must equal the Listing's
`publicEndpoint` byte for byte (never normalized), the Listing's pin must be
listed, the capabilities must be exactly TP-1's, and the document must be
current. The buyer runs it before preparing or signing anything for a
purchase; it stops a Listing from aiming buyer traffic at a server its seller
does not control.

`verifyEndpointProof` also requires `readListingEligibility`, a trusted,
synchronous buyer integration that authenticates the full Listing and its
content hash and resolves its selected pipeline, accepted rail and locally
configured service. It returns `VerifiedListingEligibility` for that exact
seller, byte-exact endpoint and Listing pin, with its validity window. It must
refuse revoked, missing or unavailable Listings and preserve source errors.
Do not construct this decision from discovery capabilities or other
unverified seller input. Any network reads belong to the authenticated reader
and require byte/list limits and deadlines before decoding.

The wire checks fixed pricing, `negotiate-fixed-price`, the commit phase
`commitPhase: "commit-payee-bound-agreement"` (DACS-3 §8.5.2 check 9: the only phase TP-1
commits, whose artifact is a PayeeBoundAgreementDocument), `pay-dem`, Demos
storage delivery, the bounded synchronous report output and absence of buyer
request input. The service must be `fixed-text` or an explicitly configured,
pure, deterministic, synchronous text module. The reader is called at proof
creation and again immediately before every request signature; retaining an
endpoint proof does not retain an authoritative eligibility verdict. A reader
must return a current decision or throw; a Promise is refused.

`ready: false` and the end of the Listing's window stop new purchases only.
For a job whose commitment has finalized, the buyer passes the job's finality
commitment as `commitment`, with the signed Agreement (`agreement`) and the
signed Listing it pins (`signedListing`), to `signWireRequest`, request-kind
`signWireEnvelope` and `verifyEndpointProof`. In TP-1 the seller is the
orchestrator (G3) and runs `commitFixedPriceAgreement`. It sends the result
(`FinalizedAgreementCommitment`) and the Agreement to its buyer as JSON. Both
are external DACS documents (CORE CF-5), so the wire admits each from its
exact received bytes before anything reads it: the buyer passes those bytes
(or the same record read again after a restart, as bytes), or a value the
wire's own admission returned: `admitWireArtifact(bytes)`, or a member of a
body `verifyWireResponse` or `checkWireRequest` admitted (frozen, and recorded
as admitted). A caller's object, a decoded string or a re-serialized copy is
refused (`ARTIFACT-NOT-ADMITTED`), and bytes admission refuses (duplicate
members, ill-formed UTF-8, an out-of-profile number, nesting past 128, a
unsupported numeric value) keep admission's own detail. Non-NFC string values are preserved at admission. The wire checks the evidence
itself, every time. First, the signed Listing the purchase pins, passed as
`signedListing` with the commitment and admitted the same way. It must be a
DACS-1 §6.3.4 Listing whose recomputed content hash, id and version are the
Listing pin the request, the record and the Agreement name. That hash omits
the Listing's signature, so the wire verifies that signature itself
(DACS-1 §6.3.4): `ed25519` by the key named in `signature.signer`, which
must be carried in `seller.identity.claims`. Any authorized seller claim may
sign, including a second key distinct from `presentedBy`; the signature must
verify under that named key over `dacs-listing:v1:` and the content hash
(`continuation_listing_invalid`, detail `LISTING-SIGNATURE`), as well as the
Agreement both parties signed and the record the seller signed over it. It must be presented
by the seller, carry a positive `deadlineSecAfterCommit`, not be auto-accept,
and select one fixed-price commitment: exactly one `negotiate-fixed-price`
phase, directly followed by `commit-payee-bound-agreement`; otherwise it is
`continuation_phase_unsupported`. The Listing signature is verified first; phase selection
then occurs before Agreement or commitment signature interpretation (DACS-3 §8.5.2
check 9, CA-5). The rest of the Listing must be TP-1's too: exactly one pay
phase, `pay-dem` (`continuation_phase_unsupported`, detail `PAY-PHASE`), and
exactly one delivery phase, `deliver-storage-program` (detail
`DELIVERY-PHASE`). That delivery first validates that the Agreement's
`deliverableType` is `storage-program` (`spec/DACS-4-SETTLE.md:831-839` at
`d45c0a2`), so the Listing's `offering.deliverable` must be a
`storage-program` DeliverableSpec (`continuation_listing_invalid`, detail
`DELIVERABLE-KIND`). Its pricing must be `fixed`, in DEM (detail
`TP1-PRICING`). No other pipeline phase kind is supported (detail
`PIPELINE`). A Listing whose delivery step must fail never reaches a
payment. The eligibility decision's `commitPhase` gates new purchases
only; no phase a host states selects a continuation's Agreement type. It
checks the record's members
(`finalityCommitmentVersion` `"1"`,
`fixed-price`), the job, the Agreement hash, the Listing pin and the parties
`[buyer, seller]`. It checks the record's Ed25519 signature under
`dacs-finality-commitment:v1:` by the seller. It checks that the receipt is a
CORE §5.1 AnchorReceipt and the transaction reference a DACS-4 §9.3 ChainTxRef
(the commitment gate's own validators), on substrate `demos`,
`finalized` and `established`, at
`dacs3:commit:{jobId}`, with the record's
native address and content hash, and takes `committedAt` from its
`blockRef.timestamp`. It checks the Agreement the record commits, passed as
`agreement` with the commitment (DACS-3 §8.6 CA-7). It must be an exact
fixed-price PayeeBoundAgreementDocument whose recomputed content hash is the record's
`agreementHash`, with the record's job, Listing pin and parties (by role),
and with an Ed25519 signature by each party under `dacs-payee-bound-agreement:v1:`. A
seller-signed record for an Agreement the buyer never signed is therefore
refused (`continuation_agreement_invalid`), at both buyer signers and on
every seller payment and delivery continuation route. Last, it asks `readCommitmentReceipt` (the buyer's own
SR-2 reader, given to `verifyEndpointProof` and kept with the proof) to
authenticate the receipt against the chain. A legacy record, a pending
receipt, another signer, a stated time the receipt does not give, or a
reader answer of `"invalid"` is refused
(`continuation_commitment_invalid`). `"indeterminate"` or `"error"` is
`commitment_unverified` (503): never final. With no reader, nothing
continues (`commitment_reader_required`). At signing it must name the
request's job, Agreement hash, buyer, seller and Listing pin
(`verifyEndpointProof` requires an authenticated `request` scope when commitment
evidence is supplied; both proof creation and signing compare the full request identity). Then the payment, delivery and
readback routes (`payments`, `bundles/request`, `bundles/countersignature`,
`agreements/state`, `bundles/buyer-copy`) are signed while the document says
`ready: false`, and the Listing's window must hold the commitment's receipt
time `committedAt` instead of now, its last instant included (DACS-3 §8.5.2
check 6, `notAfter >= committedAt`). The Agreement's own `generatedAt` never
stands in for `committedAt`, so a backdated one extends nothing; a
`committedAt` before it (the gate's `generatedAt <= committedAt`) or more
than 30 s after the signer's clock is refused. Once `committedAt` is known,
the wire re-evaluates DACS-3 §8.5.2 checks 5 and 6 from the signed Listing,
as the SDK's commitment gate does after finality (:659-661): a commitment
whose receipt time precedes the Listing's `notBefore` or follows its
`notAfter`, or whose Agreement `terms.deadline` is past `committedAt +
deadlineSecAfterCommit`, is invalid (`continuation_commitment_invalid`). So
is one whose receipt time follows that `terms.deadline` (the Agreement's
settle-by time, which seller payment intake also requires). Then, at
`committedAt`, the wire runs the SDK's own DACS-3 §8.5.2 verifier,
`validateFixedPriceAgreementBinding`, the one seller payment intake runs, on
the Agreement and the signed Listing. It checks checks 1-4 (currency, the
exact listed price, a recognized pricing kind, the rail as a complete
`acceptedRails` reference bound by the pay phase, and the deliverable's type,
hash and schemaUrl), the pattern, the artifact the commit phase selects,
and the parties against the Listing's seller. An Agreement both parties
signed, and the seller anchored, whose terms are not the Listing's (2 DEM
under a 1 DEM Listing, another rail, another deliverable) is refused
(`continuation_agreement_invalid`, detail `LISTING-TERMS`, with the
verifier's error as its `cause`): a finalized record does not show that the
commitment gate ran. This holds on every seller payment and delivery continuation route and at both buyer
signers, so a record the gate anchored and then refused after finality, read
back later, continues nothing.
A proposal, commitment or context request is always a new purchase. A reader therefore returns an ended
window as it is; it still throws for a revoked, missing or unavailable
Listing, and every other proof check applies.

A buyer's proof can still say `ready: true` for up to ten minutes after the
seller drains, so the seller enforces its own current state: `checkWireRequest`
requires `ready` (whether it accepts new purchases now) on the proposal,
commitment, commitment-signature and context routes and refuses each while it
is `false` (`seller_not_ready`, 503). On the payment and delivery routes it
requires the job's finalized commitment instead, checked the same way with
the seller's own receipt reader. Read routes enforce retained request scope
without repeating CA-7; successful readback authentication does not attest an Agreement.

`capabilities` states the TP-1 restrictions: FP-DEM; `negotiate-fixed-price`;
`pay-dem`; `did:demos:agent` claims; delivery through Demos storage at
`dacs4:deliverable:{jobId}`; `fixed-text` and configured pure, synchronous text
modules only; the existing bounded report envelope
(`dacs-chatgpt-plugin/devnet-purchased-report`, report version `"1"`,
`text/plain; charset=utf-8`, at most 16,384 characters, synchronous:
`TP1_CAPABILITIES` in `src/wire/profile.ts`; that the plugins' producer accepts
only this is taken from the plugin implementation); no buyer request input. A
document stating anything else is refused. `FP-DEM` and the delivery channel
name `demos-storage` are SDK labels, not Standard identifiers. The Standard
calls this delivery phase `deliver-storage-program`
(`spec/DACS-4-SETTLE.md:831` at `d45c0a2`).
