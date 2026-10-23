# Fixed-price agreement traceability

This layer is a transport-independent DACS-3 core. It accepts only a normative
Listing with an explicit `verified` disposition and produces the exact
`AgreementDocument` or `PayeeBoundAgreementDocument` selected by its pipeline.
It performs no anchoring, payment, delivery, network transport, or private
repository call.

| SDK rule | Normative source |
| --- | --- |
| Exact `AgreementDocument`, `PayeeBoundAgreementDocument`, party, terms, fee, payout, and signature types | DACS-3 §8.5–§8.5.3 |
| Fixed pricing is copied exactly; negotiable pricing deterministically selects the exact `bandCenter`; auction and metered variants fail closed until a handler accepts and validates their required terms instead of inventing a price | DACS-3 §8.4.1; §8.5.2 checks 1–2; MTR-1..MTR-5; CORE §11.1.2 |
| Exactly one fixed-price phase followed immediately by one supported agreement commitment phase | DACS-3 §8.8 PS-1–PS-3 |
| Agreement pins the immutable `(listingId, version, contentHash)` tuple | DACS-1 §6.3.4 LR-1; DACS-3 §8.5.2 check 4 |
| Buyer/seller claims, post-Vet bundle hashes, and exact Vet references are signed agreement inputs | DACS-3 §8.4.1; §8.5 `AgreementParty` |
| Deliverable reference hashes the Listing's anchored `offering.deliverable` bytes | DACS-4 §9.3 `DeliverableRef`; DACS-3 §8.5.2 check 5 |
| A complete selected rail must exactly match `acceptedRails` and every pay phase; zero-pay pipelines omit it | DACS-3 §8.5.2 check 3; DACS-4 §9.5.1 PC-2 |
| Payee-bound agreements cover every pay-phase tuple exactly once and legacy agreements reject payout bindings | DACS-3 §8.5; DACS-4 §9.5.1 PB-1 |
| Artifact discriminator, required payout-binding, and duplicate-tuple behavior is exercised against `payee-destination-binding-v0.1.json` | DACS-3 §8.5 compatibility; DACS-4 §9.5.1 PB-1–PB-3 |
| Provisional deadline derives from `generatedAt + deadlineSecAfterCommit` | DACS-3 §8.4.1; §8.5.2 check 7 |
| Buyer and seller sign the signature-free agreement hash under the artifact-specific domain; Base64URL is canonical and unpadded | DACS-3 §8.5.1; CORE §B.7 SIG-2/SIG-6 |
| Unknown/unsupported pricing and auto-accept without its verified commitment plus live instance signature fail closed | DACS-3 §8.4.1; §8.5.2 MTR-5; CORE §11.1.2 |
| Early SDK buyer-only agreements are read only as `LegacyMvpAgreementDocument`; they are never exposed as normative writes | CORE §11.1.2 |
| Optional caller `additionalTerms` is carried into `terms.additionalTerms` (string values NFC-normalised by the canonical snapshot, member names unchanged) under both signatures and the agreement hash, and never changes another term; omitted, the Agreement bytes are unchanged | DACS-3 §8.5 `AgreementTerms` / `PayeeBoundAgreementTerms`; §8.5.1 |

The finalized agreement commitment, authoritative `committedAt` checks, and the
barrier before irreversible settlement remain owned by #99. The auto-accept
commitment/instance-signature recipe also remains a separate focused branch;
this core refuses to reinterpret a normal agreement signature as that recipe.

## Additional terms

DACS-3 §8.5 gives every Agreement artifact shape an open
`additionalTerms?: Record<string, unknown>`. This SDK produces and reads two of
those shapes, `AgreementDocument` and `PayeeBoundAgreementDocument`; it does not
implement the identity-bound shapes (see
[presence conformance adoption](presence-conformance-adoption.md)).
`FixedPriceAgreementInput` accepts the record as
`additionalTerms`; `deriveFixedPriceAgreement` copies its canonical snapshot
into `terms.additionalTerms`. The snapshot NFC-normalises string values (CORE §B.2
CF-1) and leaves member names unchanged, so an NFD value comes back NFC. The
record is therefore inside the §8.5.1 canonical form,
the agreement hash, and both signatures. No price, deliverable, rail, deadline,
metered quantity, or payout check reads it.

Omit the member to get an Agreement byte-identical to one derived before this
field existed; `terms` then has no `additionalTerms` key. An explicit
`undefined` is refused, as for every other optional member of this input.

The producer applies a narrower profile than the Standard's open record, so two
parties derive the same bytes, every value survives the two-party exchange, and
an entry cannot reuse an exact top-level §8.5 term member name:

| Rule | Limit | Why |
| --- | --- | --- |
| Value | Top level: an exact JSON record (`isExactJsonRecord`) after the canonical snapshot, never an array or `null`. Inside it, entries and nested members may be any JSON value, including arrays and `null`. At any depth, refused: `undefined`, functions, `NaN`/infinities, `-0`, BigInt, accessors, proxies, cycles, symbols, lone surrogates, non-plain prototypes, and every number that is not a safe integer (`4.5`, `0.1`, `1e21`, and `2**53` are refused; carry decimals as strings) | The bytes must be the JSON both parties hash (CORE §B.2). CORE's number rule allows fractions, but the signing plan, durable exchange, and seller responder carry only safe integers, so a fraction would sign locally and then fail to exchange |
| Empty record | Refused | `{}` and omission would be two byte-different Agreements with the same meaning |
| Top-level key | `<namespace>:<name>:v<n>`, at most 128 characters: namespace `[a-z0-9]+([.-][a-z0-9]+)*`, name `[a-z0-9]+(-[a-z0-9]+)*`, version a positive integer without leading zeros | Independent extensions cannot collide; a reader can recognise a key it does not support; a new version is a new key, never a silent change. CF-1 does not normalise member names, so case or non-ASCII freedom would allow byte-different spellings of one visible key |
| Shadowing | Namespace `dacs`, and every dotted namespace under it (`dacs.<...>`), is reserved by this SDK (the Standard defines no namespaces); other labels such as `dacs-chatgpt-plugin` or `dacsx` are ordinary namespaces. A name that spells a §8.5 term member once hyphens are removed (`deliverable`, `price`, `metered-quantity`, `rail`, `deadline`, `price-anchor`, `fee-schedule`, `payout-bindings`, `prior-payment-disposition-ref`, `additional-terms`) is refused | An entry cannot reuse an exact top-level §8.5 term member name. This is a name check only; see below |
| Size | Canonical UTF-8 form at most 8,192 bytes | A local limit: the terms ride inside every anchored SR-2 Agreement and are re-sent at each exchange step. It is well inside the Storage Program limit (128 KB soft limit in the pinned Standard; 1 MiB enforced by Demos node `ac8f45f02fc9c25082ce9b83595c2e3916b49c5a`, which `@kynesyslabs/demosdk` 4.0.16 checks only through its opt-in `StorageProgram.validateSize`; its `createStorageProgram` does not call it) and half of the 16 KiB DACS-1 LR-2 Listing cap |
| Depth | At most 8 container levels, counting the record itself | Independent readers recurse a bounded amount, well inside the 128-level canonical-form cap |
| Member names | `__proto__`, `constructor`, and `prototype` are refused at any depth | Inert as JSON, but they rebind prototypes in a consumer that merges entries by assignment |
| U+0000 | Refused in every string value and member name, at any depth | Demos node `ac8f45f02fc9c25082ce9b83595c2e3916b49c5a` stores anchored data in a PostgreSQL `jsonb` column, which rejects U+0000, so such an Agreement could be co-signed but never anchored |

Only `deriveFixedPriceAgreement` applies this profile.
`createFixedPriceAgreementSigningPlan` and `signFixedPriceAgreement` take a
draft as given and apply the reader checks (the signing plan also refuses
numbers that are not safe integers), so a draft built by hand can carry an
un-namespaced key, an oversized or over-deep record, a prototype member name,
or U+0000, and such an Agreement may not anchor. Build drafts with
`deriveFixedPriceAgreement`.

**Consumers must never read a §8.5 term from `additionalTerms`.** The
Agreement's price, rail, deadline, payout, deliverable, and Vet result are the
§8.5 members outside `additionalTerms`, and nothing else. The shadowing rule
compares names only. An entry such as `acme:payment-details:v1` may still
contain `price`, `rail`, or `deadline` members, and free text may describe
anything. The Standard itself puts pattern-specific data there (DACS-3 lets
an RFQ or sealed-envelope Agreement carry `competitiveContext` in it), but
never one of those terms. Never flatten or merge `additionalTerms` into the
§8.5 terms, and show each entry under its full key, apart from the Standard
terms, in any user interface or model prompt.

Example:

```ts
deriveFixedPriceAgreement({
  ...input,
  additionalTerms: {
    "dacs-chatgpt-plugin:public-service-request:v1": { request, requestHash },
  },
});
```

**The seller must resolve the same terms itself.**
`respondToFixedPriceAgreementProposalDurable` re-derives the plan from the
seller's own `resolveAuthenticatedAgreementContext` result, including its
`additionalTerms`, and accepts the proposal only if that plan equals the
offered one exactly. Both plans are canonical, so the comparison is of
canonical values: string values compare after NFC normalisation (CORE §B.2
CF-1), and member names compare exactly as written. A buyer entry the seller
context lacks, a seller entry the buyer omitted, or any difference in a
canonical value or member name rejects the proposal at the `context` stage
before any seller signature. The query's `candidateDraft` shows the
buyer's proposed entries; a resolver may read them as untrusted input, but it
must return only entries that seller policy admits (known key, schema, limits,
recomputed hashes). Copying them unchecked signs whatever the buyer wrote.

A resolver that admits one request entry rebuilds it rather than returning the
buyer's object:

```ts
const REQUEST_KEY = "dacs-chatgpt-plugin:public-service-request:v1";

resolveAuthenticatedAgreementContext: async (query) => {
  // Listing, identities, Vet refs, rail, payout, and clock from seller state.
  if (query.queryVersion !== "1") {
    return { disposition: "rejected", reason: "unsupported query version" };
  }
  const context = await authenticatedSellerContext(query);
  const offered = query.candidateDraft.terms.additionalTerms;
  if (offered === undefined) return { disposition: "present", value: context };
  if (Object.keys(offered).length !== 1 || !Object.hasOwn(offered, REQUEST_KEY)) {
    return { disposition: "rejected", reason: "unsupported additional terms" };
  }
  // Buyer data: the entry may be any JSON value, including null or an array.
  const entry: unknown = offered[REQUEST_KEY];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { disposition: "rejected", reason: "request fails seller policy" };
  }
  // Seller-owned schema and limits; returns a fresh value holding only the
  // admitted fields, or undefined. It never throws on buyer data.
  const request = admitPublicServiceRequest(
    (entry as { request?: unknown }).request,
  );
  if (request === undefined) {
    return { disposition: "rejected", reason: "request fails seller policy" };
  }
  return {
    disposition: "present",
    value: {
      ...context,
      additionalTerms: {
        // Hash recomputed by the seller, never copied from the buyer.
        [REQUEST_KEY]: { request, requestHash: sha256Hex(canonicalize(request)) },
      },
    },
  };
},
```

If the buyer's entry carried an extra field or a different `requestHash`, the
rebuilt entry differs and the exact plan comparison rejects the proposal.
The producer requires only the top level of `additionalTerms` to be a record,
so check the shape of every buyer value before reading a member of it. A
resolver that throws makes the proposal `indeterminate` (retryable), not
`rejected`.

`isAgreementArtifact` and `validateFixedPriceAgreementBinding` accept exact
JSON records in `terms.additionalTerms`, including one another conforming producer signed
outside this profile (for example an in-bound fraction such as `4.5`), and
refuse anything else. One existing reader limitation remains: a parsed `-0`
is refused, although CORE CF-5 permits negative zero. The producer profile
above describes what this SDK produces; readers also admit in-bound fractions.
