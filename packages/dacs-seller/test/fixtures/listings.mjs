// Builds Standard-shaped signed listings for fixtures directly from SDK
// primitives (canonicalize/contentHash/signedBytes), independently of the
// plugin's own listing builder, so tests do not grade the code with itself.
import { canonicalize, contentHash, sha256Hex, signedBytes } from '@kynesyslabs/dacs';
import { createHash } from 'node:crypto';

export function fixtureIdentityBundle(wallet, presentedAt) {
  const unsigned = {
    bundleVersion: '1',
    presentedBy: wallet.claim,
    presentedAt,
    sessionNonce: sha256Hex(`fixture:${wallet.claim}:${presentedAt}`),
    claims: [{ ref: wallet.claim }],
  };
  const hash = sha256Hex(canonicalize(unsigned));
  const sig = wallet.signBytes(signedBytes('dacs-bundle-presentation:v1:', hash)).toString('base64url');
  return { ...unsigned, presentation: { kind: 'per-claim', signatures: [{ ref: wallet.claim, signature: sig }] } };
}

export function fixtureListing(wallet, { listingId = 'fixture-report', version = 1, price = '2.5', now = Date.now(), notAfter, title = 'Fixture market report', category = 'services.market-report', pricing, acceptedRails, pipeline } = {}) {
  const draft = {
    dacsVersion: '1',
    listingVersion: version,
    listingId,
    requiredCapabilities: ['SR-1', 'SR-2'],
    seller: { identity: fixtureIdentityBundle(wallet, now - 1000), displayName: 'Fixture Seller', publicEndpoint: 'https://seller.example/agent' },
    offering: {
      title,
      description: 'SIMULATED fixture listing for local tests.',
      category,
      tags: ['fixture'],
      deliverable: { kind: 'storage-program', schemaUrl: 'urn:fixture', accessModel: 'public' },
    },
    buyerRequirement: { requirementVersion: '1', required: [], preferredPresentation: 'any' },
    pipeline: pipeline ?? [
      { kind: 'negotiate-fixed-price' },
      { kind: 'commit-payee-bound-agreement' },
      { kind: 'pay-dem', parameters: { rail: 'demos-native:DEM' } },
      { kind: 'deliver-storage-program' },
    ],
    pricing: pricing ?? { kind: 'fixed', price: { amount: price, currency: 'DEM' } },
    acceptedRails: acceptedRails ?? [{ railId: 'demos-native:DEM', railVersion: 1 }],
    terms: { deadlineSecAfterCommit: 3600, cancellationPolicy: 'pre-commit', transcriptDisclosurePolicy: 'encrypted-anchored-recommended' },
    validity: { notBefore: now - 60_000, notAfter: notAfter ?? now + 7 * 24 * 3600_000 },
  };
  const value = wallet.signBytes(signedBytes('dacs-listing:v1:', contentHash(draft))).toString('base64url');
  return { ...draft, signature: { algorithm: 'ed25519', signer: wallet.claim, value } };
}

export function fixtureLocator(seed) {
  return `stor-${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`;
}

export function summaryFor(listing, locator, { status = 'active', observedAt = new Date().toISOString() } = {}) {
  return {
    listingId: listing.listingId,
    version: listing.listingVersion,
    contentHash: contentHash(listing),
    anchor: { kind: 'storage-program', locator },
    seller: { primaryClaim: listing.seller.identity.presentedBy, displayName: listing.seller.displayName },
    offering: { title: listing.offering.title, description: listing.offering.description, category: listing.offering.category, tags: listing.offering.tags, rails: ['demos-native:DEM'] },
    pricing: { kind: listing.pricing.kind, priceHint: listing.pricing.price?.amount, currency: listing.pricing.price?.currency },
    publicEndpoint: listing.seller.publicEndpoint,
    artifactProfile: 'dacs-v0.1',
    status,
    catalogObservedAt: observedAt,
    inspection: { artifactType: 'directory-service-profile', maturity: 'listed', href: '/x' },
  };
}
