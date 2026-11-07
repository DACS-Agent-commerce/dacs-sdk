# Demos CCI identity integration

The SDK projects the complete production `GCRMain.identities` surface returned
by Demos `getIdentities`. This is a read/projection API: it does not link,
remove, refresh, or fund an identity. It is not free of node side effects:
in the public node source (`kynesyslabs/node` `testnet` at `ac8f45f`),
`getIdentities` creates an empty GCR account for an address the node has not
seen. Resolving arbitrary addresses therefore grows that node's state. The SDK
sends the request demosdk sends and cannot prevent this.

| Demos context | SDK claim | Canonical reference |
| --- | --- | --- |
| `xm.<chain>.<subchain>[]` | `CciWalletClaim` | `cci-xm:<chain>:<subchain>:<address>` |
| `web2.<platform>[]` | `CciWeb2Claim` | `cci-web2:<platform>:<username>` |
| `web2.domain[]` | `CciWeb2Claim` | `domain:<canonical-host>` |
| `pqc.<algorithm>[]` | `CciPqcClaim` | `cci-pqc:<algorithm>:<public-key>` |
| `ud[]` | `CciUdClaim` | `cci-ud:<domain>` |
| `nomis.<chain>.<subchain>[]` | `CciNomisClaim` | `cci-nomis:<address>` |
| `humanpassport[]` | `CciHumanPassportClaim` | `cci-humanpassport:<verified-address>` |
| `ethos.<chain>.<subchain>[]` | `CciEthosClaim` | `cci-ethos:<profile-id>` |
| TLSN-marked `web2` entry | `CciTlsnClaim` | `cci-tlsn:<proof-hash>` |

TLSN currently lives in a Demos Web2 bucket with `proofType: "tlsn"`; the SDK
emits both its Web2 identity claim and its native proof-commitment claim. It
does not expose the full proof through `CciTlsnClaim`.

## Resolve and inspect

```ts
const record = await agent.resolveIdentity(counterpartyPrimaryClaim);

for (const claim of record.claims) {
  console.log(claim.kind, claim.ref);
}
```

`parseCciRecord()` rejects accessors, proxies, sparse arrays, exotic
prototypes, cycles, unsupported numeric values, and other non-JSON views before
reading fields. Its `raw` member is an owned snapshot, not the caller's object.
Malformed/incomplete context entries are omitted from typed claim arrays and
remain inspectable only in `raw`. Conflicting entries for one canonical
reference fail closed; exact duplicates are collapsed deterministically.

The decoded response is bounded before snapshotting: 2 MiB encoded-size
budget, depth 32, 20,000 nodes, 4,096 entries per array, 1,024 keys per object,
and 512 KiB per string. `DemosAdapter.resolveIdentity()` applies the same
decoded-value bound at its substrate boundary.

For GCR identity reads, the adapter also caps the raw HTTP response body at
2 MiB (2,097,152 bytes) before UTF-8 or JSON decoding. It checks a declared
`Content-Length` and counts the streamed bytes even when that header is missing,
invalid, or understates the body. The count covers the bytes delivered by Fetch,
including decompressed bytes. On overflow it cancels the body, retains no raw
payload, and throws a permanent `DacsError` with the stable message
`Demos GCR identity response exceeds maxResponseBytes`. A body exactly at the
ceiling is admitted, subject to the existing structural limits.

Each attempt has a 5,000 ms deadline by default. Set
`DemosAdapterConfig.identityTimeoutMs` to a positive safe integer up to 30,000 ms
(validated at construction) for slower nodes. The whole lookup is still capped
by `identityTotalTimeoutMs` (12,000 ms by default, below), so an attempt deadline
above it is cut short: `identityTimeoutMs: 20000` alone gives one attempt that
is aborted at 12 s. For slower nodes, raise both together. The deadline covers
fresh header signing, connection establishment, response headers, and the
complete body read; receiving headers or chunks does not reset it. Every attempt
uses a fresh `AbortController` and regenerates timestamp-bound authentication
headers.

The adapter retries transient failures at most twice (three attempts): attempt
timeouts, connection errors `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`
(including Fetch `TypeError` with one of those `cause.code` values), and HTTP
502/503/504. It also retries a Fetch `TypeError` whose `cause.code` is
`UND_ERR_SOCKET` (the node closed the connection, for example while restarting)
or `UND_ERR_CONNECT_TIMEOUT`, but only before any response has arrived; demosdk's
Axios transport reported the first as `ECONNRESET`. Once a response has
started, no connection failure is retried: a connection closed or reset during
the body, with any of the codes above, ends the lookup. Backoff is 250 ms then 500 ms. `Retry-After` can
lengthen that wait, up to 2,000 ms, but never shorten it: the wait is
`max(backoff, min(Retry-After, 2,000 ms))`. Only whole seconds (`^\d+$`) or an
HTTP-date in one of the three forms RFC 9110 §5.6.7 requires recipients to
accept are used: IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), RFC 850
(`Sunday, 06-Nov-94 08:49:37 GMT`, where a timestamp more than 50 years ahead
names the previous century) or asctime (`Sun Nov  6 08:49:37 1994`). Second
60, a leap second, is taken as the instant after second 59.
A date must be exact, including its weekday; any other value is ignored. Size overflow, redirects, invalid UTF-8/JSON, all 4xx
(including 429), and other 5xx are never retried. Failed bodies are cancelled
without retaining response text.

`DemosAdapterConfig.identityTotalTimeoutMs` bounds the whole lookup, including
signing, reads, retries and waits: 12,000 ms by default, a positive safe integer
up to 90,000 ms, validated at construction. Reaching it aborts the active
attempt, and a backoff wait that would leave the next attempt no time is not
started. A lookup therefore ends within
`min(3 × identityTimeoutMs + 2,750 ms, identityTotalTimeoutMs)`: 12,000 ms with
the defaults, which allows two full five-second attempts and a shortened third.
The deadline is also checked against a monotonic clock before each attempt,
after header signing immediately before the request, and before a response is
accepted. An occupied JavaScript event loop can delay when a lookup settles, but
once the deadline has passed no further request is sent and no result is
accepted; the lookup ends in the timeout error below.

dacs-node's built-in peer resolvers accept only a self-certifying
`did:demos:agent:` authority, which resolves locally without this read. A
custom resolver that calls `agent.resolveIdentity()` or
`resolveAuthenticatedIdentity()` for an inbound peer does read CCI inside that
peer's HTTP request, and the peer aborts the request after 15 seconds
(`DEFAULT_REQUEST_TIMEOUT_MS`). The 12-second default keeps a slow or restarting
Demos node from making the sender give up and resend. Keep
`identityTotalTimeoutMs` below the dacs-node request timeout if you raise it
for such a resolver.

| Demos node | Defaults (5 s per attempt, 12 s overall) | `identityTimeoutMs: 8000` (12 s overall) |
| --- | --- | --- |
| Healthy | First response, no wait | First response, no wait |
| Slow (replies after 6 s) | Three attempts time out; fails at 12.0 s | Succeeds at 6 s on the first attempt |
| Silent (never replies) | Fails at 12.0 s: 5 + 0.25 + 5 + 0.5 + 1.25 s | Fails at 12.0 s: 8 + 0.25 + 3.75 s |
| Flapping (one 503 or reset) | Recovers after 0.25 s, or up to 2 s with `Retry-After` | Same |
| Restarting (refuses or closes the connection) | Recovers on attempt 2 or 3 (after 0.25 s or 0.75 s of backoff) | Same |
| Dead (refuses connections) | Fails after 0.75 s plus connect time | Same |

On expiry the adapter aborts the request and cancels an active body reader.
Exhausted retries throw `TransientError` (category `transient`), with the stable
message `Demos GCR identity read timed out` when the last attempt timed out
(or the overall deadline expires), or
`Demos GCR identity read failed after transient transport errors` for exhausted
HTTP 502/503/504 or connection failures, a connection closed or reset during
the body, or when a wait no longer fits before the overall deadline after one
of those.
These errors contain no response text or cause. Any other failure of the request
or of the body read, such as an unreachable host or a malformed HTTP response,
is not retried and throws `SubstrateError` (category `substrate`) with the stable
message `Demos GCR identity read failed`; it carries no cause, node bytes or
socket address. Errors from signing the authentication headers are local and
pass through unchanged. Deadlines also bound an injected
transport that ignores abort, stalled signing, or body cancellation that never
settles; no request is sent once signing outlasts its deadline, and late
responses are cancelled without decoding.

Identity requests use Fetch's `redirect: "manual"`, so a redirect is never
followed and reaches the adapter as its 3xx response. The adapter rejects a
response with any 3xx status, marked `redirected`, or of type `opaqueredirect`,
including one returned by an injected transport, before reading or decoding its
body. It cancels that body and throws a permanent `DacsError` with the stable
message `Demos GCR identity response redirect refused`.

`DemosAdapterConfig.identityMaxResponseBytes` can tighten the raw ceiling to a
positive safe integer; values above the hard maximum of 2,097,152 are rejected
at construction. The default is also the hard maximum. The raw reader copies
the body into one buffer that starts at 64 KiB (or the ceiling, if smaller) and
at least doubles, never beyond the ceiling, only when received bytes need the
room. A small response therefore holds 64 KiB, not the ceiling; at its peak,
while the buffer is copied into a larger one, a read holds under twice the
ceiling, plus the one transport chunk that is checked before it is copied.
Empty chunks are discarded, and tiny chunks do not add retained allocations.
Structural
limits remain fixed. `DemosAdapterConfig.identityFetch` optionally injects a Fetch-compatible
raw response transport for CCI reads; it must return a streamed `Response`,
without decoding or prebuffering the body. The adapter owns byte counting and
decoding even with an injected transport. The default uses the SDK's imported
Undici Fetch with a private, unconfigured direct `Agent` and
preserves demosdk's `gcr_routine` request and wallet authentication headers.
Other HTTP failures throw `SubstrateError`; invalid UTF-8/JSON fails closed without
retaining response text in the error. Self-certifying primary Demos agent DIDs
continue to resolve locally.

Two differences between Fetch and demosdk's Axios transport are handled
explicitly:

- **Credentials in the RPC URL.** Fetch refuses a URL such as
  `https://user:pass@node.example/`. The adapter removes the credentials from
  the URL and sends them as `Authorization: Basic` with the percent-decoded
  `user:password`, as Axios does. This also applies to an injected
  `identityFetch`. No error message contains the URL or its credentials.
- **Proxies.** Axios honours `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and
  `NO_PROXY` (either case, lowercase first), and also bypasses the proxy for
  a loopback host when `NO_PROXY` names any loopback host. Node's global
  `fetch` ignores those variables unless Node's proxy switch
  (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy`, Node 22.21 or later) installed
  a proxy agent at startup. That agent's rules are not Axios's, and they
  differ between Node releases: Node 22 has no loopback rule and sends an
  HTTPS URL through `HTTP_PROXY`, Node 24 and 26 also match subdomains of a
  `NO_PROXY` entry, and Node 26 forward-proxies `http://` URLs. The switch
  also makes Node proxy Axios's own direct connections, using a copy of the
  environment taken at startup and Node's `NO_PROXY` rules. It also breaks
  demosdk's own requests to an `http://` RPC through a proxy: Node 22
  rewrites the target port, and Node 24 and 26 reject the request.
  So without an injected `identityFetch`, the adapter does not try to predict
  Node's proxy agent. It uses its private direct transport only where Axios
  also connects directly, with conservative compatibility checks: a global
  `fetch` with Node's complete normalized source, a global dispatcher shaped
  like Node's default, the switch off, Node's plain `http`/`https` global
  agents without custom connection/request methods or route-changing options, and no environment
  proxy that Axios applies to the RPC URL. It never calls the global `fetch`
  or dispatches through the global dispatcher. A replaced, wrapped, bound or
  `Proxy` global `fetch` counts as custom, whatever dispatcher is installed,
  because it may route anywhere.
  Node's default dispatcher means the undici `Agent` that Node itself creates
  with `new Agent()`. An `Agent` given a `connect` function (as fetch-socks
  installs it), a `factory`, a socket path or another stored option, a
  subclass, or a composed `Agent` counts as custom, for the same reason.
  These compatibility checks read the objects' shape, class names and the
  complete source text of `fetch` and of the `Agent`'s factory, ignoring
  whitespace and semicolons (and comments in Fetch). Source text cannot prove
  which closures a function uses: exact-source replacements, undici 6's
  `maxRedirections` (kept outside its stored options), or later changes to an
  Agent's internals may pass. Such globals still cannot receive an automatic
  CCI request: the SDK always supplies its own private direct dispatcher to
  its imported Fetch. The package is loaded lazily after Node's own Fetch
  implementation, preserving Node's global dispatcher on Node 20 as well.
  Custom connectors or request methods on Node's global HTTP(S) Agents and
  route-changing options such as `lookup`, `host`, or `socketPath` require an
  injected `identityFetch`; ordinary pool settings such as `keepAlive` are allowed.
  When a compatibility check fails, identity reads
  throw a permanent `DacsError` before signing or sending anything: `Demos GCR
  identity read would bypass the environment proxy; inject identityFetch` when
  Axios would use a proxy, or `Demos GCR identity read cannot verify its route
  with Node's proxy switch or a custom global fetch, dispatcher or agent;
  inject identityFetch`.
  To read through a proxy, inject an `identityFetch` that uses one: as
  `DemosAdapterConfig.identityFetch`, as `AgentConfig.identityFetch` for
  `createAgent()`, or as the `identityFetch` option of dacs-node's
  `createDacsDemosActorRuntimeV1` and live role runtime. Projects generated by
  `create-dacs-agent` call those runtimes without it, so behind a proxy add
  `identityFetch` to those calls in the generated code. For example, with the
  `undici` package (also a dependency of this SDK; add it as a direct dependency
  of your application when importing it; use `undici@7` on Node 20):

  ```ts
  import { fetch as undiciFetch, ProxyAgent } from "undici";

  const dispatcher = new ProxyAgent(process.env.HTTPS_PROXY!);
  const identityFetch = ((input: string, init?: RequestInit) =>
    undiciFetch(input, { ...init, dispatcher } as never)) as unknown as typeof fetch;
  const adapter = new DemosAdapter({ rpc, identityFetch });
  ```

  `identityFetch: fetch` sends through whatever global dispatcher is
  installed. Either way, choosing the route is then up to you.

The wallet authentication headers are those of demosdk's `rpcCall`: a test
compares them with the installed demosdk and requires the locked 4.0.16. They
match the node verifier of `kynesyslabs/node` commit `3e62225` with the
`nonceEnforcement` fork active, which checks a signature over
`UTF8(SHA256hex(identity + ":" + timestamp))`, with the timestamp within five
minutes. The verifier on that repository's `testnet` branch (`ac8f45f`) checks a
signature over the public key alone and answers a wallet-connected read with HTTP 401; demosdk's own `getIdentities`
gets the same answer from such a node. Reads without a connected wallet send
no signature. An opt-in live check, `DACS_DEMOS_CCI_LIVE_RPC` with
`DACS_DEMOS_CCI_LIVE_ADDRESS` (an address that already has a GCR account),
runs one unauthenticated read in `test/substrate/demos-cci-live.test.ts`.
Behind a proxy, also set `DACS_DEMOS_CCI_LIVE_GLOBAL_FETCH=1` and start Node
22.21 or later with `NODE_USE_ENV_PROXY=1`, so the read goes through Node's
proxy agent.

Reverse lookup currently follows the operations exported by Demos SDK:

```ts
await agent.findByClaim("cci-web2:github:alice");
await agent.findByClaim("cci-xm:evm:base-sepolia:0x...");
```

The current Demos SDK does not expose equivalent reverse routines for domain,
UD, PQC, Nomis, Human Passport, Ethos, or TLSN claims. Those inputs fail closed
instead of being mapped onto a different lookup.

Reverse lookups still use Demos SDK's own `Identities` routines and transport,
so the raw response ceiling, deadline, and redirect refusal above do not apply
to them: Demos SDK decodes the whole HTTP/RPC response before this SDK sees it.
The adapter currently exposes no raw-byte or decoded account-list limit for
this path. Moving the reverse routines to a bounded transport is a known
follow-up.

## Authenticate before reputation use

Parsing establishes shape, not source authority. GCR state authentication also
does not prove that an external score provider verified the asserted subject.
The SDK therefore requires separate resolution and per-provider capabilities
before native scores can reach Vet:

```ts
import {
  authenticateDemosCciRecord,
  projectCciSupplementarySignals,
} from "@kynesyslabs/dacs";

const read = await authenticateDemosCciRecord(
  counterpartyPrimaryClaim,
  rawGcrResponse,
  {
    authenticateResolution: async ({ subject, raw }) => {
      const proof = await authenticateExactGcrState({ subject, raw });
      if (proof.status !== "authenticated") return proof;
      return {
        status: "authenticated",
        subject,
        observedAt: proof.observedAt,
        authority: proof.authority,
        evidence: proof.coordinates,
      };
    },
    authenticateProviderClaim: async ({ subject, claim }) => {
      const proof = await authenticateExactProviderClaim({ subject, claim });
      if (proof.status !== "verified") return proof;
      return {
        status: "verified",
        subject,
        claimRef: claim.ref,
        verifiedAt: proof.verifiedAt,
        authority: proof.authority,
        evidence: proof.coordinates,
      };
    },
  },
);

if (read.status !== "authenticated") {
  throw new Error(read.reason);
}

const projection = projectCciSupplementarySignals(read.record, {
  evaluatedAt: Date.now(),
  maxAgeSec: {
    nomis: 24 * 60 * 60,
    humanPassport: 24 * 60 * 60,
    ethos: 24 * 60 * 60,
  },
});

await partyVetCore(
  { ...request, supplementary: projection.signals },
  deps,
);
```

Without `authenticateProviderClaim`, the authenticated record remains usable
for presence but every provider score is omitted as `provider-unverified`.
Invalid, indeterminate, and failed provider checks have distinct omission
reasons.

Freshness ceilings are mandatory and source-specific. `observedAt` comes from
the native score record (`lastSyncedAt` or `verifiedAt`), not from local read
time. Human Passport signals additionally require `passingScore === true` and
an unexpired score. Omissions are explicit and never converted into zero or a
negative reputation signal.

The authentication callbacks are deliberately not replaced by a boolean or by
the Demos RPC response code. Deployments choose the current-state/finality and
provider-semantic authorities appropriate to their trust model.
The resolution authenticator receives the exact owned `raw` response. After it
succeeds, the branded record sets `raw` to `null`; only parsed claims and the
authenticated provenance/evidence remain in the trust-bearing object.

## TLSN method separation

A TLSNotary commitment registered in CCI must not be assumed current merely
because it exists in GCR. Use `classifyCciTlsnProof()` with the authenticated
CCI record, exact IdentityBundle, canonical active job ID, expected presenter,
active session nonce, expected TLS server, evaluation time, and explicit
resolution/proof/presentation freshness ceilings. Supply both the BP-4
presentation verifier
and a native TLSN verifier that authenticates the exact subject, job, session
nonce, bundle hash, proof hash and resolution provenance passed to it.

The function returns `native-cci` with retained verification provenance only
after both verifiers succeed. Historical GCR snapshots, missing/old TLSN
timestamps, old-session bundles, non-canonical job IDs and presenter
substitution fail closed. An unregistered session proof remains
`external-required` and may use the separate external `tlsnotary` recipe.

For the standalone classifier on the Agent surface, configure these
capabilities once under `AgentConfig.demosCci`, then call
`qualifyNativeCciTlsn()`. Its evaluation time comes from the trusted
`demosCci.nowMs` capability, not from caller-controlled request data:

```ts
const result = await agent.qualifyNativeCciTlsn({
  subject: counterpartyPrimaryClaim,
  bundle: counterpartyIdentityBundle,
  proofHash,
  context: {
    jobId,
    expectedPresenter: counterpartyPrimaryClaim,
    sessionNonce,
    expectedServer: "github.com",
    maxResolutionAgeSec: 60,
    maxProofAgeSec: 60,
    maxPresentationAgeSec: 60,
  },
});
```

The native verifier's successful result must echo the exact seven-field
binding supplied to it (`subject`, `jobId`, `sessionNonce`, `expectedServer`,
`bundleHash`, `proofHash`, and `resolutionObservedAt`). This prevents an
otherwise valid verifier result from being reused for different session
coordinates. The returned `native-cci` disposition retains that binding, its
exact trusted evaluation time, and verification provenance.

## Native CCI through normal Party Vet

Normal buyer/seller runtimes should use the combined Agent method. It performs
native qualification as a mandatory, generation-fenced step and then runs the
ordinary durable Party Vet producer:

```ts
const result = await agent.partyVetWithNativeCciTlsn(
  {
    vet: partyVetRequest,
    nativeCciTlsn: [{
      proofHash,
      // Load this independently from the active durable role session. Do not
      // derive the expected nonce from the counterparty's bundle.
      sessionNonce: activeSessionNonce,
      expectedServer: "github.com",
      maxResolutionAgeSec: 60,
      maxProofAgeSec: 60,
      maxPresentationAgeSec: 60,
    }],
  },
  partyVetDeps,
);
```

The method requires the independent session nonce to equal the signed bundle
nonce and requires the proof commitment to occur exactly once in that bundle.
The shared operation journal durably binds that presenter nonce to one exact
job and bundle, so reuse in a later job fails before native verification.
It samples `partyVetDeps.nowMs` inside the fenced qualification step and gives
that exact evaluation time to the Agent's native classifier. The returned
job, nonce, presenter, bundle hash, proof hash, server, observations,
verification time, evaluation time, and authority are checked again at the
Party Vet boundary.

Qualification is journalled under an exact input hash. A process restart or a
lost committed response therefore reuses the same result instead of calling
the native verifier again or producing timestamp-dependent evidence. The
compact provenance is encoded canonically in an SDK-reserved `cci-tlsn`
supplementary signal, bound into the final plan hash, and retained in the
signed, finalized CVR. Optional native verifier evidence is bounded to 256 KiB
and retained by hash rather than copied into the CVR.

Per DACS-2, supplementary signals remain advisory and cannot change
`overallDecision`; the combined method itself nevertheless treats a failed or
stale native qualification as a mandatory precondition and performs no Vet
method, signing, or anchoring work. `partyVetCore()` rejects caller-supplied
instances of the SDK-reserved signal. Registered native commitments also
remain prohibited as external `tlsnotary` recipe attempts.
