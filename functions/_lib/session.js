/* Signed session cookie: base64url(JSON {email, exp}) + "." + HMAC-SHA256.
   SESSION_SECRET (a Pages secret) signs it; nothing is stored server-side.

   Single sign-on across the three portals (Chart QA, Answer QA, the Hub)
   works by all three signing this same payload with the same SESSION_SECRET
   and sharing one cookie across subdomains of one registrable domain.
   Cookies can't be shared between two *.pages.dev hosts, so that only comes
   on once the sites are on a real domain:

     SESSION_COOKIE_DOMAIN unset  -> issue "ar_session", host-only (as before)
     SESSION_COOKIE_DOMAIN=aamrut.com -> issue "aamrut_session" for that
                                  domain, which every portal under it accepts

   Either cookie is always *accepted*, so turning it on doesn't sign anyone
   out and turning it off again doesn't either. */

const COOKIE = "ar_session";
const SHARED_COOKIE = "aamrut_session";
const MAX_AGE_S = 60 * 60 * 24 * 14; // 14 days

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  bytes.forEach(b => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/* Length-independent comparison for secrets and signatures. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/* Which cookie this deployment issues, and the Domain attribute it carries. */
function cookieSpec(env) {
  const domain = (env.SESSION_COOKIE_DOMAIN || "").trim();
  return domain
    ? { name: SHARED_COOKIE, attrs: `; Domain=${domain}` }
    : { name: COOKIE, attrs: "" };
}

export async function makeSessionCookie(env, email) {
  const payload = b64url(enc.encode(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S })));
  const sig = b64url(await hmac(env.SESSION_SECRET, payload));
  const { name, attrs } = cookieSpec(env);
  return `${name}=${payload}.${sig}; Path=/${attrs}; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_S}`;
}

/* Signing out clears both names, so one click works whichever is in use. */
export function clearSessionCookie(env = {}) {
  const domain = (env.SESSION_COOKIE_DOMAIN || "").trim();
  const cleared = [`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`];
  if (domain) cleared.push(`${SHARED_COOKIE}=; Path=/; Domain=${domain}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  return cleared;
}

function readCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function verify(env, raw) {
  const [payload, sig] = String(raw).split(".");
  if (!payload || !sig) return null;
  if (!safeEqual(b64url(await hmac(env.SESSION_SECRET, payload)), sig)) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

export async function readSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  // The shared cookie wins: if a reviewer has both, the SSO one is the fresher
  // intent, and a stale host-only cookie shouldn't shadow it.
  for (const name of [SHARED_COOKIE, COOKIE]) {
    const raw = readCookie(request, name);
    if (!raw) continue;
    const data = await verify(env, raw);
    if (data) return data;
  }
  return null;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
