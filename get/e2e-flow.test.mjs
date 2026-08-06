// End-to-end buyer-flow harness for the ToolsThatRank delivery gate.
//
// This simulates exactly what get/index.html does at runtime: it reads a token out of a URL
// fragment, runs it through the SAME exported gate logic the page imports (readFragment ->
// resolveTokenGate -> grants), and asserts the download is revealed only for a valid, paid,
// correctly-scoped token. No network, no browser: it drives the real module the page uses, with
// a key-injected verifier (makeVerifier) so we can mint test tokens without the production key.
//
// Run: node e2e-flow.test.mjs   (expects RESULT: N/N, exit 0)
import { webcrypto } from 'node:crypto';
import { makeVerifier, grants, readFragment, resolveTokenGate, TOOL_ID } from './verify.mjs';

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Throwaway signing key (TEST ONLY — never the production key). The gate is verified against the
// matching public key so this proves the flow end to end without touching real secrets.
const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const rawPub = await webcrypto.subtle.exportKey('raw', kp.publicKey);
const testPubB64u = b64u(rawPub);
const verify = makeVerifier(testPubB64u);

// Mirrors the Worker's signLicence: sign { v:1, t, o, e } over the b64url payload segment.
async function mint(tool, ref, exp = 0) {
  const payload = { v: 1, t: tool, o: ref, e: exp };
  const payloadB64u = b64u(JSON.stringify(payload));
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(payloadB64u));
  return `${payloadB64u}.${b64u(sig)}`;
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { console.log(`PASS - ${name}`); pass++; } else { console.log(`FAIL - ${name}`); fail++; } };

// The exact runtime path of the delivery page: fragment -> {kind,value} -> token -> gate.
// readFragment returns { kind:'token'|'session'|'none', value }. The #k= path (client-side
// token) feeds value straight into the verify-first gate, exactly as index.html does. The #s=
// session path would first exchange the session at the Worker for a token; that network step is
// out of scope for this offline harness, so we drive the #k= token path the gate ultimately runs.
async function buyerLoads(fragment) {
  const frag = readFragment(fragment);
  const token = frag && frag.kind === 'token' ? frag.value : null;
  const gate = await resolveTokenGate(token, TOOL_ID, verify);
  return gate; // { open, payload, reason }
}

// (1) A real paying buyer: valid token for this product in the #k= fragment -> download revealed.
{
  const token = await mint(TOOL_ID, 'ttr_order_0001');
  const gate = await buyerLoads(`#k=${token}`);
  ok('valid paid token -> gate OPEN (download revealed)', gate && gate.open === true);
}

// (2) A bundle token (t:"*") also grants this product.
{
  const token = await mint('*', 'ttr_order_bundle');
  const gate = await buyerLoads(`#k=${token}`);
  ok('bundle token (t:"*") -> gate OPEN', gate && gate.open === true);
}

// (3) No token at all (someone hits /get/ directly) -> gate stays CLOSED.
{
  const gate = await buyerLoads('');
  ok('no token -> gate CLOSED (no free download)', !gate || gate.open === false);
}

// (4) Tampered token (flip a char in the signature) -> CLOSED.
{
  const token = await mint(TOOL_ID, 'ttr_order_tamper');
  const parts = token.split('.');
  const sig = parts[1];
  const flipped = (sig[3] === 'A' ? 'B' : 'A') + sig.slice(1); // corrupt the signature
  const bad = `${parts[0]}.${flipped}`;
  const gate = await buyerLoads(`#k=${bad}`);
  ok('tampered signature -> gate CLOSED', !gate || gate.open === false);
}

// (5) Valid signature but WRONG product (a token minted for another tool) -> CLOSED for this page.
{
  const token = await mint('some-other-tool', 'ttr_order_wrongprod');
  const gate = await buyerLoads(`#k=${token}`);
  ok('valid token for a different product -> gate CLOSED', !gate || gate.open === false);
}

// (6) Token signed by a DIFFERENT key (forged by someone without the private key) -> CLOSED.
{
  const otherKp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const payload = { v: 1, t: TOOL_ID, o: 'ttr_forged', e: 0 };
  const payloadB64u = b64u(JSON.stringify(payload));
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, otherKp.privateKey, new TextEncoder().encode(payloadB64u));
  const forged = `${payloadB64u}.${b64u(sig)}`;
  const gate = await buyerLoads(`#k=${forged}`);
  ok('token signed by a foreign key -> gate CLOSED', !gate || gate.open === false);
}

// (7) Expired token (e in the past) -> CLOSED.
{
  const past = Math.floor(Date.now() / 1000) - 3600;
  const token = await mint(TOOL_ID, 'ttr_order_expired', past);
  const gate = await buyerLoads(`#k=${token}`);
  ok('expired token -> gate CLOSED', !gate || gate.open === false);
}

// (8) grants() directly: a valid payload for this tool grants; a foreign tool does not.
{
  ok('grants(): this product granted', grants({ v: 1, t: TOOL_ID, o: 'x', e: 0 }, TOOL_ID) === true);
  ok('grants(): foreign product not granted', grants({ v: 1, t: 'nope', o: 'x', e: 0 }, TOOL_ID) === false);
}

console.log(`\nRESULT: ${pass}/${pass + fail} end-to-end buyer-flow checks passed`);
process.exit(fail ? 1 : 0);
