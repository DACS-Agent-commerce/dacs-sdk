// Environment configuration. Every live dependency is optional and reported as
// explicitly unconfigured rather than silently replaced by a fixture.
import { join } from 'node:path';
import { SwitchFileError, loadSwitchFiles } from './switch-files.mjs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Demos chain identity per network label: the genesis hash as the pinned
// @kynesyslabs/dacs DemosAdapter.resolveChainIdentity reads it (block 0 hash,
// else block 1 content.previousHash), as 64 lowercase hex. A label alone is
// never network identity. An entry is added only by a reviewed source change
// once the target network's real identity is established (testnet handoff gate
// "network identity"), never by a setting. None is established in this build,
// so payments on any non-simulated chain are refused before approval.
export const PINNED_CHAIN_IDENTITIES = Object.freeze({});
// A network label (DACS_CHAIN_NETWORK). Purchase terms, payment domains and
// errors carry it, and the model reads it raw only in this form
// (mcp/seller-content.mjs NETWORK).
const NETWORK_LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class ConfigError extends Error {}

export { PURCHASE_LIMITS } from './purchase-limits.mjs';

function parseOrigin(name, value, { allowInsecureLocal }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`${name} must be a bare origin without path, query, fragment or credentials`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecureLocal && local && url.protocol === 'http:')) {
    throw new ConfigError(`${name} must use https (http is only allowed for localhost with DACS_ALLOW_INSECURE_LOCALHOST=1)`);
  }
  return url.origin;
}

function parseUrl(name, value, { allowInsecureLocal }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.hash) throw new ConfigError(`${name} must not contain credentials or a fragment`);
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecureLocal && local && url.protocol === 'http:')) {
    throw new ConfigError(`${name} must use https (http is only allowed for localhost with DACS_ALLOW_INSECURE_LOCALHOST=1)`);
  }
  return url.href.replace(/\/$/, '');
}

// The funding page is shown to buyers as the URL parser serializes it: its path
// and query (a token or a redirect ending in "/", even an empty "?") are kept.
// Only a bare origin drops its "/".
function parseFundingUrl(name, value) {
  parseUrl(name, value, { allowInsecureLocal: false });
  const url = new URL(value);
  // An empty fragment ("…/#") has url.hash === '', so parseUrl lets it through.
  if (url.href.includes('#')) throw new ConfigError(`${name} must not contain credentials or a fragment`);
  return url.href === `${url.origin}/` ? url.origin : url.href;
}

function parseInteger(name, value, fallback, { min, max }) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

function parseList(value) {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Simple feature switches: one declarative file each in src/switches/, so a
// new switch adds a file and touches no shared line (docs/SWITCHES.md). A
// switch here has no cross-variable rule; anything with one stays in
// loadConfig below. src/switch-files.mjs reads and validates the files; the
// deploy checks use the same parser, so they refuse what this import refuses.
export const SWITCHES = loadSwitchFiles(new URL('./switches/', import.meta.url));

const choices = (values) => `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;

// Main checks the static DACS_COMMIT_ON_SIGNATURE after the switch ordered 25
// and before the one ordered 30; loadConfig keeps that place.
const COMMIT_ON_SIGNATURE_ORDER = 27;

// The switches ordered at least from and below before (no order: after every
// number; no before: no upper bound).
function parseSwitches(env, { from = -Infinity, before = null } = {}) {
  const out = {};
  for (const s of SWITCHES) {
    const order = s.order ?? Infinity;
    if (order < from || (before !== null && order >= before)) continue;
    if (s.kind === 'flag') {
      if (env[s.env] === '1' && Object.hasOwn(s.held, '1')) throw new ConfigError(s.held['1']);
      out[s.configKey] = env[s.env] === '1';
      continue;
    }
    const value = env[s.env] ?? s.default;
    if (!s.values.includes(value)) throw new ConfigError(`${s.env} must be ${choices(s.values)}`);
    if (Object.hasOwn(s.held, value)) throw new ConfigError(s.held[value]);
    out[s.configKey] = value;
  }
  return out;
}

export function loadConfig(env = process.env) {
  const allowInsecureLocal = env.DACS_ALLOW_INSECURE_LOCALHOST === '1';
  if (!env.DACS_PUBLIC_ORIGIN) throw new ConfigError('DACS_PUBLIC_ORIGIN is required (the stable HTTPS origin that serves /mcp)');
  const publicOrigin = parseOrigin('DACS_PUBLIC_ORIGIN', env.DACS_PUBLIC_ORIGIN, { allowInsecureLocal });

  const authMode = env.DACS_AUTH_MODE ?? 'builtin';
  if (!['builtin', 'external'].includes(authMode)) throw new ConfigError('DACS_AUTH_MODE must be builtin or external');

  let externalIssuer = null;
  if (authMode === 'external') {
    if (!env.DACS_OAUTH_ISSUER) throw new ConfigError('DACS_OAUTH_ISSUER is required when DACS_AUTH_MODE=external');
    externalIssuer = {
      issuer: env.DACS_OAUTH_ISSUER,
      jwksUri: env.DACS_OAUTH_JWKS_URI ? parseUrl('DACS_OAUTH_JWKS_URI', env.DACS_OAUTH_JWKS_URI, { allowInsecureLocal }) : null,
      // Scope claim name differs across providers (scope vs scp vs permissions).
      scopeClaim: env.DACS_OAUTH_SCOPE_CLAIM || 'scope',
      // Require RFC 9068 `typ: at+jwt` (recommended when the IdP issues it) so
      // ID tokens or other JWTs for the same audience are never accepted.
      requireAtJwtType: env.DACS_OAUTH_REQUIRE_AT_JWT === '1',
    };
    parseUrl('DACS_OAUTH_ISSUER', env.DACS_OAUTH_ISSUER, { allowInsecureLocal });
  }

  const cookieKeys = parseList(env.DACS_OAUTH_COOKIE_KEYS);
  if (authMode === 'builtin' && cookieKeys.length === 0) {
    throw new ConfigError('DACS_OAUTH_COOKIE_KEYS is required for the built-in authorization server (comma-separated random secrets, >= 32 chars each)');
  }
  if (cookieKeys.some((k) => /^(REPLACE_ME|replace-with|changeme)/i.test(k))) throw new ConfigError('DACS_OAUTH_COOKIE_KEYS still contains an example placeholder; generate real random secrets');
  if (cookieKeys.some((k) => k.length < 32)) throw new ConfigError('each DACS_OAUTH_COOKIE_KEYS entry must be at least 32 characters');

  const sellerIdentities = env.DACS_SELLER_IDENTITIES ?? 'off';
  if (!['off', 'on'].includes(sellerIdentities)) throw new ConfigError('DACS_SELLER_IDENTITIES must be off or on');

  const identityGithubSignals = env.DACS_IDENTITY_GITHUB_SIGNALS ?? 'off';
  if (!['off', 'on'].includes(identityGithubSignals)) throw new ConfigError('DACS_IDENTITY_GITHUB_SIGNALS must be off or on');
  if (identityGithubSignals === 'on' && sellerIdentities !== 'on') throw new ConfigError('DACS_IDENTITY_GITHUB_SIGNALS requires DACS_SELLER_IDENTITIES=on');
  const identityGithubToken = env.DACS_IDENTITY_GITHUB_TOKEN || undefined;
  if (identityGithubToken && (identityGithubToken.length > 1024 || !/^[A-Za-z0-9_]+$/.test(identityGithubToken))) throw new ConfigError('DACS_IDENTITY_GITHUB_TOKEN has invalid format');

  // Feature switches (src/switches/) are checked here, after the cookie keys
  // and the seller identity settings and before identity writes, where their
  // checks have always run. Three static settings are checked among them, where
  // their checks have always run (docs/SWITCHES.md, "Static settings among
  // the switches"): DACS_SHOWCASE_REPORT_VIEW's rule right after the switches
  // ordered below COMMIT_ON_SIGNATURE_ORDER, then DACS_COMMIT_ON_SIGNATURE
  // before the rest, DACS_INTENT_APPROVAL after every switch.
  const switches = parseSwitches(env, { before: COMMIT_ON_SIGNATURE_ORDER });

  // Static: its rule below involves another variable. It reads the ledger
  // switch's parsed value, which that switch's order (26) has ready here.
  const showcaseReportView = env.DACS_SHOWCASE_REPORT_VIEW === '1';
  // Both change the purchase status App; they are composed in a later change.
  if (showcaseReportView && switches.showcaseLedger === true) throw new ConfigError('DACS_SHOWCASE_REPORT_VIEW=1 and DACS_SHOWCASE_LEDGER=1 cannot be enabled together; turn one of them off');

  // Static: loadConfig returns it as a boolean, which a switch file cannot declare.
  const commitOnSignature = env.DACS_COMMIT_ON_SIGNATURE ?? 'off';
  if (!['off', 'on'].includes(commitOnSignature)) throw new ConfigError('DACS_COMMIT_ON_SIGNATURE must be off or on');

  Object.assign(switches, parseSwitches(env, { from: COMMIT_ON_SIGNATURE_ORDER }));

  // One Start approval for the embedded wallet: the buyer approves a bounded
  // purchase intent once and the wallet machine-checks each later signature
  // and write against it (src/portal/start-intent.mjs). Off by default.
  // Static: its rule below involves another variable.
  const intentApproval = env.DACS_INTENT_APPROVAL ?? 'off';
  if (!['off', 'on'].includes(intentApproval)) throw new ConfigError('DACS_INTENT_APPROVAL must be off or on');
  // Auto-advance serves purchase pages its own portal.js rewrite and keeps its
  // own wallet-request journal and CREATE action, neither held to a Start.
  if (intentApproval === 'on' && switches.portalAutoAdvance === 'on') throw new ConfigError('DACS_INTENT_APPROVAL=on and DACS_PORTAL_AUTO_ADVANCE=on cannot be enabled together; turn one of them off');

  // Identity add/remove stays held until real-wallet compatibility, the proof
  // format and the wallet network are established. "simulated-fixture-only"
  // works only while the configured chain is a simulated fixture.
  const identityWrites = env.DACS_IDENTITY_WRITES || 'held';
  if (!['held', 'simulated-fixture-only'].includes(identityWrites)) throw new ConfigError('DACS_IDENTITY_WRITES must be held or simulated-fixture-only');

  const directoryOrigin = env.DACS_DIRECTORY_ORIGIN
    ? parseOrigin('DACS_DIRECTORY_ORIGIN', env.DACS_DIRECTORY_ORIGIN, { allowInsecureLocal })
    : null;
  const chainRpcUrl = env.DACS_CHAIN_RPC_URL
    ? parseUrl('DACS_CHAIN_RPC_URL', env.DACS_CHAIN_RPC_URL, { allowInsecureLocal })
    : null;

  // Embedded (extension-free) wallet writes: off unless explicitly set to the
  // simulated loopback profile, which only relays the SDK's own RPC calls to a
  // loopback chain fixture (see src/portal/wallet-rpc.mjs). Production/live
  // enabling is held for the independent security and live gates.
  //
  // "testnet-held" is the separate, explicit testnet integration profile. It
  // is HELD: writes stay off, no relay is mounted, and the portal only shows
  // the held state with the configured (non-loopback, https) chain and an
  // explicit network label. Un-holding needs a reviewed source change after
  // the security review and live gates, never a setting.
  const embeddedWalletWrites = env.DACS_EMBEDDED_WALLET_WRITES || 'off';
  if (!['off', 'simulated-loopback', 'testnet-held'].includes(embeddedWalletWrites)) throw new ConfigError('DACS_EMBEDDED_WALLET_WRITES must be off, simulated-loopback or testnet-held');
  let embeddedWallet = { writes: 'off', githubApiOrigin: null };
  let embeddedWalletTestnet = { profile: 'off' };
  if (embeddedWalletWrites === 'testnet-held') {
    if (!chainRpcUrl || LOCAL_HOSTS.has(new URL(chainRpcUrl).hostname) || new URL(chainRpcUrl).protocol !== 'https:') {
      throw new ConfigError('DACS_EMBEDDED_WALLET_WRITES=testnet-held requires an https, non-loopback DACS_CHAIN_RPC_URL (simulated fixtures use simulated-loopback)');
    }
    if (!NETWORK_LABEL.test(env.DACS_CHAIN_NETWORK ?? '')) {
      throw new ConfigError('DACS_EMBEDDED_WALLET_WRITES=testnet-held requires an explicit DACS_CHAIN_NETWORK label ([a-z0-9._-], at most 64)');
    }
    if (env.DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN) throw new ConfigError('DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN applies only to the simulated-loopback profile');
    embeddedWalletTestnet = { profile: 'held', executable: false, network: env.DACS_CHAIN_NETWORK, rpcOrigin: new URL(chainRpcUrl).origin };
  }
  if (embeddedWalletWrites === 'simulated-loopback') {
    if (!chainRpcUrl || !LOCAL_HOSTS.has(new URL(chainRpcUrl).hostname)) {
      throw new ConfigError('DACS_EMBEDDED_WALLET_WRITES=simulated-loopback requires DACS_CHAIN_RPC_URL on a loopback host (a local simulated chain fixture)');
    }
    let githubApiOrigin = null;
    if (env.DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN) {
      githubApiOrigin = parseOrigin('DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN', env.DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN, { allowInsecureLocal });
      if (!LOCAL_HOSTS.has(new URL(githubApiOrigin).hostname)) throw new ConfigError('DACS_EMBEDDED_WALLET_GITHUB_API_ORIGIN must be a loopback fixture origin in the simulated-loopback profile');
    }
    embeddedWallet = { writes: 'simulated-loopback', githubApiOrigin };
  }

  const chainNetwork = env.DACS_CHAIN_NETWORK || 'demos-testnet';
  if (!NETWORK_LABEL.test(chainNetwork)) throw new ConfigError('DACS_CHAIN_NETWORK must be a network label ([a-z0-9._-], starting with a letter or digit, at most 64)');
  const dataDir = env.DACS_DATA_DIR || join(process.cwd(), '.data');
  const demAmountEncoding = env.DACS_DEM_AMOUNT_ENCODING || 'os-string';
  if (!['os-string', 'dem-number'].includes(demAmountEncoding)) throw new ConfigError('DACS_DEM_AMOUNT_ENCODING must be os-string (post denomination fork) or dem-number');

  const config = {
    publicOrigin,
    mcpUrl: `${publicOrigin}/mcp`,
    host: env.HOST || '127.0.0.1',
    port: parseInteger('PORT', env.PORT, 8787, { min: 0, max: 65535 }),
    trustProxy: env.DACS_TRUST_PROXY === '1',
    allowInsecureLocal,
    dataDir,
    databasePath: env.DACS_DATABASE_PATH || join(dataDir, 'dacs-chatgpt.sqlite'),
    authMode,
    builtinIssuer: `${publicOrigin}/oauth`,
    externalIssuer,
    cookieKeys,
    accessTokenTtlSeconds: parseInteger('DACS_ACCESS_TOKEN_TTL_SECONDS', env.DACS_ACCESS_TOKEN_TTL_SECONDS, 900, { min: 60, max: 3600 }),
    // CIMD client_id URLs are fetched only from these hosts (ChatGPT publishes
    // https://chatgpt.com/oauth/client.json).
    cimdAllowedHosts: parseList(env.DACS_CIMD_ALLOWED_HOSTS || 'chatgpt.com'),
    allowedRedirectOrigins: parseList(env.DACS_ALLOWED_REDIRECT_ORIGINS || 'https://chatgpt.com'),
    challengeTtlSeconds: parseInteger('DACS_CHALLENGE_TTL_SECONDS', env.DACS_CHALLENGE_TTL_SECONDS, 300, { min: 30, max: 900 }),
    directory: directoryOrigin
      ? {
          origin: directoryOrigin,
          timeoutMs: parseInteger('DACS_DIRECTORY_TIMEOUT_MS', env.DACS_DIRECTORY_TIMEOUT_MS, 8000, { min: 500, max: 30000 }),
          maxBytes: parseInteger('DACS_DIRECTORY_MAX_BYTES', env.DACS_DIRECTORY_MAX_BYTES, 1_000_000, { min: 1024, max: 10_000_000 }),
        }
      : null,
    chain: chainRpcUrl
      ? {
          rpcUrl: chainRpcUrl,
          network: chainNetwork,
          // Expected chain identity for payments; null: none established.
          pinnedIdentity: Object.hasOwn(PINNED_CHAIN_IDENTITIES, chainNetwork) ? PINNED_CHAIN_IDENTITIES[chainNetwork] : null,
          timeoutMs: parseInteger('DACS_CHAIN_TIMEOUT_MS', env.DACS_CHAIN_TIMEOUT_MS, 10000, { min: 500, max: 60000 }),
        }
      : null,
    demAmountEncoding,
    fundingHelpUrl: env.DACS_FUNDING_HELP_URL ? parseFundingUrl('DACS_FUNDING_HELP_URL', env.DACS_FUNDING_HELP_URL) : '',
    showcaseReportView,
    purchaseLimits: Object.freeze({
      maxUnpaidPerAccount: parseInteger('DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT', env.DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT, PURCHASE_LIMITS.maxUnpaidPerAccount, { min: 1, max: 1000 }),
      maxUnpaidPerWallet: parseInteger('DACS_MAX_UNPAID_PURCHASES_PER_WALLET', env.DACS_MAX_UNPAID_PURCHASES_PER_WALLET, PURCHASE_LIMITS.maxUnpaidPerWallet, { min: 1, max: 1000 }),
      maxStartsPerHour: parseInteger('DACS_MAX_PURCHASE_STARTS_PER_ACCOUNT_PER_HOUR', env.DACS_MAX_PURCHASE_STARTS_PER_ACCOUNT_PER_HOUR, PURCHASE_LIMITS.maxStartsPerHour, { min: 1, max: 100000 }),
    }),
    identityWrites,
    sellerIdentities,
    identityGithubSignals,
    identityGithubToken,
    walletExtensionProbeOwnerAccount: env.DACS_WALLET_EXTENSION_PROBE_OWNER_ACCOUNT || null,
    intentApproval,
    commitOnSignature: commitOnSignature === 'on',
    embeddedWallet: Object.freeze(embeddedWallet),
    embeddedWalletTestnet: Object.freeze(embeddedWalletTestnet),
    rateLimitPerMinute: parseInteger('DACS_RATE_LIMIT_PER_MINUTE', env.DACS_RATE_LIMIT_PER_MINUTE, 600, { min: 10, max: 100000 }),
    logLevel: env.DACS_LOG_LEVEL || 'info',
  };
  for (const s of SWITCHES) if (Object.hasOwn(config, s.configKey)) throw new SwitchFileError(`${s.env}.switch`, `configKey ${s.configKey} is already a loadConfig key`);
  return Object.freeze({ ...config, ...switches });
}
