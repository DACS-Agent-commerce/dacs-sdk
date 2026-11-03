import { connect } from 'node:tls';
import { isIP } from 'node:net';
import { SellerTlsUnusableError } from '../dacs/seller-http.mjs';

// Fixed Node/OpenSSL machine codes only; never project error messages or peer
// certificate fields. Unknown failures still refuse startup with fixed text.
const CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED',
  'CERT_REJECTED', 'CERT_CHAIN_TOO_LONG', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'INVALID_CA',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'UNHANDLED_CRITICAL_EXTENSION',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_EE_KEY_TOO_SMALL', 'ERR_SSL_CA_MD_TOO_WEAK', 'ERR_SSL_UNSUPPORTED_CERTIFICATE',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

// The operator answers this exact path in front of the seller handler, so the
// probe never reaches a seller route or the seller's request budget.
export const SELLER_TLS_PROBE_PATH = '/__seller_tls_handshake__';
const PROBE_TIMEOUT_MS = 10000;
const probeTimeout = () => Object.assign(new Error('TLS probe timeout'), { code: 'ETIMEDOUT' });

// timeoutMs exists for tests only; the operator always uses the 10 s bound.
export async function assertSellerTlsClientHandshake(origin, fetchImpl = globalThis.fetch, defaultClient = fetchImpl === globalThis.fetch, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('seller TLS probe timeout must be a positive integer');
  try {
    if (!defaultClient) {
      // An injected client may use a different CA. Use that exact client rather
      // than inventing a second trust configuration. Any HTTP answer to this
      // GET proves TLS worked. Redirects cannot substitute a different endpoint.
      // The timer bounds the probe even when the client ignores its signal.
      const controller = new AbortController();
      let timer;
      const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => { const error = probeTimeout(); controller.abort(error); reject(error); }, timeoutMs);
      });
      const probe = (async () => {
        const response = await fetchImpl(new URL(SELLER_TLS_PROBE_PATH, origin).href, {
          method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        });
        await response.body?.cancel().catch(() => {});
      })();
      probe.catch(() => {});
      try { await Promise.race([probe, expired]); } finally { clearTimeout(timer); }
      return;
    }
    const target = new URL(origin), host = target.hostname.replace(/^\[|\]$/g, '');
    await new Promise((resolve, reject) => {
      // Defaults match global fetch: process CA store (including
      // NODE_EXTRA_CA_CERTS), checkServerIdentity, and DNS SNI only.
      const socket = connect({ host, port: Number(target.port || 443),
        ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: true });
      socket.once('error', reject);
      socket.setTimeout(timeoutMs, () => socket.destroy(probeTimeout()));
      socket.once('secureConnect', () => { socket.destroy(); resolve(); });
    });
  } catch (error) {
    let code = 'UNKNOWN';
    for (let depth = 0, current = error; current && depth < 4; depth++, current = current.cause) {
      if (CODES.has(current.code)) { code = current.code; break; }
      if (current.name === 'TimeoutError' || current.name === 'AbortError') code = 'ETIMEDOUT';
    }
    throw new SellerTlsUnusableError(`seller TLS client handshake failed (${code})`);
  }
}
