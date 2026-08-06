/*
 * get/verify.test.mjs - offline proof of the delivery gate. No network.
 *
 * Loads the SAME module the delivery page runs (verify.mjs) and proves the three
 * properties that matter for a paid download:
 *   (a) a validly-signed token for this product OPENS the gate,
 *   (b) a missing token stays CLOSED,
 *   (c) a tampered token stays CLOSED.
 *
 * The gate's verifier is key-injectable (makeVerifier), so this test mints tokens with a
 * throwaway keypair generated here and nowhere else - the real private key is never used
 * or needed. Signing mirrors the Worker's signLicence (kit/worker/src/index.js) exactly.
 *
 * Run: node get/verify.test.mjs
 */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  makeVerifier, resolveTokenGate, readFragment, grants, TOOL_ID
} from './verify.mjs';

const enc = new TextEncoder();
const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
};

/* ---- throwaway signing key (test only; never the production key) ---- */
const kp = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
);
const testPubRaw = await webcrypto.subtle.exportKey('raw', kp.publicKey);   // 65 bytes
const testPubB64u = b64u(testPubRaw);

/* A verifier bound to the test key. This is what stands in for the page's production
   verifier during the test. */
const testVerify = makeVerifier(testPubB64u);

/* Mirrors the Worker: sign { v:1, t, o, e } over the b64url payload segment. */
async function sign(tool, ref, exp = 0) {
  const seg = b64u(enc.encode(JSON.stringify({ v: 1, t: tool, o: ref, e: exp })));
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, enc.encode(seg)
  );
  return seg + '.' + b64u(sig);
}

/* ---- harness ---- */
let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
};

/* (a) a validly-signed token for this product opens the gate */
const good = await sign(TOOL_ID, 'cs_test_ord_123');
const gGood = await resolveTokenGate(good, TOOL_ID, testVerify);
t('valid signed token opens the gate', gGood.open === true && gGood.reason === 'ok');
t('opened gate carries the order ref', gGood.payload && gGood.payload.o === 'cs_test_ord_123');

/* (b) a missing token stays closed */
const gAbsentNull = await resolveTokenGate(null, TOOL_ID, testVerify);
t('null token stays closed (absent)', gAbsentNull.open === false && gAbsentNull.reason === 'absent');
const gAbsentEmpty = await resolveTokenGate('', TOOL_ID, testVerify);
t('empty token stays closed (absent)', gAbsentEmpty.open === false && gAbsentEmpty.reason === 'absent');

/* (c) a tampered token stays closed - flip the tool in the payload, keep the real sig */
const [seg, sig] = good.split('.');
const tamperedPayload = fromB64u(seg).toString('utf8').replace('"' + TOOL_ID + '"', '"toolsthatrankX"');
const forgedPayload = b64u(enc.encode(tamperedPayload)) + '.' + sig;
const gTamperPayload = await resolveTokenGate(forgedPayload, TOOL_ID, testVerify);
t('tampered payload stays closed', gTamperPayload.open === false);

/* tampered signature (flip last chars) stays closed */
const badSig = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'AB' : 'AA');
const gTamperSig = await resolveTokenGate(seg + '.' + badSig, TOOL_ID, testVerify);
t('tampered signature stays closed', gTamperSig.open === false && gTamperSig.reason === 'invalid');

/* garbage / malformed input stays closed */
t('garbage token stays closed', (await resolveTokenGate('not-a-token', TOOL_ID, testVerify)).open === false);

/* a bundle token (t:"*") opens the gate */
const bundle = await sign('*', 'cs_test_bundle');
t('bundle token opens the gate', (await resolveTokenGate(bundle, TOOL_ID, testVerify)).open === true);

/* a valid token for a DIFFERENT product stays closed (wrong-product) */
const other = await sign('some-other-tool', 'cs_test_other');
const gWrong = await resolveTokenGate(other, TOOL_ID, testVerify);
t('valid token for another product stays closed', gWrong.open === false && gWrong.reason === 'wrong-product');

/* a token signed by a FOREIGN key stays closed under our verifier */
const foreign = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const fSeg = b64u(enc.encode(JSON.stringify({ v: 1, t: TOOL_ID, o: 'cs_test_f', e: 0 })));
const fSig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, foreign.privateKey, enc.encode(fSeg));
t('foreign-key token stays closed', (await resolveTokenGate(fSeg + '.' + b64u(fSig), TOOL_ID, testVerify)).open === false);

/* an expired token stays closed */
const expired = await sign(TOOL_ID, 'cs_test_exp', Math.floor(Date.now() / 1000) - 60);
t('expired token stays closed', (await resolveTokenGate(expired, TOOL_ID, testVerify)).open === false);

/* readFragment pulls the token from the fragment, both #k= and #s= forms */
t('readFragment reads #k= token', readFragment('#k=' + good).kind === 'token');
t('readFragment reads #s= session', readFragment('#s=cs_test_123').kind === 'session');
t('readFragment reads empty hash as none', readFragment('').kind === 'none');
t('readFragment ignores a query-string key', readFragment('#').kind === 'none');

/* grants() direct unit checks */
t('grants: exact tool matches', grants({ t: TOOL_ID }, TOOL_ID) === true);
t('grants: bundle matches', grants({ t: '*' }, TOOL_ID) === true);
t('grants: other tool does not match', grants({ t: 'x' }, TOOL_ID) === false);
t('grants: null payload does not match', grants(null, TOOL_ID) === false);

const total = pass + fail;
console.log('\nRESULT: ' + pass + '/' + total);
process.exit(fail ? 1 : 0);
