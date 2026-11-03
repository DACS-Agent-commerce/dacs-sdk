// Built-in OAuth 2.1 authorization server for ChatGPT account linking, using
// oidc-provider (an established, certified OpenID provider library) rather
// than a hand-written protocol. Configuration:
//  - authorization code + PKCE S256 required for every client;
//  - RFC 8707 resource indicators: access tokens are RFC 9068 JWTs whose
//    audience is exactly this MCP resource;
//  - RFC 9207 `iss` in every authorization response (oidc-provider default);
//  - DCR (RFC 7591) and Client ID Metadata Documents restricted to allowlisted
//    hosts and redirect origins;
//  - user authentication is a wallet signature over a one-use challenge bound
//    to this interaction, client, scopes and resource (see portal/authorize).
import Provider, { errors } from 'oidc-provider';
import { generateKeyPair, exportJWK } from 'jose';
import { createSqliteAdapter } from './oidc-adapter.mjs';
import { RESOURCE_SCOPES } from './scopes.mjs';

const OIDC_SCOPES = ['openid', 'offline_access'];

// Server signing keys (not user keys), generated once and persisted so tokens
// survive restart. ES256 signs access tokens; RS256 is kept for ID tokens of
// clients that register the OIDC default algorithm.
async function loadOrCreateSigningKey(db, name, alg) {
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name);
  if (row) return JSON.parse(row.value);
  const { privateKey } = await generateKeyPair(alg, { extractable: true, ...(alg === 'RS256' ? { modulusLength: 2048 } : {}) });
  const jwk = { ...(await exportJWK(privateKey)), alg, use: 'sig', kid: `dacs-${alg.toLowerCase()}-${Date.now().toString(36)}` };
  db.prepare('INSERT OR IGNORE INTO secrets (name, value, created_at) VALUES (?, ?, ?)').run(name, JSON.stringify(jwk), new Date().toISOString());
  return JSON.parse(db.prepare('SELECT value FROM secrets WHERE name = ?').get(name).value);
}

function publicJwk(jwk) {
  const { d, ...pub } = jwk;
  return pub;
}

function redirectAllowed(uri, allowedOrigins) {
  try {
    const url = new URL(uri);
    if (url.hash || url.username || url.password) return false;
    return allowedOrigins.includes(url.origin);
  } catch {
    return false;
  }
}

export async function createAuthorizationServer({ config, db, accounts, now = () => Date.now(), logger = null }) {
  const signingJwk = await loadOrCreateSigningKey(db, 'oauth-signing-jwk', 'ES256');
  const rsaJwk = await loadOrCreateSigningKey(db, 'oauth-signing-jwk-rs256', 'RS256');
  const Adapter = createSqliteAdapter(db, now);
  const resource = config.mcpUrl;
  const issuer = config.builtinIssuer;

  const provider = new Provider(issuer, {
    adapter: Adapter,
    jwks: { keys: [signingJwk, rsaJwk] },
    clients: [],
    // DACS scopes are listed here too so DCR clients may register them in
    // `scope` and discovery advertises them; the portal grants them both as
    // OIDC-level consent and as resource scopes bound to the MCP audience.
    scopes: [...OIDC_SCOPES, ...RESOURCE_SCOPES],
    claims: { openid: ['sub'] },
    cookies: {
      keys: config.cookieKeys,
      long: { signed: true, httpOnly: true, sameSite: 'lax', secure: config.publicOrigin.startsWith('https:') },
      short: { signed: true, httpOnly: true, sameSite: 'lax', secure: config.publicOrigin.startsWith('https:') },
    },
    pkce: { required: () => true },
    clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    responseTypes: ['code'],
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      // Access tokens are bound to the MCP resource, so OIDC userinfo always
      // answered 401; ChatGPT treated that as a failed connection. Nothing in the
      // app consumes userinfo, so it is not enabled or advertised.
      userinfo: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        allowFetch: async (_ctx, clientId) => {
          try {
            const url = new URL(clientId);
            return url.protocol === 'https:' && config.cimdAllowedHosts.includes(url.hostname);
          } catch {
            return false;
          }
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => resource,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx, resourceIndicator) => {
          if (resourceIndicator !== resource) throw new errors.InvalidTarget('unknown resource');
          return {
            scope: RESOURCE_SCOPES.join(' '),
            audience: resource,
            accessTokenTTL: config.accessTokenTtlSeconds,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'ES256' } },
          };
        },
      },
    },
    extraClientMetadata: {
      properties: ['redirect_uris'],
      validator(_ctx, key, value) {
        if (key !== 'redirect_uris') return;
        if (!Array.isArray(value) || value.length === 0 || !value.every((uri) => redirectAllowed(uri, config.allowedRedirectOrigins))) {
          throw new errors.InvalidRedirectUri('redirect_uris must use an allowlisted origin');
        }
      },
    },
    findAccount: async (_ctx, sub) => {
      const account = accounts.getAccount(sub);
      // On purpose: an account with no linked wallet is refused, so a refresh for it fails with invalid_grant.
      if (!account || accounts.listWallets(account.id).length === 0) return undefined;
      return { accountId: account.id, claims: async () => ({ sub: account.id }) };
    },
    interactions: { url: async (_ctx, interaction) => `/portal/authorize/${interaction.uid}` },
    ttl: {
      AccessToken: () => config.accessTokenTtlSeconds,
      AuthorizationCode: () => 60,
      Interaction: () => 10 * 60,
      // The sign-in session. Refresh tokens issued without offline_access are bound to it.
      Session: () => 24 * 60 * 60,
      Grant: () => 30 * 24 * 60 * 60,
      IdToken: () => 60 * 60,
      // Stored expiry only. Without offline_access (ChatGPT never requests it), oidc-provider's default
      // expiresWithSession binds the refresh token to the ~24 h sign-in Session above, so it stops working
      // when that session ends. Only an offline_access token can last the full 30 days.
      RefreshToken: () => 30 * 24 * 60 * 60,
    },
    // Issue a refresh token whenever the client allows the refresh_token grant, with or without
    // offline_access. Without offline_access it is session-bound (see ttl.RefreshToken).
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    clientBasedCORS: (_ctx, origin) => config.allowedRedirectOrigins.includes(origin),
    renderError: async (ctx, out) => {
      ctx.type = 'html';
      const safe = String(out.error ?? 'error').replace(/[^a-z_]/gi, '');
      ctx.body = `<!doctype html><meta charset="utf-8"><title>Authorization error</title><p>Authorization failed: ${safe}</p>`;
    },
  });
  if (config.trustProxy) provider.proxy = true;
  // Error codes only (never codes, tokens, assertions or request bodies), so a
  // failed client authentication or grant exchange is visible to the operator.
  if (logger) for (const event of ['grant.error', 'authorization.error', 'server_error']) {
    provider.on(event, (ctx, error) => {
      let client = null;
      try { client = ctx?.oidc?.client?.clientId ?? null; client = client && /^https:/.test(client) ? new URL(client).origin : client ? 'registered' : null; } catch { client = null; }
      logger.info('oauth_error', { event, error: error?.error ?? error?.name ?? 'error', description: String(error?.error_description ?? error?.message ?? '').slice(0, 200), client });
    });
  }

  return {
    provider,
    issuer,
    // Only the access-token key is accepted by the resource server.
    publicJwks: { keys: [publicJwk(signingJwk)] },
    callback: provider.callback(),
    purgeExpired: () => Adapter.purgeExpired(),
  };
}
