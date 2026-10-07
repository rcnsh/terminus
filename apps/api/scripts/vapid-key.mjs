/**
 * Makes a VAPID key for Web Push: a P-256 private key as a JWK,
 * the value of the VAPID_PRIVATE_KEY secret. Once only: changing it drops
 * every web app's subscription until it subscribes again.
 *
 *   node scripts/vapid-key.mjs > ../../.private/vapid-private-key.json
 *   pnpm exec cf workers secrets update VAPID_PRIVATE_KEY --worker terminus --type secret_text --text "$(cat ../../.private/vapid-private-key.json)"
 */
const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', privateKey);
process.stdout.write(JSON.stringify({ kty, crv, x, y, d }));
