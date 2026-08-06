/*
 * get/verify.mjs - the delivery gate's single source of truth.
 *
 * Imported by BOTH the delivery page (index.html, as a same-origin ES module) and the
 * offline test (verify.test.mjs). One copy of the crypto, verified in Node and shipped
 * to the browser, so the test proves exactly what the page runs.
 *
 * This mirrors the microtools kit (kit/unlock.js) verify path byte for byte. It does NOT
 * invent new crypto: same token format, same ECDSA P-256 / SHA-256, same public key.
 *
 * Token format (as minted by the live Worker's signLicence):
 *   b64url(payloadJSON) "." b64url(signature)
 *   payload   = { v:1, t:"<tool-id>" | "*", o:"<order ref>", e:<expiry epoch s, 0 = perpetual> }
 *   signature = ECDSA P-256 / SHA-256 over the ASCII bytes of the b64url payload segment
 *
 * The token travels in the URL FRAGMENT (#k=... or #s=...), never the query string:
 * fragments are not sent to servers and do not leak through the Referer header.
 */

/* Production public key. This is the raw (65-byte, uncompressed) P-256 public half of
   the live Worker's LICENSE_PRIVATE_JWK - the identical value embedded in kit/unlock.js.
   Real orders are signed by that Worker, so this is the key the delivery page trusts. */
export const PRODUCTION_PUBLIC_KEY =
  'BEUvxX_s1wkUaSOpc2cwgcccOzIDsPIrhAfEpJP2QDWF78UdZmz4v5eA1SLA5YVKP3OO3PxcPA2Wo8ZS69SDeRo';

/* The tool id this delivery page is for. The Worker mints t:"toolsthatrank" for a paid
   ToolsThatRank order; a t:"*" bundle token also opens the gate. */
export const TOOL_ID = 'toolsthatrank';
const BUNDLE = '*';

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto is unavailable in this environment');
  return c.subtle;
}

function b64uToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asciiBytes(s) {
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/*
 * Builds a verify() bound to a specific public key. Production code calls the default
 * `verify` (bound to PRODUCTION_PUBLIC_KEY). The test builds a verifier bound to a
 * throwaway test key so it can sign tokens without ever touching the real private key.
 *
 * verify(token) resolves to the payload object on a good signature, else null.
 */
export function makeVerifier(publicKeyB64u) {
  var keyPromise = null;
  function key() {
    if (!keyPromise) {
      keyPromise = subtle().importKey(
        'raw', b64uToBytes(publicKeyB64u),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
      );
    }
    return keyPromise;
  }
  return function verify(token) {
    var parts = String(token || '').trim().split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return Promise.resolve(null);

    var sig;
    try { sig = b64uToBytes(parts[1]); } catch (e) { return Promise.resolve(null); }
    if (sig.length !== 64) return Promise.resolve(null);   // raw r||s for P-256

    return key()
      .then(function (k) {
        return subtle().verify(
          { name: 'ECDSA', hash: 'SHA-256' }, k, sig, asciiBytes(parts[0])
        );
      })
      .then(function (ok) {
        if (!ok) return null;
        var p;
        try { p = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[0]))); }
        catch (e) { return null; }
        if (p.v !== 1 || !p.t) return null;
        if (p.e && Math.floor(Date.now() / 1000) > p.e) return null;
        return p;
      })
      .catch(function () { return null; });
  };
}

/* The default verifier the page uses. */
export var verify = makeVerifier(PRODUCTION_PUBLIC_KEY);

/* A token grants this delivery only if it is a bundle token or names this exact tool. */
export function grants(payload, toolId) {
  if (toolId === undefined) toolId = TOOL_ID;
  return !!payload && (payload.t === BUNDLE || payload.t === toolId);
}

/*
 * Parses location.hash. Returns { kind, value }:
 *   kind 'token'   - a signed licence token to verify client-side (#k=...)
 *   kind 'session' - a checkout session/order ref to exchange at the Worker (#s=...)
 *   kind 'none'    - nothing usable
 */
export function readFragment(hash) {
  var h = String(hash || '').replace(/^#/, '');
  var k = /(?:^|&)k=([^&]+)/.exec(h);
  if (k) return { kind: 'token', value: decodeURIComponent(k[1]) };
  var s = /(?:^|&)s=([^&]+)/.exec(h);
  if (s) return { kind: 'session', value: decodeURIComponent(s[1]) };
  return { kind: 'none', value: null };
}

/*
 * THE gate. This is the single authority the page uses to decide whether to reveal the
 * download. It is deliberately verify-first: whatever channel produced the token (a
 * client-side #k= link or a token exchanged from the Worker for a #s= session), it must
 * still carry a valid signature for THIS tool before the gate opens.
 *
 * Returns { open, payload, reason }. reason is 'ok' | 'absent' | 'invalid' | 'wrong-product'.
 */
export async function resolveTokenGate(token, toolId, verifyFn) {
  if (toolId === undefined) toolId = TOOL_ID;
  if (verifyFn === undefined) verifyFn = verify;
  if (!token) return { open: false, payload: null, reason: 'absent' };
  var payload = await verifyFn(token);
  if (!payload) return { open: false, payload: null, reason: 'invalid' };
  if (!grants(payload, toolId)) return { open: false, payload: payload, reason: 'wrong-product' };
  return { open: true, payload: payload, reason: 'ok' };
}
