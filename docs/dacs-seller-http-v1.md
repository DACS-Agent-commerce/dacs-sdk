# `dacs-seller-http/v1`: the buyer-to-seller wire

> **Status: SDK wire definitions ready for review; composition qualification pending.**
> The implementation decisions below define this library change. Seller and
> client integration remains a release qualification requirement. The wire runs only
> under testnet profile TP-1 ([testnet-profile-tp1.md](testnet-profile-tp1.md)).

`@kynesyslabs/dacs/wire` defines the HTTPS wire between a buyer and a seller's
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
behaviour, the table names its own source and tests. Original-plugin captures are replayed by `test/wire/originalFixture.test.ts`
in the repository, with separately identified adaptations and immutable message bytes.
Other claims about the plugin still require composition qualification.

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
ship in `@kynesyslabs/dacs/wire` (`./wire`);
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

## The TP-1 profile member and identity gate

Every request, response, delegation and discovery document carries, inside
its signed bytes,
`profile: {id: "dacs-testnet-tp1", revision: "TP-1", base: "d45c0a29…0f20", chainIdentity, pinVersion}`.
`id`, `revision` and `base` (the full 40-hex Standard base commit) are the
profile tuple; `chainIdentity` and `pinVersion` are the approved record's pins. This
identity binding is approved, on 2026-10-15 at 21:23Z, as proposed: each party
requires an exact match with the tuple it selected locally and with the tuple
kept for that purchase, and a missing, unknown or mismatched value is refused
before any effect, with no fallback to admission on identifier and base alone.

When a payload has exactly the wire's members, a receiver checks its profile
before every other payload check and before the signature (a payload with
missing or extra members is refused as malformed first). In order, it refuses: no profile (`tp1_profile_missing`); a profile
without `revision` (`tp1_profile_revision_missing`), which includes the
pre-revision `{id, base, chainIdentity, pinVersion}` and a profile of
identifier and base alone; a revision this SDK does not define
(`tp1_profile_revision_unknown`), compared exactly against
`TP1_PROFILE_REVISIONS` (only `"TP-1"`), so `"tp-1"`, `" TP-1"`, `"TP-1 "`, a
number, `null`, a list, and a later revision's name such as `"TP-1.1"` are all
unknown; and any other difference from its own bound profile, an extra member
included (`tp1_profile_mismatch`). A revision given twice in the received bytes
is refused at admission (`wire_json_rejected`, `DUPLICATE-MEMBER`), so a second
value cannot hide behind the signed one. Signers apply the same check to the
payload they are given and sign only their own exact tuple. Endpoints are
deliberately not in the profile: two parties may use different RPC endpoints
for the same approved chain.

**The tuple kept for the purchase.** Each party also holds the tuple it kept
for the purchase, and requires it to be exactly its own bound profile, and so
exactly the profile of every message for that purchase (`assertPurchaseProfile`;
`tp1_purchase_profile_mismatch`).

- Buyer: `WireJobContext.profile` (required) is the tuple the buyer selected and
  kept for the job. `signWireRequest` signs nothing unless it is exactly the
  binding's profile. `verifyWireResponse` refuses, before it opens the answer,
  a kept request that names another tuple, and opens the answer under that
  tuple; the answer must then carry the same tuple as both the request and the
  buyer's binding. The buyer always has a kept tuple: `null` is refused.
- Seller: `openWireEnvelope`, `checkWireRequest` and `signWireResponse` each
  take a required `purchaseProfile`: the tuple the seller kept for the job, or
  `null` for a job with none kept yet (a new purchase; the seller then keeps
  the request's). Omitted, or any value but the seller's own bound profile, is
  refused before the header, the request or the body is read: no request is
  opened, and the seller's signer is not called. The opened request must then
  carry that same profile (`assertPeerProfile`), and `checkWireRequest` checks
  the kept tuple again before the exchange is compared.
- `signWireEnvelope`, which both signers call and which is exported, takes the
  same required `purchaseProfile` and checks it before the profile and before
  its signer. `null` passes only for a response (a seller's answer to a new
  purchase); a request is never signed without a kept tuple. It signs the
  `expiresAt` the payload carries: the 30 s signer lifetime is applied by
  `signWireRequest` and `signWireResponse`, so a host that calls
  `signWireEnvelope` directly must bound `expiresAt` itself.

With one revision defined, a message naming any other revision is unknown.
When a later SDK defines another revision, a party that selected or kept
`TP-1` refuses a message or purchase naming the other as `tp1_profile_mismatch`
or `tp1_purchase_profile_mismatch`; nothing is admitted on identifier and base
alone.

`chainIdentity` and `pinVersion` come from the approved immutable testnet
identity record. The integrator supplies the record; the SDK approves it.
`bindTp1Profile` checks the record's SHA-256 digest against the SDK's own
`TP1_APPROVED_IDENTITY_RECORD_DIGESTS` (`src/wire/approval.ts`, a frozen list)
and takes no approval list from its caller. The list pins the canonical digest
of `TP1_APPROVED_IDENTITY_RECORD`, approved by the owner on 2026-10-20:
record identifier and pin version `dacs-demos-testnet-identity/2026-10-21`,
source kind `confirmed-block-one-predecessor`, with its documented fallback.
The 2026-10-15 record, for the chain node2 served before its 2026-10-20
rebuild, is no longer listed and is refused.
The complete record and digest are in the [TP-1 declaration](testnet-profile-tp1.md#profile).
Actor-local endpoints and transport authorities are excluded. The gate refuses,
in order: no record;
a record without its pins; a malformed record; the plugin's simulated-fixture
chain identity (`DACS_STORAGE_ANCHOR_CHAIN_IDENTITY`, the SHA-256 of a fixture
string, which `TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES` derives) used as a live
pin; a refused identity; and any record
whose digest the SDK has not approved. Refused identities are the SDK's own
`TP1_REFUSED_CHAIN_IDENTITIES` (empty until a dated approval names any, for example a
known mainnet identity) plus any the caller adds; a caller can add refusals but
never remove one. A network label such as `"demos-testnet"` never authorizes
anything: a mocked mainnet identity labelled testnet is unapproved, with or
without a caller refusal list, and even when the caller passes its own
approval list.

The approved record identifies the allowed chain. Binding also requires a
`readAuthority: Tp1AuthorityReader` installed by the local verifier or
orchestrator, outside caller-controlled artifacts and HTTP phase input. It
must authenticate the active transport's chain independently of the approved
record. An endpoint string and a network label do not establish that fact.
The reader returns `{local, chainIdentity, provenance, sessionId, participants}`.
`local` includes the exact endpoint, transport authority and connection
generation; `provenance` identifies that connection's authenticated attestation.
The binding retains their digest and the reader in process-local state. A
missing reader, wrong chain, changed connection or changed attestation refuses
authorization. Two independently authenticated endpoints for the approved
chain remain usable.

Before signing or accepting a request, response or delegation, the wire asks
that same reader for both authenticated participants in their exact `jobId`
session. Discovery checks its seller in the `dacs-seller-discovery/v1` scope.
Each participant entry is `{claim, profile, modules}`: the authenticated claim,
the complete five-field wire profile, and exactly CORE 0.3, DACS-1 0.7,
DACS-2 0.6, DACS-3 0.5, DACS-4 0.8, DACS-5 0.5. These are independent local
authority, not additional wire members; the existing signed bytes are preserved.
The returned session and ordered participant list must match exactly, with no
missing or duplicate entry. A signed claim that names the right base cannot
override different authenticated module evidence.

The reader must consult current authenticated transport and participant/session
state on every call and refuse revoked, missing, ambiguous or unavailable
evidence. It must not echo the query or populate decisions from peer messages.
The query with `sessionId: null` and an empty participant list checks only the
connection, including at binding. It is not participant authorization. Every
use rechecks authority, including admission of an already opened request and
signing under a retained endpoint proof. Signers recheck after an asynchronous
signature before returning it. Reader exceptions preserve their original
causes. Reads performed by the integration, including through third-party
libraries, require a byte limit before decoding, bounded decoded lists and a
deadline. The wire itself performs no network I/O. Neither bindings nor a
saved successful decision are restart credentials; recreate a binding and
authenticate its current evidence after restart. Retained effect adapters still
require composition qualification.

`bindTp1Profile` reads each of its options once and takes one owned copy of
the record and of the local connection (`snapshotCanonicalJsonConfig`,
`src/canonical/snapshot.ts`) before any check. Every check, the approval
digest and the bound `chainIdentity` and `pinVersion` come from that copy, so
a record cannot be approved as one value and bound as another. A Proxy, an
accessor property or an exotic prototype is refused outright
(`tp1_identity_record_invalid`, `tp1_local_binding_invalid`), whatever it
answers; frozen plain data is accepted. String values are compared after CF-1
normalization, the form the approval digest has always covered. Verifiers copy
their current connection the same way, and `signWireRequest` copies a caller's delegation once. Received delegations at
`verifySellerSessionDelegation` must be bounded bytes or values from wire admission, so the payload checked,
returned, used to bound the request's expiry and embedded in the header is the
one whose signature verified (`peer_delegation_invalid` otherwise).

The named admission, signing, verification and profile boundaries below take
one owned, data-only copy of caller-built records and use that copy. This is
not a guarantee for every utility export: `wireOperationId` requires a trusted request,
and helpers outside these boundaries must be called with their documented input types.
- **Payloads, requests, delegations and profiles** are copied with
  `snapshotCanonicalJsonRead`, which accepts frozen plain data and refuses a
  Proxy, an accessor, an exotic prototype or an `undefined` member. So the
  profile a signer checks is the profile in the bytes it signs and in the
  header, document or delegation it returns. Each refuses with its own code:
  `peer_envelope_invalid` (`signWireEnvelope`, `wireEnvelopeSigningBytes`,
  `wireRequestHash`, and the request given to `signWireResponse` or
  `verifyWireResponse`), `peer_delegation_invalid` (both delegation signers),
  `discovery_invalid` (`signDiscoveryDocument`, `discoverySigningBytes`) and
  `tp1_profile_mismatch` (`assertPeerProfile`). The predicates
  `isTp1WireProfile` and `isWirePayload` answer `false` for such a value.
- **Options objects** (the signing context, `openWireEnvelope`'s options,
  `checkWireRequest`'s check, a delegation scope, `signWireRequest`'s input,
  the received response, `verifyEndpointProof`'s options and
  `bindTp1Profile`'s options) are read once, field by field, through their own
  data properties, so no getter or Proxy trap runs. A Proxy, an accessor or a
  prototype other than `Object.prototype` or `null` is refused
  (`wire_input_invalid`). The records inside them (a Listing pin, a job,
  the retained artifacts, a refusal list) are copied as above. The verified
  Listing is copied with `snapshotWireJsonRead`, which preserves its endpoint
  bytes without NFC normalization and refuses the same non-data inputs.
  Body bytes are copied once through the typed array's own slots. The body
  that is admitted is then the body that is hashed. A received body longer
  than its limit (64 KiB for a request, 512 KiB for an answer, by the view's
  own length) is refused as its admission refuses it (`bad_json` or
  `response_json_rejected`, detail `BYTE-LIMIT-EXCEEDED`) before it is
  copied, and so before any other check of that call.
- **What is not copied:** a binding and an opened envelope are proved by
  membership in a set the SDK holds, and are frozen. A signer is a callback:
  its `claim` is read once and `sign` called once.

No shipped module takes another approval list: there is no test entry point
in `src/` or `dist/`. Tests need bindings for synthetic records, so they
replace `src/wire/approval.ts` with `test/wire/testApproval.ts` through
`vi.mock`, and call the same `bindTp1Profile`. Current source-level approval
and boundary evidence is in `test/wire/approvedIdentity.test.ts`,
`test/wire/authority.test.ts` and `test/wire/networkIdentity.test.ts`.
Approval-import topology is checked in `test/wire/wire.test.ts`;
`test/wire/builtPackage.test.ts` runs the compiled package in a separate consumer process.

Every signing function (`signWireRequest`, `signWireResponse`,
`signWireEnvelope`, `signSellerSessionDelegation`,
`sellerSessionDelegationSigningBytes`, `signDiscoveryDocument`) first
requires a binding made by `bindTp1Profile` and
the signer's current local connection (`endpoint`, `transportAuthority`,
`connectionId`), which must equal the one the binding was made with. Changing
an actor's own endpoint, authority or connection invalidates its binding
(`tp1_local_binding_changed`) before its signer is called (the local connection fence);
the peer's endpoint is never compared. The three that sign a request or
response then require the tuple kept for the purchase, as above.

Every verification function (`openWireEnvelope`, `checkWireRequest`,
`verifySellerSessionDelegation`, `verifyWireResponse`, `verifyEndpointProof`)
requires the same: a binding made by `bindTp1Profile` and the verifier's
current connection (`local`), checked before anything is read.
`openWireEnvelope` then checks the tuple kept for the purchase before it reads
the header, and `checkWireRequest` checks it again before it compares the
exchange. A binding is
proved only by membership in a set private to `profile.ts` that
`bindTp1Profile` fills; an object carrying the same profile or fields, a copy,
a prototype child or a proxy of a binding is not a member
(`tp1_binding_required`). `assertPeerProfile` also refuses a non-binding and
rechecks connection authority using the binding's stored local connection.
The set and list lookups are taken from their prototypes
when the module loads, so a later patch of `Array`, `WeakSet` or `WeakMap`
prototypes does not open the gate. With the owned copies above, this holds
against callers, including a record, connection, payload, request, delegation
or options object whose answers change between reads, at binding, signing and
verifying alike. It is not a boundary against other code in the process: only
those set and list lookups are captured at load, so code that patches other
runtime methods after the SDK loads (for example `node:crypto` hashing, which
digests the identity record), replaces SDK modules through the loader or
patches the runtime before the SDK loads can open the gate, and could equally
call a signer directly.

## Exact-bytes admission (D7)

Every received signed or hashed wire input is admitted from its exact bytes
with `admitRawJson` (CF-5) before anything parses or hashes it, inside the
function that accepts it: the envelope header (`openWireEnvelope`), the request
body (`checkWireRequest`, through `admitWireRequestBody`), the response body
(`verifyWireResponse`, through `admitWireResponseBody`) and the discovery
document (`verifyEndpointProof`). Producers apply the same profile to the
bodies they sign. Admission refuses malformed UTF-8,
byte-order marks, duplicate member names, numbers outside the DACS magnitude,
non-JSON constants and nesting over 128. The wire adds one rule: every string
**value** must already be NFC (`WIRE-NON-NFC-STRING`), because CF-1 normalizes
values when canonicalizing and two different received values could otherwise
carry one signature. Member names are not normalized, as CF-1 requires.
Admission does not require JCS whitespace or member order. The plugin parsed
these inputs with `JSON.parse`: it accepted duplicate members and non-NFC
values, which this wire refuses.

## Refusal codes

Ported refusals keep the plugin's codes and HTTP statuses (`peer_*`,
`bad_json`, `bad_request`), except where the fault is the actor's own input.
A `WireError`'s `category` follows its status: 500 is the actor's own
configuration or input (`permanent`), 503 a state that may clear
(`transient`), and any other status the counterparty's. So the actor's own
kept tuple (`tp1_purchase_profile_mismatch`), a payload a signer built
itself, such as an answer status outside 200-599 (`peer_envelope_invalid`),
a delegation or discovery document a signer was given to sign
(`peer_delegation_invalid`, `discovery_invalid`), and a refusal of the
buyer's own delegation in `signWireRequest` (its code kept, such as
`peer_delegation_mismatch`) are 500, and signing under an endpoint proof whose document has since expired
(`discovery_expired`) is 503: fetch discovery again. New codes:

| Code | Meaning |
|---|---|
| `wire_json_rejected` (detail: admission code) | envelope header failed admission |
| `bad_json` (detail: admission code) | request body failed admission |
| `response_json_rejected` (detail: admission code) | response body failed admission |
| `outgoing_body_rejected` (detail: admission code) | a signer was given a body its peer would refuse |
| `seller_configuration_invalid` (500) | `checkWireRequest`'s `maxLifetimeMs` outside 1-60,000 ms; `signWireResponse`'s `lifetimeMs` outside 1-30,000 ms, or a `maxLifetimeMs` given to it |
| `tp1_profile_missing`, `tp1_profile_mismatch` | profile absent, or not the receiver's own |
| `tp1_profile_revision_missing`, `tp1_profile_revision_unknown` | profile without a revision, or naming a revision this SDK does not define (exact comparison) |
| `tp1_purchase_profile_mismatch` (500) | the tuple kept for the purchase is absent, `null` where only a seller's new purchase allows it, or not the actor's own bound profile |
| `tp1_identity_record_missing`, `tp1_identity_pin_missing`, `tp1_identity_record_invalid`, `tp1_identity_fixture`, `tp1_identity_refused`, `tp1_identity_unapproved` | identity gate |
| `tp1_binding_required`, `tp1_local_binding_changed`, `tp1_local_binding_invalid` | signing or verifying without a binding from `bindTp1Profile`, or on a changed connection |
| `tp1_authority_required`, `tp1_connection_unverified`, `tp1_participant_profile_mismatch` | missing trusted reader, unauthenticated/changed active connection, or mismatched authenticated participant/session profile and module evidence |
| `peer_request_unverified` | `checkWireRequest` given anything but an envelope `openWireEnvelope` verified under the same binding |
| `wire_input_invalid` | an options object, or a record or bytes inside one, that is not plain data (a Proxy, an accessor, an exotic prototype); a response opened without its `principal` |
| `discovery_*` | discovery document and endpoint proof |
| `endpoint_proof_required`, `endpoint_proof_mismatch` | a request signed without an endpoint proof `verifyEndpointProof` made under the signer's binding, or with one for another seller, endpoint or Listing pin |
| `seller_not_ready` (503) | the endpoint proof's document says `ready: false`, and no request is signed for a new purchase (any request but a continuing one with the job's finalized `commitment`); or `checkWireRequest` given `ready: false` for a proposal, commitment, commitment-signature or context request |
| `listing_eligibility_required`, `listing_eligibility_mismatch`, `listing_unsupported` | missing authenticated reader, a decision for another Listing scope, or unsupported/currently invalid selected terms |
| `seller_retained_agreement_required` (500) | `checkWireRequest` without the host's retained `{jobId, agreementHash, buyer, seller}`, or with a malformed one |
| `peer_job_mismatch`, `peer_agreement_mismatch` (409) | the signed `jobId` or `agreementHash` is not the one the host retained |
| `seller_replay_guard_required` (500) | an effect route checked without a `requestJournal` that `openWireRequestJournal` returned, or `completeWireEffect` given another object |
| `seller_replay_guard_invalid` (500) | a journal directory that is not absolute, missing, a link, owned by another user or writable by others, on which exclusive publishing fails, or holding an entry the journal did not write |
| `peer_request_replayed` (409) | the journal already holds the request's nonce key: the same signed request again |
| `seller_effect_pending` (503) | another attempt of the same operation (job and route) holds its live lease |
| `peer_operation_mismatch` (409) | an effect request for a job and route whose operation was first reserved under another Agreement hash, buyer or tuple |
| `seller_effect_unresolved` (500) | 16 attempts were superseded after their leases ran out |
| `seller_effect_conflict`, `seller_effect_superseded` (500) | `completeWireEffect` with an outcome other than the one recorded, or from an attempt a later one superseded |
| `seller_readiness_required` (500) | a proposal, commitment, commitment-signature or context request checked without the seller's own `ready`, or with anything but a boolean |
| `continuation_phase_unsupported` (500) | a `commitment` checked under a Listing commit phase other than `commit-payee-bound-agreement`, or none (DACS-3 §8.5.2 check 9); or whose Listing does not have exactly one pay phase, `pay-dem` (detail `PAY-PHASE`), or exactly one delivery phase, `deliver-storage-program` (detail `DELIVERY-PHASE`) |
| `continuation_listing_invalid` (500) | a `commitment` given without the signed Listing the request pins, as a value the wire did not admit (`ARTIFACT-NOT-ADMITTED`) or bytes admission refuses, or with a Listing that is not that pin's, not the seller's, not signed by the named seller claim's key over that pin (detail `LISTING-SIGNATURE`), not one fixed-price commitment, auto-accept or without a positive `deadlineSecAfterCommit`; whose deliverable is not `storage-program` (detail `DELIVERABLE-KIND`, DACS-4 §9.6.1 step 1); or whose pricing is not fixed in DEM (detail `TP1-PRICING`) |
| `wire_artifact_rejected` (500) | `admitWireArtifact` given bytes CF-5 admission refuses; the detail is admission's own code |
| `continuation_agreement_invalid` (500) | a `commitment` given without the Agreement it commits, as a value the wire did not admit (`ARTIFACT-NOT-ADMITTED`) or bytes admission refuses, or with one that is not an exact fixed-price PayeeBoundAgreementDocument (a plain or identity-bound one included, or one carrying another discriminator beside it: detail `DISCRIMINATOR`; or a `terms.priorPaymentDispositionRef`, which TP-1 has no `pay-alternative` phase for: detail `PRIOR-DISPOSITION`), whose content hash, job, Listing pin or parties differ from the record's, or whose buyer or seller signature does not verify (CA-7); or whose terms the SDK's DACS-3 §8.5.2 verifier refuses against the signed Listing at `committedAt` (currency, price, rail, deliverable, pattern, parties: detail `LISTING-TERMS`, its `cause` the verifier's error) |
| `continuation_commitment_invalid` (500) | a `commitment` given as a value the wire did not admit (`ARTIFACT-NOT-ADMITTED`) or as bytes admission refuses; or whose record, seller signature or finalized receipt does not check, whose receipt is not a CORE §5.1 AnchorReceipt or whose transaction reference is not a ChainTxRef, whose receipt time is before the Agreement's `generatedAt`, that is legacy or pending, that names another job, Agreement, buyer, seller or Listing pin, whose stated members differ from its evidence, whose receipt time is more than 30 s after the actor's clock, or that the receipt reader finds invalid |
| `commitment_reader_required`, `commitment_reader_invalid` (500) | a `commitment` given without a receipt reader, or a reader whose awaited result is not a disposition; synchronous and asynchronous readers are accepted |
| `commitment_reader_chain_mismatch` (500) | the trusted receipt reader's `chainIdentity` is absent or differs from the verified binding's chain; checked before invoking the reader |
| `commitment_unverified` (503) | the receipt reader answered `indeterminate` or `error`: the commitment is not established, never final |
| `seller_commitment_required` (500), `peer_agreement_uncommitted` (409) | a payment or delivery request checked without the job's commitment, or with `commitment: null` (the seller's own reader found none) |
| `peer_delegation_agreement_required`, `peer_delegation_agreement_mismatch` (409) | a delegated request without host-owned Agreement context, or with context naming another job, Listing or party |
| `peer_agreement_party_mismatch` (409) | a request whose signed buyer or seller is not the party the host retained, or a direct request whose host-owned Agreement context names another job, Listing or party |
| `peer_envelope_too_large`, `peer_response_too_large`, `body_too_large` (500) | a signer given a header, response body or request body over the limits: its own input, never the peer's fault; nothing is signed |
| `peer_signer_wrong` | a response signed by someone other than the expected seller, or a signer whose claim is not the answer's seller |

The plugin capture does not contain the codes in the rows above from
`seller_retained_agreement_required` down; they are new in this SDK.

## Current checks and planned compatibility evidence

Current admission, identity, envelope and response checks are in
`test/wire/admission.test.ts`, `test/wire/networkIdentity.test.ts`,
`test/wire/envelope.test.ts` and `test/wire/response.test.ts`.
The [compatibility vectors](../vectors/dacs-seller-http-v1.json) accompany this package.
Original-plugin captures, adaptations, generators and hash-pinning replay tests
are retained in the repository. Test paths here refer to repository evidence;
tests and historical capture tools are not installed runtime APIs.

### TP-1 reader restriction and purchase gates

TP-1 transport requires the canonical lowercase `did:demos:agent:` spelling.
Unlike the DACS-1 reader rule at the pinned base (lines 170–177), this wire
rejects `DID:demos:agent:…` instead of canonicalizing it. This is an explicit
transport deviation; callers canonicalize verified artifact claims before
building wire messages. Signed received payloads are never rewritten.

`signWireRequest` and request-kind `signWireEnvelope` require `endpointProof`
returned by `verifyEndpointProof`, the selected `publicEndpoint`, and `now`. A copied or caller-built proof is refused.
The proof must still be unexpired, under the buyer's same binding,
for the selected seller, Listing pin and byte-exact endpoint, with a current
authenticated eligibility decision from the retained reader; for a new
purchase it must also be ready and inside the Listing's window (a continuing
request with the job's finalized `commitment` continues; see the endpoint
proof section). Signing-byte
helpers describe transport bytes; purchase preparation uses the gated signers.

Expired session delegations are accepted only on the declared read routes.
`checkWireRequest` refuses every effect route with `peer_delegation_expired`
before returning a body to a handler, so a recorded outcome is answered
again only under a live delegation. After expiry, recovery uses the declared
read routes.


## Host validation requirements

The host supplies its own retained Agreement context and a restart-qualified
request journal separately from received wire messages.
These host requirements apply to both direct and delegated effect requests;
acceptance of a signature alone does not authorize repeating an effect.
The retained job and Agreement comparison is enforced by `checkWireRequest`
itself on every request. The only store is the request journal above
(`openWireRequestJournal`). No host journal, and no process-local set, is
accepted. Composition qualification must cover what the host
adds around it: durable local storage, reconciling on `recover`, and
recording each outcome with `completeWireEffect`.
