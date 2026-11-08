/* Sign out: clear the session cookie(s) and go back to the sign-in page.
   Both the host-only and the shared cross-portal cookie are cleared, so a
   reviewer who signed in through the hub is signed out here too. */
import { clearSessionCookie } from "../../_lib/session.js";

function redirect(request, env) {
  const headers = new Headers({ Location: new URL("/login.html", request.url).toString() });
  for (const cookie of clearSessionCookie(env)) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export const onRequestGet = ({ request, env }) => redirect(request, env);
export const onRequestPost = ({ request, env }) => redirect(request, env);
