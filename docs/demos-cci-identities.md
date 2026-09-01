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
remain inspectable only in `raw`.

Reverse lookup currently follows the operations exported by Demos SDK:

```ts
await agent.findByClaim("cci-web2:github:alice");
await agent.findByClaim("cci-xm:evm:base-sepolia:0x...");
```

The current Demos SDK does not expose equivalent reverse routines for domain,
UD, PQC, Nomis, Human Passport, Ethos, or TLSN claims. Those inputs fail closed
instead of being mapped onto a different lookup.

## Authenticate before reputation use

Parsing establishes shape, not source authority. The SDK therefore requires a
capability that authenticates the exact captured GCR response and its subject
binding before native scores can reach Vet:

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

Freshness ceilings are mandatory and source-specific. `observedAt` comes from
the native score record (`lastSyncedAt` or `verifiedAt`), not from local read
time. Human Passport signals additionally require `passingScore === true` and
an unexpired score. Omissions are explicit and never converted into zero or a
negative reputation signal.

The authentication callback is deliberately not replaced by a boolean or by
the Demos RPC response code. Deployments choose the current-state/finality
provider appropriate to their trust model and retain its evidence coordinates
in the branded record's provenance.

## TLSN method separation

A TLSNotary proof registered in CCI was already checked by the Demos GCR
routine. It must not be sent through DACS-2's external `tlsnotary` method again.
Use `classifyCciTlsnProof()` with the authenticated CCI record, the exact
IdentityBundle, and the same BP-4 presentation verifier used by party Vet. The
function returns `native-cci` only when the bundle presenter matches the CCI
subject and the same proof hash is present in both sources. Otherwise it returns
`external-required` for an unregistered/session proof or `invalid` for a broken
trust binding.
