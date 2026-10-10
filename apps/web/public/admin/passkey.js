// Passkeys for the operator's pages (/api/admin/passkey/*, src/passkey.ts).
// Signing in gives a session, sent in x-health-token as the token was, that
// lasts 12 hours; adding a passkey needs the HEALTH_TOKEN secret, once per
// device. English only, as the pages are.

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const bytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export const passkeysWork = () => typeof PublicKeyCredential === 'function' && Boolean(navigator.credentials?.create);

async function post(path, body, headers = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), cache: 'no-store' }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  const out = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error('That token was not accepted.');
  if (res.status === 403) throw new Error('That passkey was not accepted. Add it again with the operator token.');
  if (!res.ok) throw new Error(out.error ? `The server said: ${out.error}.` : `The server answered ${res.status}.`);
  return out.session;
}

/** A challenge; with the token, one for adding a passkey, which checks the token first. */
async function challenge(token) {
  const res = await fetch(`/api/admin/passkey/challenge${token ? '?register=1' : ''}`, { headers: token ? { 'x-health-token': token } : {}, cache: 'no-store' }).catch(() => null);
  if (!res) throw new Error("Couldn't reach terminus.");
  if (res.status === 404) throw new Error(token ? 'That token was not accepted.' : 'Passkeys are not set up on this server.');
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return res.json();
}

/** The browser's own refusal (cancelled, timed out, none here) worded for the page. */
function said(err) {
  if (err?.name === 'NotAllowedError') return new Error('No passkey was used. If this device has none, add one below.');
  if (err?.name === 'InvalidStateError') return new Error('This device already has a passkey for this page.');
  return err instanceof Error ? err : new Error(String(err));
}

/** Signs in with a passkey for this site; the session, or throws. */
export async function signIn() {
  const c = await challenge();
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: { challenge: bytes(c.challenge), rpId: c.rpId, userVerification: 'required', timeout: 120_000 } });
  } catch (err) {
    throw said(err);
  }
  const r = cred.response;
  return post('/api/admin/passkey/signin', { id: cred.id, clientData: b64url(r.clientDataJSON), authData: b64url(r.authenticatorData), signature: b64url(r.signature) });
}

/** Makes a passkey on this device, with the HEALTH_TOKEN; the session, or throws. */
export async function addPasskey(token, name) {
  const c = await challenge(token);
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: bytes(c.challenge),
        rp: { id: c.rpId, name: 'terminus operator' },
        // Its own id each time, so a second passkey never replaces the first in a password manager.
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `operator@${c.rpId}`, displayName: `terminus operator (${c.rpId})` },
        pubKeyCredParams: c.algs.map((alg) => ({ type: 'public-key', alg })),
        excludeCredentials: c.exclude.map((id) => ({ type: 'public-key', id: bytes(id) })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        timeout: 120_000,
      },
    });
  } catch (err) {
    throw said(err);
  }
  const r = cred.response;
  const key = r.getPublicKey?.();
  if (!key) throw new Error('This browser can’t add a passkey here. Try a current Chrome, Safari or Firefox.');
  return post(
    '/api/admin/passkey/register',
    { id: cred.id, key: b64url(key), alg: r.getPublicKeyAlgorithm(), clientData: b64url(r.clientDataJSON), authData: b64url(r.getAuthenticatorData()), name },
    { 'x-health-token': token },
  );
}
