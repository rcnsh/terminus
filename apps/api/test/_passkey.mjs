/**
 * A pretend authenticator for the passkey tests: makes a real key pair and
 * answers create() and get() as a browser would, in the shapes
 * apps/web/public/admin/passkey.js sends.
 */

const enc = new TextEncoder();
export const b64url = (b) => Buffer.from(b).toString('base64url');
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** r‖s as DER, the way authenticators sign with ES256. */
function rawToDer(raw) {
  const int = (v) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    v = v.subarray(i);
    if (v[0] & 0x80) v = cat([0], v);
    return cat([0x02, v.length], v);
  };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat([0x30, body.length], body);
}

/** `alg`: -7 (ES256) or -8 (Ed25519). `flags` overrides the authenticator data's flags. */
export async function makeAuthenticator({ alg = -7, origin = 'https://bus.example.test', rpId = new URL(origin).hostname } = {}) {
  const params = alg === -7 ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'Ed25519' };
  const pair = await crypto.subtle.generateKey(params, true, ['sign', 'verify']);
  const credId = crypto.getRandomValues(new Uint8Array(20));
  const id = b64url(credId);
  const clientData = (type, challenge, o = origin) => enc.encode(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
  const authData = async (flags, extra = new Uint8Array()) => cat(await sha256(enc.encode(rpId)), [flags], [0, 0, 0, 1], extra);
  return {
    id,
    async create(challenge, { flags = 0x45, o } = {}) {
      const attested = cat(new Uint8Array(16), [credId.length >> 8, credId.length & 0xff], credId);
      return {
        id,
        alg,
        key: b64url(await crypto.subtle.exportKey('spki', pair.publicKey)),
        clientData: b64url(clientData('webauthn.create', challenge, o)),
        authData: b64url(await authData(flags, attested)),
        name: 'test device',
      };
    },
    async get(challenge, { flags = 0x05, o } = {}) {
      const cd = clientData('webauthn.get', challenge, o);
      const ad = await authData(flags);
      const signed = cat(ad, await sha256(cd));
      const sig = new Uint8Array(await crypto.subtle.sign(alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' }, pair.privateKey, signed));
      return { id, clientData: b64url(cd), authData: b64url(ad), signature: b64url(alg === -7 ? rawToDer(sig) : sig) };
    },
  };
}
