/*
 * Whether someone has signed in to Krida on this device, read before anything else loads (src/main.tsx): a visitor
 * who never has gets only the landing page, without the app's code. Wrong either way costs little: a signed-in person
 * the hint misses sees the landing page and its Sign in finds them signed in; a stale hint loads the app, which shows
 * the landing page itself when nobody is signed in.
 */

const HINT = "krida.signedIn";
// session.ts's keys: a profile chosen on this device (one per backend a preview can use).
const SESSION_KEYS = ["krida.session", "krida.session.production"];

export function signedInHere(): boolean {
  try {
    if (localStorage.getItem(HINT) || SESSION_KEYS.some((k) => localStorage.getItem(k))) return true;
  } catch {
    // Storage blocked: fall back to Clerk's own cookie.
  }
  // Clerk's "client updated at" cookie on this site: 0 when signed out, a time when signed in.
  return /(?:^|;\s*)__client_uat(?:_[\w-]+)?=(?!0(?:;|$))\d+/.test(document.cookie);
}

/**
 * Inside Krida for Android or the desktop app: it is Krida already, so a signed-out person goes straight to sign-in
 * rather than the page that tells them about it (both apps put these on the window before the page's scripts run).
 */
export function inApp(): boolean {
  return "KridaAndroid" in window || "kridaDesktop" in window;
}

/** Kept by the account provider as Clerk signs in and out. */
export function rememberSignedIn(on: boolean) {
  try {
    if (on) localStorage.setItem(HINT, "1");
    else localStorage.removeItem(HINT);
  } catch {
    // Without storage the cookie still says it.
  }
}
