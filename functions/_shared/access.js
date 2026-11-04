/**
 * ============================================================================
 * TEMPORARY — delete this file before launch.
 * ============================================================================
 *
 * Verifies a Cloudflare Access JWT so the sign-in code can be shown on the
 * preview deployment while Twilio is still pending. It exists so Justin can
 * use the live dashboard, and it comes out the moment SMS works.
 *
 * Deleting it means: remove this file, remove the accessDevCodeAllowed()
 * call in api/auth/request-code.js, and unset DEV_CODE_VIA_ACCESS,
 * DEV_CODE_EMAILS, ACCESS_TEAM_DOMAIN and ACCESS_AUD.
 *
 * ---------------------------------------------------------------------------
 * What this is actually trusting
 *
 * Cloudflare Access puts a signed JWT in Cf-Access-Jwt-Assertion after a user
 * authenticates. The header alone proves nothing — anything can set a header.
 * The signature is the proof, so this verifies all of it:
 *
 *   - alg is RS256. An unverified `alg` field is the classic JWT hole:
 *     accepting "none" means any payload passes, and accepting HS256 lets an
 *     attacker sign with the public key as the HMAC secret.
 *   - the signature checks out against the team's published public keys,
 *     matched by `kid`
 *   - `aud` contains this application's AUD tag, so a valid token for some
 *     other Access app in the same account does not work here
 *   - `iss` is this team's domain
 *   - `exp` has not passed, and `nbf` has
 *   - the email in the token is on an explicit allow list
 *
 * Every failure path returns false. Nothing here throws into the caller.
 * ---------------------------------------------------------------------------
 */

const CERTS_CACHE_SECONDS = 3600;

const b64urlToBytes = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/** The team's public signing keys, as JWKs. */
async function fetchCerts(teamDomain) {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    cf: { cacheTtl: CERTS_CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return Array.isArray(body?.keys) ? body.keys : null;
}

/**
 * Verify an Access JWT. Returns the payload on success, null on any failure.
 */
export async function verifyAccessJwt(token, { teamDomain, aud }) {
  if (!token || !teamDomain || !aud) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = b64urlToJson(headerB64);
    payload = b64urlToJson(payloadB64);
  } catch { return null; }

  // Pin the algorithm. Never read it and go along with whatever it says.
  if (header?.alg !== 'RS256' || !header?.kid) return null;

  const keys = await fetchCerts(teamDomain);
  if (!keys) return null;
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { ...jwk, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch { return null; }
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;

  // aud may be a string or an array; this app's tag has to be in it.
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) return null;

  const expectedIss = `https://${teamDomain}`;
  if (payload.iss !== expectedIss) return null;

  return payload;
}

/**
 * Is this request allowed to see the sign-in code?
 *
 * Every condition must hold. A missing variable, an unverifiable token or an
 * unlisted email all behave exactly as production does: no code.
 */
export async function accessDevCodeAllowed(request, env) {
  if (env.DEV_CODE_VIA_ACCESS !== '1') return false;

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return false;

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  const allowed = String(env.DEV_CODE_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!teamDomain || !aud || !allowed.length) return false;

  const payload = await verifyAccessJwt(token, { teamDomain, aud });
  if (!payload) return false;

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !allowed.includes(email)) return false;

  // Leaves a trail while this path exists, so its use is reviewable.
  console.warn(`[dev-code] released via Access to ${email}`);
  return true;
}
