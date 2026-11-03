// Independently controlled local OAuth 2.1 test issuer (SIMULATED). Written
// from RFC 6749/7636/8414/8707/9207 directly with jose, sharing no code with
// the plugin's built-in oidc-provider setup, so the external-issuer adapter is
// exercised against a different implementation. Auto-approves the subject the
// test sets; issues RS256 JWT access tokens with aud = requested resource.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export async function startTestIssuer({ scopeClaim = 'scope' } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-issuer-1', alg: 'RS256', use: 'sig' };
  const clients = new Map();
  const codes = new Map();
  const state = { subject: 'user-1', audienceOverride: null, metadataIssuerOverride: null };
  let issuer;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return send(res, 200, {
        issuer: state.metadataIssuerOverride ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['dacs.account.read', 'dacs.agents.write', 'dacs.purchases.write'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/jwks') return send(res, 200, { keys: [jwk] });
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = JSON.parse(await readBody(req));
      const clientId = `tc_${randomBytes(8).toString('hex')}`;
      clients.set(clientId, { redirect_uris: body.redirect_uris });
      return send(res, 201, { client_id: clientId, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const p = url.searchParams;
      const client = clients.get(p.get('client_id'));
      if (!client || !client.redirect_uris.includes(p.get('redirect_uri'))) return send(res, 400, { error: 'invalid_client' });
      const redirect = new URL(p.get('redirect_uri'));
      redirect.searchParams.set('iss', issuer);
      if (p.get('state')) redirect.searchParams.set('state', p.get('state'));
      if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
        redirect.searchParams.set('error', 'invalid_request');
      } else {
        const code = randomBytes(16).toString('base64url');
        codes.set(code, { clientId: p.get('client_id'), redirectUri: p.get('redirect_uri'), challenge: p.get('code_challenge'), resource: p.get('resource'), scope: p.get('scope') ?? '', subject: state.subject });
        redirect.searchParams.set('code', code);
      }
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const p = new URLSearchParams(await readBody(req));
      const entry = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      if (!entry || entry.clientId !== p.get('client_id') || entry.redirectUri !== p.get('redirect_uri')) return send(res, 400, { error: 'invalid_grant' });
      const computed = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (computed !== entry.challenge) return send(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      if (p.get('resource') && p.get('resource') !== entry.resource) return send(res, 400, { error: 'invalid_target' });
      const now = Math.floor(Date.now() / 1000);
      const access = await new SignJWT({ [scopeClaim]: scopeClaim === 'scp' ? entry.scope.split(' ') : entry.scope, client_id: entry.clientId })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, typ: 'at+jwt' })
        .setIssuer(issuer).setAudience(state.audienceOverride ?? entry.resource).setSubject(entry.subject)
        .setIssuedAt(now).setExpirationTime(now + 600).sign(privateKey);
      return send(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 600, scope: entry.scope });
    }
    send(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return { get issuer() { return issuer; }, state, close: () => new Promise((resolve) => server.close(resolve)) };
}
