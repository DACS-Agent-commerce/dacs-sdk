# About the DACS testnet release

> **Draft.** This page is published with the SDK's testnet release. Until then,
> the "Blocked" items in the [TP-1 declaration](testnet-profile-tp1.md) apply.

**In short:** the testnet release lets a buyer's AI agent buy a fixed-price
text service from a seller's agent and pay for it in DEM on the Demos testnet.
It is a trial. Testnet DEM has no value, the release does not yet meet every
rule of the DACS Standard, and its external security review is on hold.

**Known problem: a failed payment can be reported as paid.** The SDK this draft is
built on treats an "included" status as paid without independently checking
execution. Node source inspection does not establish that the deployed node
reports failed payments as "included"; its status behaviour remains
unqualified. A separate SDK change, not yet in this draft, is meant to count a payment only once it executed; until it lands and
a composition review has checked it, do not rely on a payment being reported as paid (L2 and
G10 below). The checked current behaviour here is the buyer rail; a composition review must
separately check whether the seller's payment observer rejects failed
execution before delivery.

## The Standard and the release are separate

- **The DACS Standard** is the rulebook: it says what any DACS implementation
  must do. It lives in the DACS-Standard repository. This release does not
  change it.
- **The testnet release** is this SDK's seller kit and the buyer plugins,
  running on the Demos testnet. It is one implementation, measured against one
  revision of the Standard.
- **The TP-1 declaration** is where the release says how it measures up: which
  Standard revision it follows, what it does, and the ways it is known to
  fall short so far (composition checks qualify and complete that list). It has two parts: the [declaration](testnet-profile-tp1.md) and the
  machine-readable [register](../conformance/tp1-register.json). This page is
  the plain-language summary. Where they differ, the declaration is right.

Building the release also showed places where the Standard itself could be
clearer or more complete. The SDK's maintainers raise those with the
Standard's maintainers through the Standard's contribution process, under
which normative changes are merged by the Standard's steward after public
discussion. Such changes apply to everyone who implements DACS, not only to
this release.

## What it does

1. A seller runs its own agent at its own HTTPS address and publishes a
   Listing on the Demos testnet: one fixed-price text service, at a fixed
   price in DEM.
2. A buyer's agent reads that Listing from the chain and fetches the seller's
   discovery document from the address the Listing names. That first request
   is not signed; the discovery document it returns is. After it, every
   request and response between them, and any session delegation the buyer's
   wallet signs, is signed and names the TP-1 profile: its identifier, its
   revision (`TP-1`) and the Standard revision it is measured against. Each
   side refuses a message whose profile is missing, unknown or different from
   its own, or from the one it kept for that purchase, before acting on it.
   This rule was approved on 2026-10-15.
3. They record an Agreement.
4. The buyer pays in DEM on the Demos testnet.
5. The seller writes the result to Demos storage, and the buyer reads it. The
   purchase ends when the delivered result is verified.

The service is limited to fixed text, or a simple text module the seller has
set up (one that makes no outside calls and gives the same output for the same
input), up to 16,384 characters. The buyer cannot
send its own input to the service. Any other kind of Listing is refused before
anything is approved or signed.

## What it is not

- **Testnet scope.** The wire signs only for the approved testnet identity.
  The intended release must also refuse other identities before broadcasts;
  this has not been checked on the retained seller, browser or stdio paths,
  which do not yet consume the wire gate.
- **Not real money.** Testnet DEM has no value.
- **Not a live DACS profile.** The release's own label is "experimental
  testnet implementation; not a conformant live DACS profile".
- **Not security-reviewed.** The external security review is on hold.

## Where it falls short of the Standard

Each shortfall has an ID in the declaration. Where a user meets one, the
release is meant to show the label in the last column. Labels marked
"Intended" depend on a change that is not in this draft yet.

| ID | What it means | Label |
|---|---|---|
| L1 | The Standard revision it follows is not yet released for live use, so this is a testnet profile, not a release | "Testnet profile TP-1 · not a DACS live profile" |
| L2 | The SDK treats an included status as paid without independently checking execution. The deployed node's handling of execution failures is not qualified; source inspection does not establish that failed transfers are included. The release is meant to count a payment only once the testnet shows it executed; the Standard does not count a failed payment as settled either. That check is a separate SDK change that is not in this draft, and a composition review has not checked it, so today the buyer rail can report a failed payment as paid. The seller observer is separately not checked, for composition qualification. The release also does not independently prove the network's final agreement on a payment | Intended, pending the SDK's executed-payment check and composition qualification: "Payment executed on Demos testnet; BFT finality not independently proven". Until that check lands, this label would also appear on a failed payment reported as included |
| L3 | The release checks the Listing the buyer asked for, but cannot prove it is the latest version or that it is still current | "Listing currency not proven" |
| L4 | A seller's Demos agent key is self-certified: the Standard does not yet say how to prove who controls it | "Seller key: self-certified Demos agent key" |
| G1 | Agreement terms are stored where anyone can read them on testnet | "Agreement terms are publicly readable on testnet" |
| G5 | A purchase ends when the delivered result is verified; the final audit record is not produced | "Delivered · audit record not produced in TP-1" |
| G7 | No refunds. Listings cannot be amended, renewed or withdrawn | "Refunds are not supported in TP-1" |
| G8 | No external security review (on hold) | "Testnet only · not security-reviewed · no real value" |
| G9 | The Standard asks the seller for a delivery evidence record. Whether this release produces and verifies it is not yet established (a composition review checks it), so delivery is not claimed to conform | "Delivery evidence not produced in TP-1 (until a composition review shows it is produced and verified)" |
| G10 | If a failed payment is reported as included, the buyer rail counts it as paid (L2). Once the SDK's check lands, the release is meant to keep such a purchase open as unresolved and not send the payment again. That is the safe outcome, but it is not yet the final failure record the Standard asks for, and no test has shown it yet | Intended, pending the SDK's executed-payment check and composition qualification: "Payment failed on Demos testnet · purchase held as unresolved; the payment is not sent again". Until then a failed payment reported as included is counted as paid and this label is not shown |
| G11 | The wire requires canonical lowercase DID claims and refuses uppercase `DID:` even though the base's reader rule recognizes it | "TP-1 wire requires lowercase DID claims" |

Five more differences (G2, G3, G4, G6 and G12) are about how sessions, vetting
records, profile checks, exact-bytes checks and wire signing domains work inside the protocol. They
are written down in the declaration and have no on-screen label.
The wire library checks profile authority through a trusted local integration:
the active connection must serve the approved chain, and authenticated
participants must use the exact module versions for that purchase. The moved
seller and client packages still need to supply and qualify this integration.

## What changes next

Planned later revisions of the declaration are TP-1.1, TP-1.2 and TP-1.3. TP-1.4 is the
candidate re-pinned to the Standard's v0.5 once it is released (its latest release is v0.4) if v0.6 cannot be released
by 2026-11-19. Each is recorded in the declaration and the register, names the
Standard revision it follows and the shortfalls still open, and keeps the
label for every open one.

TP-1 makes no conformance claim for live use. Its intended composition
refuses mainnet before signatures and broadcasts; retained effect-path
broadcast refusal is not checked yet. The
Standard revision it follows is not an admissible live profile until a
coordinated release records an annotated tag or immutable merge commit (L1).

## Reporting a problem

Open an issue in this repository. For anything security-sensitive, report it
privately as described in [SECURITY.md](../SECURITY.md), not in a public
issue.
