# Demos CCI identity integration

The SDK projects the complete production `GCRMain.identities` surface returned
by Demos `getIdentities`. This is a read/projection API: it does not link,
remove, refresh, or fund an identity.

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
decoded-value bound at its substrate boundary. The underlying transport must
additionally cap HTTP/RPC bytes before JSON decoding.

Reverse lookup currently follows the operations exported by Demos SDK:

```ts
await agent.findByClaim("cci-web2:github:alice");
await agent.findByClaim("cci-xm:evm:base-sepolia:0x...");
```

The current Demos SDK does not expose equivalent reverse routines for domain,
UD, PQC, Nomis, Human Passport, Ethos, or TLSN claims. Those inputs fail closed
instead of being mapped onto a different lookup.

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

For the normal Agent surface, configure these capabilities once under
`AgentConfig.demosCci`, then call `resolveAuthenticatedIdentity()` or the
combined current-session path. The evaluation time comes from the trusted
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
coordinates. The returned `native-cci` disposition retains that binding and
verification provenance for the downstream Vet integration.
