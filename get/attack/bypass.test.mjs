/*
 * attack/bypass.test.mjs - adversarial attack suite against the ToolsThatRank delivery gate.
 *
 * Threat model: a NON-PAYING visitor tries to open the gate (reveal the paid .zip download)
 * without a genuinely signed receipt. Every attack below MUST be repelled: resolveTokenGate
 * must return open:false, or the static source must expose no working download / secret.
 *
 * We attack the REAL module the delivery page imports (../verify.mjs), both:
 *   - against the DEFAULT PRODUCTION verifier (bound to PRODUCTION_PUBLIC_KEY): this is the
 *     literal thing an attacker faces in the browser. Any token they can build without the
 *     private key must be rejected here.
 *   - against a TEST-KEY verifier (makeVerifier over a throwaway keypair we generate) so we
 *     can model "a genuinely signed token opens; minting one without the key does not",
 *     without ever needing the real private key.
 *
 * No network. Run: node attack/bypass.test.mjs   (expects every attack REPELLED, RESULT: N/N)
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  makeVerifier, verify as prodVerify, resolveTokenGate, readFragment,
  grants, TOOL_ID, PRODUCTION_PUBLIC_KEY
} from '../verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GET_DIR = join(HERE, '..');

const enc = new TextEncoder();
const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
};

/* ---- an ATTACKER keypair: the adversary can generate as many keys as they like, but not
   the real private key. Tokens signed with this must be rejected by the production verifier. */
const attacker = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

/* ---- a TRUSTED test keypair, standing in for the Worker's real signing key. A verifier
   bound to its public half models the production gate; we can mint "genuine" tokens with it. */
const trusted = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const trustedPubB64u = b64u(await webcrypto.subtle.exportKey('raw', trusted.publicKey));
const trustedVerify = makeVerifier(trustedPubB64u);

async function signWith(privKey, tool, ref, exp = 0, vv = 1) {
  const seg = b64u(enc.encode(JSON.stringify({ v: vv, t: tool, o: ref, e: exp })));
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privKey, enc.encode(seg));
  return seg + '.' + b64u(sig);
}

/* ---- harness: every check is an ATTACK we assert is REPELLED. ---- */
let pass = 0, fail = 0;
const vulns = [];
/* repelled(name, wasRepelled): pass iff the attack was blocked. */
function repelled(name, wasRepelled) {
  if (wasRepelled) { pass++; console.log('PASS- REPELLED: ' + name); }
  else { fail++; vulns.push(name); console.log('VULN!!  NOT REPELLED: ' + name); }
}
/* a couple of positive controls: the gate must still open for a genuinely signed token,
   otherwise "everything closed" would trivially pass and prove nothing. */
function control(name, ok) {
  if (ok) { pass++; console.log('PASS- CONTROL: ' + name); }
  else { fail++; vulns.push('CONTROL FAILED: ' + name); console.log('FAIL-  CONTROL: ' + name); }
}

const openProd = async (tok) => (await resolveTokenGate(tok, TOOL_ID, prodVerify)).open === true;
const openTrusted = async (tok) => (await resolveTokenGate(tok, TOOL_ID, trustedVerify)).open === true;

/* =====================================================================================
   CONTROLS - prove the gate genuinely opens for a real receipt, so the attack asserts mean something.
   ===================================================================================== */
{
  const genuine = await signWith(trusted.privateKey, TOOL_ID, 'ttr_real_0001');
  control('genuine signed token for this tool OPENS the gate', await openTrusted(genuine));
  const genuineBundle = await signWith(trusted.privateKey, '*', 'ttr_real_bundle');
  control('genuine signed bundle token OPENS the gate', await openTrusted(genuineBundle));
}

/* =====================================================================================
   ATTACK 1 - No token / empty / malformed fragment.
   ===================================================================================== */
{
  repelled('1a null token', !(await openProd(null)));
  repelled('1b empty-string token', !(await openProd('')));
  repelled('1c whitespace-only token', !(await openProd('   ')));
  // fragment parsing: none of these yield a usable token
  repelled('1d fragment "#" -> none', readFragment('#').kind === 'none');
  repelled('1e fragment "#k=" (empty value) -> none', readFragment('#k=').kind === 'none');
  repelled('1f fragment "#k=..." literal dots', !(await openProd(readFragment('#k=...').value)));
  repelled('1g fragment "#s=" (empty value) -> none', readFragment('#s=').kind === 'none');
  repelled('1h garbage fragment', !(await openProd(readFragment('#garbage&stuff=1').value || null)));
  repelled('1i single-segment token (no dot)', !(await openProd('notatoken')));
  repelled('1j dangling-dot token "abc."', !(await openProd('abc.')));
  repelled('1k leading-dot token ".abc"', !(await openProd('.abc')));
}

/* =====================================================================================
   ATTACK 2 - Forged token signed with an ATTACKER-generated key.
   Structure is perfect; only the key is wrong. Must be rejected by the signature check.
   ===================================================================================== */
{
  const forged = await signWith(attacker.privateKey, TOOL_ID, 'ttr_forged', 0);
  repelled('2a attacker-key token for this tool (vs PRODUCTION key)', !(await openProd(forged)));
  repelled('2b attacker-key token (vs trusted key)', !(await openTrusted(forged)));
  const forgedBundle = await signWith(attacker.privateKey, '*', 'ttr_forged_bundle', 0);
  repelled('2c attacker-key BUNDLE token', !(await openProd(forgedBundle)));
  // sanity: the token is structurally valid (it opens under the attacker's OWN verifier),
  // which proves the rejection above is the signature check, not a structural reject.
  const attackerVerify = makeVerifier(b64u(await webcrypto.subtle.exportKey('raw', attacker.publicKey)));
  control('attacker token DOES open under attacker-own verifier (isolates sig check)',
    (await resolveTokenGate(forged, TOOL_ID, attackerVerify)).open === true);
}

/* =====================================================================================
   ATTACK 3 - Valid structure, tampered payload AFTER signing (real signature reused).
   Flip product id, order ref, and expiry independently.
   ===================================================================================== */
{
  const base = await signWith(trusted.privateKey, TOOL_ID, 'ttr_ord_9', 0);
  const [seg, sig] = base.split('.');
  const json = fromB64u(seg).toString('utf8');

  const flipTool = b64u(enc.encode(json.replace('"' + TOOL_ID + '"', '"toolsthatrank-pro"'))) + '.' + sig;
  repelled('3a flipped product id + original sig', !(await openTrusted(flipTool)));

  const flipRef = b64u(enc.encode(json.replace('ttr_ord_9', 'ttr_ord_STOLEN'))) + '.' + sig;
  repelled('3b flipped order ref + original sig', !(await openTrusted(flipRef)));

  // take an EXPIRED genuine token and try to reset expiry to 0 (perpetual) keeping the sig
  const expiredGenuine = await signWith(trusted.privateKey, TOOL_ID, 'ttr_ord_exp',
    Math.floor(Date.now() / 1000) - 3600);
  const [eSeg, eSig] = expiredGenuine.split('.');
  const eJson = fromB64u(eSeg).toString('utf8');
  const forcedPerpetual = b64u(enc.encode(eJson.replace(/"e":-?\d+/, '"e":0'))) + '.' + eSig;
  repelled('3c expired token re-forged to e:0 (perpetual) + original sig', !(await openTrusted(forcedPerpetual)));
}

/* =====================================================================================
   ATTACK 4 - Algorithm / format confusion.
   ===================================================================================== */
{
  // "none"-style: a real payload with an empty / trivial signature segment
  const seg = b64u(enc.encode(JSON.stringify({ v: 1, t: TOOL_ID, o: 'x', e: 0 })));
  repelled('4a none-alg: payload + empty sig ("seg.")', !(await openProd(seg + '.')));
  repelled('4b none-alg: payload + "none" sig', !(await openProd(seg + '.none')));
  repelled('4c none-alg: payload + 64 zero-bytes sig', !(await openProd(seg + '.' + b64u(new Uint8Array(64)))));

  // swapped segments: put the signature where the payload goes and vice-versa
  const genuine = await signWith(trusted.privateKey, TOOL_ID, 'ttr_swap', 0);
  const [gSeg, gSig] = genuine.split('.');
  repelled('4d swapped segments (sig.payload)', !(await openTrusted(gSig + '.' + gSeg)));

  // extra segments
  repelled('4e three-segment token (payload.sig.extra)', !(await openTrusted(genuine + '.extra')));
  repelled('4f four-segment token', !(await openTrusted(gSeg + '.' + gSig + '.' + gSeg + '.' + gSig)));

  // oversized token (1 MB of base64) - must not hang or open
  const huge = 'A'.repeat(1024 * 1024);
  repelled('4g oversized 1MB token', !(await openProd(huge + '.' + huge)));

  // non-JSON payload but 64-byte-looking sig (still needs a valid sig it cannot have)
  const notJson = b64u(enc.encode('this is not json at all'));
  repelled('4h non-JSON payload', !(await openProd(notJson + '.' + b64u(new Uint8Array(64)))));

  // JSON but not an object (array / number / string primitives)
  for (const prim of ['[1,2,3]', '12345', '"just a string"', 'true', 'null']) {
    const pSeg = b64u(enc.encode(prim));
    repelled('4i non-object JSON payload ' + prim, !(await openProd(pSeg + '.' + b64u(new Uint8Array(64)))));
  }

  // interior whitespace / unicode in the payload segment breaks the signed bytes
  const wsPayload = b64u(enc.encode(JSON.stringify({ v: 1, t: TOOL_ID, o: 'x', e: 0 }) + ' '));
  repelled('4j payload with trailing space + zero sig', !(await openProd(wsPayload + '.' + b64u(new Uint8Array(64)))));
  // outer whitespace is trimmed but still needs a valid sig
  repelled('4k token wrapped in whitespace/newlines', !(await openTrusted('  \n\t' + genuine.replace(gSig, gSig.slice(0, -1) + (gSig.slice(-1) === 'A' ? 'B' : 'A')) + '\t\n ')));

  // sig segment that is valid base64 but wrong byte-length (not 64)
  repelled('4l sig length 63 bytes', !(await openProd(seg + '.' + b64u(new Uint8Array(63)))));
  repelled('4m sig length 72 bytes (DER-ish size)', !(await openProd(seg + '.' + b64u(new Uint8Array(72)))));
  // sig with non-base64 characters
  repelled('4n sig with illegal base64 chars', !(await openProd(seg + '.@@@@not base64@@@@')));
}

/* =====================================================================================
   ATTACK 5 - Expiry bypass.
   ===================================================================================== */
{
  const expired = await signWith(trusted.privateKey, TOOL_ID, 'ttr_exp', Math.floor(Date.now() / 1000) - 1);
  repelled('5a genuinely-signed but EXPIRED token', !(await openTrusted(expired)));
  const longExpired = await signWith(trusted.privateKey, TOOL_ID, 'ttr_exp2', 1000000000); // 2001
  repelled('5b genuinely-signed token expired years ago', !(await openTrusted(longExpired)));
  // control: a genuine future-dated token opens
  const future = await signWith(trusted.privateKey, TOOL_ID, 'ttr_future', Math.floor(Date.now() / 1000) + 3600);
  control('genuine future-dated (not yet expired) token OPENS', await openTrusted(future));
  // e:0 perpetual is BY DESIGN a valid signed token; tampering e is covered in 3c.
}

/* =====================================================================================
   ATTACK 6 - Product confusion: a VALID signed token for a DIFFERENT tool must not open this gate.
   ===================================================================================== */
{
  const otherTool = await signWith(trusted.privateKey, 'some-other-product', 'ttr_other', 0);
  const g = await resolveTokenGate(otherTool, TOOL_ID, trustedVerify);
  repelled('6a genuine token for a different tool id (wrong-product)',
    g.open === false && g.reason === 'wrong-product');
  const emptyTool = await signWith(trusted.privateKey, '', 'ttr_emptytool', 0); // !p.t -> rejected in verify
  repelled('6b genuine token with empty tool id ("")', !(await openTrusted(emptyTool)));
  // grants() unit checks
  repelled('6c grants(): foreign tool not granted', grants({ v: 1, t: 'x', o: 'y', e: 0 }, TOOL_ID) === false);
  repelled('6d grants(): null payload not granted', grants(null, TOOL_ID) === false);
  control('grants(): this tool granted', grants({ v: 1, t: TOOL_ID, o: 'y', e: 0 }, TOOL_ID) === true);
  control('grants(): bundle granted', grants({ v: 1, t: '*', o: 'y', e: 0 }, TOOL_ID) === true);
}

/* =====================================================================================
   ATTACK 7 - Replay / transfer. The accepted tradeoff: a REAL receipt is transferable
   (no revocation). We confirm that (a) a genuine token replays/opens from "anyone", but
   (b) an attacker still cannot MINT one without the trusted private key.
   ===================================================================================== */
{
  const genuine = await signWith(trusted.privateKey, TOOL_ID, 'ttr_shared_receipt', 0);
  control('7a genuine receipt replays/opens (transferable by design)', await openTrusted(genuine));
  // the ONLY sharing vector is handing over a real signed token; minting is impossible w/o key
  const minted = await signWith(attacker.privateKey, TOOL_ID, 'ttr_minted', 0);
  repelled('7b attacker cannot MINT a receipt without the private key', !(await openTrusted(minted)));
  // even against the actual production key an attacker-minted token is dead
  repelled('7c attacker-minted token dead vs PRODUCTION key', !(await openProd(minted)));
}

/* =====================================================================================
   ATTACK 8 - Static exposure: the SERVED index.html must contain NO working .zip href,
   NO embedded token, NO private key, and no download link in static source.
   ===================================================================================== */
{
  const html = readFileSync(join(GET_DIR, 'index.html'), 'utf8');
  const verifySrc = readFileSync(join(GET_DIR, 'verify.mjs'), 'utf8');

  // 8a: no anchor/href pointing at a .zip in the served HTML
  const zipHref = /(?:href|src)\s*=\s*["'][^"']*\.zip/i.test(html);
  repelled('8a no <a href/src=...".zip"> in served HTML', !zipHref);

  // 8b: ZIP_URL is still the placeholder (no real download URL baked in). If an operator
  // fills it, the URL still only lives inside the module <script> string and is inserted
  // by revealDownload() ONLY after the gate opens - never as static markup. We assert the
  // real URL, if present, is not sitting inside an href in the raw HTML (covered by 8a),
  // and here that the placeholder discipline is intact in the audited artifact.
  repelled('8b ZIP_URL is the {{...}} placeholder in the audited artifact', html.includes("ZIP_URL = '{{ZIP_URL}}'"));

  // 8c: no embedded signed token (a b64url.b64url pair long enough to be a real token)
  //     that the PRODUCTION verifier would accept.
  const tokenLike = html.match(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{80,}/g) || [];
  let embeddedAccepted = false;
  for (const cand of tokenLike) {
    if (await openProd(cand)) { embeddedAccepted = true; break; }
  }
  repelled('8c no embedded token in HTML that the production key accepts', !embeddedAccepted);

  // 8d: no ACTUAL private key material. The public key is expected (it is public); a PRIVATE
  //     JWK / PEM / assigned signing key would leak the secret. We match real key MATERIAL only
  //     - a JWK private component "d":"<base64>", a PEM PRIVATE KEY block, or an assignment of a
  //     private/signing key - not the English word "private" appearing in prose/comments.
  const realKeyMaterial = (src) =>
    /"d"\s*:\s*"[A-Za-z0-9_\-+/=]{16,}"/.test(src)          // JWK private scalar
    || /BEGIN [A-Z ]*PRIVATE KEY/.test(src)                  // PEM private block
    || /(?:private|signing|secret)[A-Za-z]*\s*=\s*['"`]/i.test(src) // assigned secret literal
    || /LICENSE_PRIVATE_JWK\s*=/.test(src);                  // the worker's signing JWK, assigned
  repelled('8d no private-key material in served HTML', !realKeyMaterial(html));
  repelled('8e no private-key material in verify.mjs (public key only)', !realKeyMaterial(verifySrc));

  // 8f: the download control genuinely does NOT exist in static markup - #dl-slot is empty
  //     in the served HTML (only an HTML comment inside it).
  const slotEmpty = /<div class="dlwrap" id="dl-slot">\s*<!--[^>]*-->\s*<\/div>/.test(html);
  repelled('8f #dl-slot ships empty (download built in JS only)', slotEmpty);

  // 8g: the only external origin the page can contact is the hardcoded Worker origin.
  repelled('8g single hardcoded https Worker origin, no fragment-derived origin',
    /const WORKER_ORIGIN = 'https:\/\/[^']+'/.test(html));
}

/* =====================================================================================
   ATTACK 9 - CSS-only bypass. Un-hiding #state-ok via CSS must NOT yield a download,
   because the <a> is built in revealDownload() (JS) and inserted into an otherwise-empty
   #dl-slot. We assert the reveal is JS logic, not CSS visibility.
   ===================================================================================== */
{
  const html = readFileSync(join(GET_DIR, 'index.html'), 'utf8');
  // revealDownload is only called on gate.open, and it is what creates the <a>.
  const revealGated = /if \(gate\.open\)\s*\{\s*revealDownload\(gate\.payload\)/.test(html)
    || /gate\.open[\s\S]{0,40}revealDownload\(/.test(html);
  repelled('9a revealDownload() is called ONLY when gate.open is true', revealGated);
  // the <a> element is created via document.createElement, not present in markup
  const builtInJs = /document\.createElement\('a'\)/.test(html) && /a\.href = ZIP_URL/.test(html);
  repelled('9b download <a> is constructed in JS (createElement), not static markup', builtInJs);
  // removing the .hidden class reveals a section whose dl-slot is empty (no functional link).
  // Bound the match to the dl-slot element itself (no nested tags before its own </div>).
  const slotInner = (/<div class="dlwrap" id="dl-slot">([\s\S]*?)<\/div>/.exec(html) || [null, 'MISSING'])[1];
  const noStaticLink = !/<a[\s>]/i.test(slotInner);
  repelled('9c un-hiding #state-ok exposes an EMPTY dl-slot (no static <a>)', noStaticLink);
}

/* =====================================================================================
   STATIC REVIEW - DOM XSS via fragment, open-redirect via session ref, #s= exchange origin.
   ===================================================================================== */
{
  const html = readFileSync(join(GET_DIR, 'index.html'), 'utf8');

  // XSS: the ONLY innerHTML sink is orderref, fed from the VERIFIED (signed) payload.o,
  // and it is sanitized of < > &. The raw fragment/token/session value is never sent to innerHTML.
  const innerHtmlLines = html.split('\n').filter((l) => l.includes('innerHTML'));
  const onlyOrderref = innerHtmlLines.length === 1 && innerHtmlLines[0].includes("el('orderref')");
  repelled('X1 only one innerHTML sink, and it is orderref (signed payload.o)', onlyOrderref);
  const orderrefSanitized = /el\('orderref'\)\.innerHTML =[^\n]*String\(payload\.o\)\.replace\(\/\[<>&\]\/g, ''\)/.test(html);
  repelled('X2 orderref sink strips < > & from payload.o', orderrefSanitized);
  // the fragment-derived token/session value is never injected into the DOM
  const fragToDom = /innerHTML[^\n]*(frag\.value|location\.hash|token\b|\bref\b)/.test(html);
  repelled('X3 fragment/token/session value never reaches innerHTML', !fragToDom);

  // Open redirect / SSRF via #s=: origin is a hardcoded constant; ref is encodeURIComponent'd
  // into a query param, so it cannot repoint the fetch or inject a path/host.
  const exchangeSafe = /WORKER_ORIGIN\.replace\(\/\\\/\+\$\/, ''\) \+ '\/success\?session_id=' \+ encodeURIComponent\(ref\)/.test(html);
  repelled('X4 #s= exchange targets hardcoded origin + encodeURIComponent(ref)', exchangeSafe);
  // the exchanged token is RE-VERIFIED against the embedded public key before reveal
  const reVerified = /token = await exchangeSession\(frag\.value\)/.test(html)
    && /const gate = await resolveTokenGate\(token\)/.test(html);
  repelled('X5 token from #s= exchange is re-verified (verify-first) before reveal', reVerified);
  // fetch uses credentials:'omit' so no ambient cookies leak to the worker exchange
  repelled('X6 #s= fetch uses credentials:omit', /credentials: 'omit'/.test(html));
}

/* ---- verdict ---- */
const total = pass + fail;
console.log('\n================ ATTACK SUITE RESULT ================');
console.log('RESULT: ' + pass + '/' + total);
if (fail === 0) {
  console.log('GATE INTEGRITY: GO - every attack repelled, all controls held.');
} else {
  console.log('GATE INTEGRITY: NO-GO - ' + fail + ' issue(s):');
  for (const v of vulns) console.log('   - ' + v);
}
process.exit(fail ? 1 : 0);
