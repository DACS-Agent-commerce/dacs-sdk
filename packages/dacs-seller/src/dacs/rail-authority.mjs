// The seller's rail authority: DACS-4 §9.4.3-§9.4.4 (RAV-R1..RAV-R3, RAV-R5) and
// DACS-1 §6.3.4 LRR-6.
//
// The native profile takes the demos-native:DEM RailDefinition from the
// operator as the complete steward-signed record (PA-1, governance.anchoring
// "in-code"), with the steward claim and raw Ed25519 key, the registry version
// it belongs to and the local production policy. The SDK authenticates the
// signature and evaluates availability; nothing here assumes `live`. Each
// session pins the exact signed definition before its Agreement is signed and
// is evaluated again from that pin, never from the current configuration, at
// commitment and at payment intake.
//
// Only the simulated fixture profile (explicit `simulatedFixture: true`) uses
// the unsigned in-code DEM_RAIL_DEFINITION of purchase-protocol.mjs.
import { isCanonicalBase64Url, isCanonicalClaimReference, canonicalize, evaluateRailAvailabilitySelection, validateListingArtifact } from '@kynesyslabs/dacs';
import { DEM_RAIL, verifyComponent } from './listing.mjs';

const AUTHORITY_KEYS = Object.freeze(['production', 'rail', 'railRegistryVersion', 'stewardClaim', 'stewardPublicKey']);
const INTAKE_RAIL_KEYS = Object.freeze(['railVersion', 'railId', 'railType', 'asset', 'network', 'phaseHandler', 'parameters', 'availability']);
// DACS-4 §9.5.9 pay-dem: native DEM in OS base units (9 decimals).
const DEM_ASSET = Object.freeze({ kind: 'native-dem', symbol: 'DEM', decimals: 9 });
export const RAIL_AUTHORITY_BASIS = 'pa1-in-code';
// Only configurations built here are trusted as authenticated.
const AUTHENTICATED = new WeakSet();

// Validates the operator's rail authority; null when none is given. Throws
// for anything that is not this steward's signed DEM rail definition.
export function railAuthorityConfig(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || canonicalize(Object.keys(value).filter((key) => key !== 'historicalStewards').sort()) !== canonicalize(AUTHORITY_KEYS)) {
    throw new TypeError(`railAuthority must be exactly { ${AUTHORITY_KEYS.join(', ')} }, with optional historicalStewards`);
  }
  const { stewardClaim, stewardPublicKey, railRegistryVersion, production } = value;
  if (!Number.isSafeInteger(railRegistryVersion) || railRegistryVersion <= 0) throw new TypeError('railAuthority.railRegistryVersion must be a positive integer');
  if (typeof production !== 'boolean') throw new TypeError('railAuthority.production must be the local operator policy (true or false)');
  // Trusted local key history, never a peer/network reply or keys supplied
  // by a retained pin. Copy it so later config mutation cannot change authority.
  const history = value.historicalStewards ?? [];
  if (!Array.isArray(history)) throw new TypeError('railAuthority.historicalStewards must be an array of trusted steward identities');
  const trustedStewards = new Map([[stewardClaim, [stewardPublicKey]]]);
  for (const entry of history) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        canonicalize(Object.keys(entry).sort()) !== canonicalize(['stewardClaim', 'stewardPublicKey']) ||
        !isCanonicalClaimReference(entry.stewardClaim) || !isCanonicalBase64Url(entry.stewardPublicKey) || Buffer.from(entry.stewardPublicKey, 'base64url').length !== 32 ||
        trustedStewards.get(entry.stewardClaim)?.includes(entry.stewardPublicKey)) throw new TypeError('railAuthority.historicalStewards must contain distinct { stewardClaim, stewardPublicKey } identities');
    const keys = trustedStewards.get(entry.stewardClaim) ?? [];
    keys.push(entry.stewardPublicKey);
    trustedStewards.set(entry.stewardClaim, keys);
  }
  let rail;
  try { rail = structuredClone(value.rail); } catch { throw new TypeError('railAuthority.rail must be plain JSON'); }
  const authority = (pinnedRailDigest, sessionState, claim = stewardClaim, key = stewardPublicKey) => ({ stewardClaim: claim, stewardPublicKey: key, pinnedRailDigest, sessionState,
    operatorContext: { source: 'local-operator-policy', production }, operatorPreflightOk: false });
  // Without a pin the SDK stops after the signature: a digest comes back only
  // for a definition this steward signed.
  const signed = evaluateRailAvailabilitySelection(rail, authority(null, 'new'));
  if (signed.decision !== 'indeterminate' || signed.reason !== 'pin-unavailable') throw new TypeError(`railAuthority.rail is not a RailDefinition signed by the steward (${signed.reason})`);
  const digest = signed.railDigest;
  if (evaluateRailAvailabilitySelection(rail, authority(digest, 'new')).decision === 'error') throw new TypeError('railAuthority.rail is not a RailDefinition');
  if (rail.railId !== DEM_RAIL.railId || rail.railVersion !== DEM_RAIL.railVersion || rail.railType !== 'demos-native' || rail.phaseHandler !== 'pay-dem' ||
      canonicalize(rail.asset) !== canonicalize(DEM_ASSET) || canonicalize(rail.network) !== canonicalize({ kind: 'demos' })) {
    throw new TypeError(`railAuthority.rail is not ${DEM_RAIL.railId} version ${DEM_RAIL.railVersion} on pay-dem`);
  }
  if (rail.governance?.anchoring !== 'in-code') throw new TypeError('railAuthority.rail must be a PA-1 in-code definition; a PA-2/PA-3 rail resolves only through the canonical registry index, which this seller does not read');
  const pin = Object.freeze({ basis: RAIL_AUTHORITY_BASIS, digest, railRegistryVersion, stewardClaim, stewardPublicKey, rail });
  const config = Object.freeze({
    digest,
    railRegistryVersion,
    // A fresh copy of the exact signed definition, for a new session's pin.
    pin: () => structuredClone(pin),
    // RAV-R1..R3, R5 over a retained pin: its trusted historical steward's signature over
    // the exact pinned bytes, the pin digest and the pinned availability. A
    // disabled, failed, gated (no operator preflight here) or production
    // mocked rail is refused; so is a non-production mocked one, which the SDK
    // payment intake cannot settle, so that no Agreement is signed for a
    // payment the seller would then refuse. A pin keeps the registry version
    // it was taken under (RAV-R2): the current one only makes new pins.
    evaluate: (retained, sessionState) => {
      if (retained?.basis !== RAIL_AUTHORITY_BASIS || !Number.isSafeInteger(retained.railRegistryVersion) || retained.railRegistryVersion <= 0 || !/^[0-9a-f]{64}$/.test(retained.digest ?? '')) {
        return { decision: 'indeterminate', reason: 'pin-unavailable' };
      }
      // Older durable pins already retain the authenticated signer in the
      // signed definition. New pins also name it explicitly. History is only
      // for sessions already signed; a fresh session uses today's steward.
      const claim = retained.stewardClaim ?? retained.rail?.signature?.signer;
      const keys = sessionState === 'in-flight' ? trustedStewards.get(claim) ?? [] : claim === stewardClaim ? [stewardPublicKey] : [];
      if (claim !== retained.rail?.signature?.signer) return { decision: 'fail', reason: 'signature-invalid' };
      // A claim may keep its identity across key rotation. New pins retain the
      // exact key identity; legacy pins try the trusted history for their claim. A key
      // in saved data is only a selector, never an additional trust root.
      for (const key of keys) {
        if (retained.stewardPublicKey !== undefined && retained.stewardPublicKey !== key) continue;
        const result = evaluateRailAvailabilitySelection(retained.rail, authority(retained.digest, sessionState, claim, key));
        if (result.decision === 'fail' && result.reason === 'signature-invalid') continue;
        if (result.decision === 'pass' && retained.rail.availability !== 'live') return { decision: 'fail', reason: 'not-settleable', railDigest: result.railDigest };
        return result;
      }
      return { decision: 'fail', reason: 'signature-invalid' };
    },
    listingDefinition: Object.freeze({ railId: rail.railId, railVersion: rail.railVersion, phaseHandler: rail.phaseHandler, governanceAnchoring: 'in-code', signatureValid: true }),
  });
  AUTHENTICATED.add(config);
  return config;
}

// The SDK payment intake's rail shape, projected from a pinned signed rail.
export const intakeRailDefinition = (retained) => Object.fromEntries(INTAKE_RAIL_KEYS.map((key) => [key, structuredClone(retained.rail[key])]));

// Ordered DACS-1 reader via the SDK, as listing.mjs validateListing, but its
// LRR-6 rail resolution is the authenticated `railAuthority` definition (the
// operator's input, authenticated here, or a railAuthorityConfig result); the
// unsigned simulated fixture rail is used only when `simulatedFixture` is true.
// The package root exports this as validateListing.
export async function validateSellerListing(listing, { now, revocationSurfaces, readMarker, railAuthority = null, simulatedFixture = false }) {
  const rail = AUTHENTICATED.has(railAuthority) ? railAuthority : railAuthorityConfig(railAuthority);
  const definition = rail?.listingDefinition ?? (simulatedFixture === true
    ? { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true }
    : null);
  if (!definition) throw new TypeError('Listing rail resolution needs an authenticated railAuthority, or simulatedFixture: true for the simulated fixture rail');
  return validateListingArtifact(listing, {
    nowMs: () => now(),
    verifyListingSignature: verifyComponent,
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
      return Boolean(proof && verifyComponent({ signedBytes: bytes, signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
    },
    verifySellerControl: ({ bundle, signer }) => bundle.presentedBy === signer && bundle.claims.some((claim) => claim.ref === signer),
    revocation: { surfaces: revocationSurfaces, readMarker, verifyMarkerSignature: verifyComponent },
    loadRailResolution: () => ({
      trustPhase: 'PA-1',
      trustPolicyAcceptsPA1: true,
      registry: { state: 'not-used', entries: [], definitions: [] },
      inCodeDefinitions: [{ ...definition }],
    }),
  });
}
