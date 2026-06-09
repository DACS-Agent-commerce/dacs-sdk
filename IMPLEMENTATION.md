# DACS SDK — Implementation Plan (v0.1, MVP)

**Audience:** the KyneSys dev who already has `agent-commerce-demo` running.
**Goal in one line:** turn the working demo (an app that runs one hardcoded flow) into **`dacs-sdk`** — a reusable library other devs install to build their own DACS agents — scoped to a minimum, production-real v0.1 path.

This is a *build plan*, not the spec. The spec (source of truth) lives in `DACS-Agent-commerce/DACS-Standard` on the `spec-compression` branch (all five modules are now readability-complete).

---

## 0. Mental model

- `agent-commerce-demo` = an **app**: one scripted buyer↔seller scenario, end-to-end on Demos. ~10.8k LOC; already runs the x402 path live.
- `dacs-sdk` = a **library**: the reusable engine + a clean API, so anyone can `npm i` it and ship an agent.
- The job is **extract → API → configurable → correct → proven → shipped**, not greenfield. The demo becomes the SDK's first *example*.

Layering / dependency direction (important — it drives every structural choice):

```
DACS-Standard      spec + §14 conformance vectors          ← source of truth
      ▲
dacs-sdk           the library; depends on @kynesyslabs/demosdk; tested against the vectors
      ▲
agent-commerce-demo   refactors to import dacs-sdk → becomes the worked example
```

---

## 1. Architecture decisions (locked)

1. **Standalone repo, not a module inside `demosdk`.** DACS is a layer *above* the substrate (it consumes `demosdk`), and the standard is deliberately substrate-agnostic — embedding it in the Demos SDK would invert the dependency and contradict the spec's portability stance. → New repo **`DACS-Agent-commerce/dacs-sdk`**.
2. **Depends on `@kynesyslabs/demosdk`** for all substrate calls (SR-2/3/4/5). A Demos dev installs `dacs-sdk` and demosdk comes transitively.
3. **One substrate-adapter seam, one implementation.** Define a thin `SubstrateAdapter` interface (anchor / proxy-fetch / channel / settle) with a single `DemosAdapter` wrapping demosdk. Demos is the only adapter today — do **not** build speculative multi-substrate machinery (the interface is cheap; the second adapter is YAGNI).
4. **Consumes the §14 conformance vectors from `DACS-Standard`** (git submodule, or fetch in CI) as the test oracle — so the SDK is provably conformant and the dependency points SDK → spec.
5. **Steward registries are owned by this team** (the dev works for KyneSys, holds the PA-2 key). Publishing recipes/rails is in scope here, with the key-custody discipline in §6.

**Two naming calls to make before Task 1:** repo name (`dacs-sdk`, or `dacs-ts` if multi-language SDKs are planned) and npm scope (`@kynesyslabs/dacs` vs a DACS-branded scope — a positioning call).

---

## 2. MVP scope

**In:** self-declared identity (+ one real verified claim), fixed-price negotiation, **x402** settlement (the reference-backed rail), one delivery type, attestation bundle + basic reputation.

**Out (deferred — each is opt-in later, mostly via the registries):** cross-chain HTLC/tank settlement, sealed-envelope auctions, RFQ, L2PS private channels, AP2 (not reference-backed), encrypted/private deliverables, ERC-8004 publication, DACS-X dispute.

**MVP acceptance test (definition of done):**
> A buyer agent discovers a seller's anchored fixed-price listing → vets the seller (self-signed + one real verified claim) → accepts + commits the agreement → settles via **x402 on Base** → receives the deliverable → both anchor a two-sided **attestation bundle** that independently verifies → **reputation is derivable** from it — and the relevant **§14 conformance vectors pass** in CI.

---

## 3. The work, in phases

Each task: **what** (plain), **from the demo** (what to reuse), **done when** (testable).
Global done-for-every-task: unit tests pass; the 5 `DACS-Standard` validators stay green; no conformance-vector regressions.

### Phase 1 — Carve the library out of the demo

**T1 · Scaffold `dacs-sdk` and the substrate seam**
- *What:* create the repo; define the `SubstrateAdapter` interface + `DemosAdapter` (wrapping demosdk); wire the §14 vectors in (submodule or CI fetch); set up build + CI.
- *Done when:* empty package builds, connects to a Demos RPC through `DemosAdapter`, and the (currently failing/empty) conformance harness runs in CI.

**T2 · Move the foundation in (canonical form + signing + anchoring)**
- *What:* extract canonical-form (JCS + NFC + CD-1 decimals), content-hash + domain-separated signing, and the SR-2 anchoring wrapper into the library. These are used by everything.
- *From the demo:* the signing/canonical helpers + the demosdk anchoring calls; `config.ts`, `multi-rpc.ts`, `idempotency.ts`.
- *Done when:* these have their own unit tests, no demo-specific imports, and **pass the §14 canonical-form / signing / CD-1 vectors** (this is the precision-critical, highest-risk part — the vectors are what de-risk it).

**T3 · Move the artifact model in**
- *What:* the builders + validators for the spine artifacts the fixed-price + x402 path uses (IdentityBundle, Listing, AgreementDocument, SettlementEvidence, AttestationBundle, RatingRecord).
- *Done when:* each round-trips its §14 fixtures.

### Phase 2 — Give it a clean, obvious API

**T4 · Design the public API**
- *What:* decide the small set of functions an agent dev calls, and hide the rest. Target surface:
  - `createAgent({ identity, demosRpc, wallet })`
  - seller: `publishListing(spec)`
  - buyer: `discover()`, `runSession(listingRef)` → result + anchored bundle
  - anyone: `verifyBundle(ref)`, `getReputation(primaryClaim)`
- *Done when:* `index.ts` exports only these; the rest is internal.

**T5 · Write the "hello world" agent example**
- *What:* a ~20-line script — seller publishes a fixed-price listing + x402 paywall; buyer buys it — using only the public API. Doubles as smoke test + docs.
- *Done when:* a teammate sets 3 env vars and completes a real deal on testnet from the example alone.

### Phase 3 — Make the hardcoded flow configurable

**T6 · Rails and verification become registry-driven, not hardcoded**
- *What:* the agent resolves *which rail* and *which verification recipe* from the published registries and dispatches by type — so adding a rail/check later is config, not code.
- *Done when:* switching the listing's rail (x402 → an ERC-20 USDC rail) needs **no SDK code change** — just a different rail id.

**T7 · Identity and listings become caller-supplied**
- *What:* the SDK takes the caller's key/bundle and (for sellers) their listing spec as inputs, instead of the demo's hardcoded ones.
- *Done when:* two different identities run a deal with no code edits.

### Phase 4 — Production correctness & robustness

**T8 · Fix the two known spec-conformance gaps** *(only if keeping the HTLC path; an x402-only MVP can skip)*
- *What:* (a) preimage generation → the spec's HKDF derivation (so a disputing party can re-derive it); (b) HTLC claim order → canonical payer-claims-destination-first.
- *Done when:* both match the spec and the related vectors pass.

**T9 · Harden the money paths**
- *What:* make every on-chain/anchor action **safe to retry after a crash** (check whether the effect already happened before re-issuing — no double-pay, no double-anchor); proper key custody (no loose raw keys); clear error classification (transient / permanent / counterparty / substrate).
- *From the demo:* `idempotency.ts`, `refund-monitor.ts`, `limits.ts` patterns.
- *Done when:* killing the process mid-session and restarting completes — or cleanly fails — with no duplicated payment or record.

### Phase 5 — Prove it & ship it

**T10 · Run the full SDK against the conformance vectors**
- *What:* point the §14 golden vectors at the SDK's builders/validators + the end-to-end path; **add the missing `pay-x402` vector to `DACS-Standard`** (closes a roadmap item and gives the SDK its test); CI on every commit.
- *Done when:* the conformance suite + all 5 validators run green in CI.

**T11 · Package & document**
- *What:* versioned, installable package; README (install → first agent in 5 min); API reference; required env/setup. Demo stays as the worked example.
- *Done when:* a dev outside the team installs it and ships an agent from the README alone.

### Steward track (this team — runs in parallel)

**T12 · Publish the recipe registry (`dacs2:registry:v0.1`)**
- *What:* author + steward-sign + anchor recipes for the MVP schemes — `self-signed` + the one real `consensus-backed-proxy` check — with correct `availability`, under the PA-2 single-signer key.
- *Done when:* the SDK resolves each recipe by index, verifies signature + content-hash, and pins it at session start.

**T13 · Publish the rail registry (`dacs4:registry:v0.1`)**
- *What:* the `x402:default` rail (+ optional `evm-erc20:…:USDC`), signed/anchored, `availability: live`.
- *Done when:* the SDK resolves + pins the rail.

---

## 4. Build order (critical path)

```
T1 → T2 → T3 → T4 → T5        (working library + example, fast)
        → T6, T7              (configurable)
        → T8, T9             (correct + robust)
        → T10, T11           (proven + shipped)
T12, T13 (steward) in parallel — must be live before T5 can run end-to-end.
```

Because the demo already works, **Phases 1–2 get you a usable *internal* SDK quickly**; Phases 3–5 are what make it *other-people-ready*.

---

## 5. Key disciplines (carry through every task)

- **Canonical form is byte-exact and unforgiving** — it's small but the highest bug-risk; build it against the §14 vectors from day one (T2). Money is a *string* (CD-1), never a float.
- **Steward key is the trust root** — recipes/rails are trusted because the steward key signed them. Key custody (HSM/limited access), and the registry is **append-only**: never mutate a published recipe/rail version, only add new ones. Recipe-poisoning is the headline threat.
- **Idempotency on anything that moves value or anchors** — production restarts mid-flight; re-driving a phase must not double-pay or double-anchor.
- **Substrate fault ≠ party fault** — if anchoring/substrate is down, classify `substrate` (blameless), never `counterparty`.

---

## 6. Decisions to lock before starting

1. **Repo name** (`dacs-sdk` vs `dacs-ts`) + **npm scope/branding**.
2. **The one real verification method for the MVP:** `domain` (ACME-style, no internal dependency — recommended for speed) vs `lei` (institutional flagship, but gated on the GCR routine — coordinate with that workstream).
3. **Delivery type:** `deliver-storage-program` (simplest; public payload — fine for public deliverables) vs `deliver-entitlement` (private, access-controlled endpoint).

---

## 7. References

- **Spec (source of truth):** `DACS-Agent-commerce/DACS-Standard` @ `spec-compression` — `spec/CORE.md` + `spec/DACS-1..5-*.md`; start at `PRIMER.md`.
- **Conformance vectors:** `DACS-Standard/conformance/` (§14, 186 golden cases) + the 5 `scripts/validate_*.py`.
- **Extraction source:** `agent-commerce-demo/packages/agent-runner/src` — notably `payment.ts` (x402), `identity*.ts`, `commitment.ts`, `negotiation/`, `state.ts`, `execution.ts`, `config.ts`, `multi-rpc.ts`, `idempotency.ts`.
- **Substrate:** `@kynesyslabs/demosdk` — SR-2 (Storage Programs), SR-3 (DAHR / `web2`), SR-4 (L2PS), SR-5 (bridge / Liquidity Tanks).
