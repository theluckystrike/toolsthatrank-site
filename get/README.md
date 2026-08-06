# ToolsThatRank delivery page (`/get/`)

The post-payment page. A buyer pays via Stripe, is redirected here, and this page
confirms the order and reveals the product `.zip` download — but only against a valid,
signed receipt. Without one, the download is never shown.

## Files

| File | Role |
| --- | --- |
| `index.html` | The delivery page. Design-matched to the sales page. Reads the token from the URL fragment, verifies it, and reveals the download only on a valid paid receipt. |
| `verify.mjs` | The verification gate. Single source of truth, imported by both `index.html` (as a same-origin ES module) and the test. Mirrors the microtools kit crypto exactly (ECDSA P-256 / SHA-256, same public key). |
| `verify.test.mjs` | Offline Node test. Proves a valid token opens the gate, a missing token stays closed, and a tampered token stays closed. No network. |

## How it works

```
Stripe payment
      |
      v
redirect to  /get/#k=<signed-token>        (a #k= token link, verified with no network)
   ... or    /get/#s=<checkout-session-id>  (exchanged for a token at the Worker /success)
      |
      v
verify.mjs verifies the ECDSA signature in the browser against the embedded public key
      |
      +-- valid + paid + this product  -> download button is BUILT IN JS and inserted
      |
      +-- absent / invalid / tampered / wrong product -> calm "could not verify" state,
                                                          no download control ever created
```

- **The token lives in the URL fragment (`#k=` or `#s=`), never the query string.**
  Fragments are not sent to servers and do not leak through the `Referer` header.
- **The gate is enforced in JavaScript, not CSS.** The download `<a>` is constructed in
  `revealDownload()` and only runs when `resolveTokenGate()` returns `open: true`. The
  archive URL is never present as a clickable control in the served HTML, so viewing
  source or deleting a CSS class does not expose it.
- **Verify-first, always.** Even a token fetched from the Worker for a `#s=` session is
  re-checked against the embedded public key before anything is revealed. The page never
  takes the Worker's word for "paid".
- **No external requests except the Worker origin.** Fonts are the sales page's stack with
  a `system-ui` fallback (not loaded from a remote host). The only network call the page
  can make is to `WORKER_ORIGIN`, and only for the `#s=` session-exchange path.

## Placeholders to fill before deploy

All three live at the top of the inline `<script type="module">` in `index.html`
(except `{{ZIP_URL}}`/`{{SUPPORT_EMAIL}}`, which also appear in text). Search and replace:

| Placeholder | What to set it to | Where |
| --- | --- | --- |
| `{{ZIP_URL}}` | The private/tokened URL the `.zip` is served from (see the manual step below). | `const ZIP_URL` in `index.html`. |
| `{{SUPPORT_EMAIL}}` | The support email address for buyers. | `const SUPPORT_EMAIL` in `index.html`. |
| `WORKER_ORIGIN` | The live licence Worker origin. Currently set to `https://microtools-licence.lipmichal.workers.dev` — confirm this is correct, or repoint it. | `const WORKER_ORIGIN` in `index.html`. |

Until `{{ZIP_URL}}` is filled, a verified buyer still sees the confirmed order and
checksum; the download button renders inactive with a note to email support. Fill the
placeholder and it becomes a live download.

The success URL you configure in Stripe (or in the Worker redirect) must land the buyer
on this page with the token in the fragment, e.g.
`https://toolsthatrank.com/get/#k=<token>` or `https://toolsthatrank.com/get/#s=<session_id>`.

## The one manual step: host the `.zip` privately

The product archive is at:

```
/Users/mike/Desktop/ToolsThatRank/ToolsThatRank-1.0.0.zip
sha256  1083ce0c3f5d5d527a798144aa5ce0896dbe133854ea0dd253db15387dd573f0
```

**Do NOT commit it to the public GitHub Pages repo.** Anything in that repo is a public,
un-gated free download, which defeats the paywall. Upload the `.zip` to a private or
tokened location instead — for example an R2 / S3 bucket object served through a signed
or capability URL, or the Worker's own gated `/download` path (which already verifies the
licence token server-side before streaming the file). Then set `{{ZIP_URL}}` to that URL.

The `sha256` above is embedded verbatim in `index.html` so a buyer can verify integrity
with `shasum -a 256 ToolsThatRank-1.0.0.zip`. If you ever rebuild the archive, recompute
it and update `#sha256` in the page.

## Test

```
node verify.test.mjs      # expect: RESULT: 19/19
```

No network, no keys. The test generates a throwaway keypair, signs tokens with it, and
verifies them through a key-injected `makeVerifier` — the real signing key is never used.

## Not done here (by design)

This is build-only. Nothing is deployed, no Stripe call is made, and the Worker is not
touched. Wiring the checkout link, the webhook, and the deploy is the operator's gated
step.
