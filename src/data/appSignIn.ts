import type { useClerk } from "@clerk/react";
import type { OAuthStrategy } from "@clerk/react/types";
import { toast } from "../ui/toast";
import { android, onAndroid } from "../ui/android";
import { desktopApp } from "./desktop";
import { logProblem } from "./log";

/*
 * Signing in with Google inside Krida's apps. Google refuses to sign anyone in inside an app's web view (Android's
 * WebView, WKWebView, WebView2), so there Clerk's "Continue with Google" opens Google in the phone's or computer's own
 * browser instead, as Clerk's native SDKs do: the sign-in is made here with a redirect to the app (Android's
 * `app.krida://sso-callback`, the desktop app's page on 127.0.0.1), the browser comes back to it, and the app hands
 * this page the link it came back on. Clerk then has the finished sign-in, or a new account to make (a transfer).
 * A code by email never leaves the page. In a browser, and in apps from before this, Clerk does it all as usual.
 */

type Clerk = ReturnType<typeof useClerk>;

/** What an app lends this: the link to come back to, opening the browser, and hearing it come back. */
export type Outside = {
  redirect(): Promise<string>;
  open(url: string): Promise<void>;
  onReturn(listener: (url: string) => void): () => void;
  /** A sign-in that came back while this page wasn't loaded (Android, when the app had been closed). */
  returned(): string | null;
};

/** Krida for Android or for Windows and Mac, when it signs in through the browser; null anywhere else. */
function outside(): Outside | null {
  const phone = android;
  if (phone?.openSignIn && phone.signInRedirect) {
    return {
      redirect: async () => phone.signInRedirect!(),
      open: async (url) => phone.openSignIn!(url),
      onReturn: (listener) => onAndroid((e) => e.type === "signin" && listener(e.url)),
      returned: () => phone.signInCallback?.() || null,
    };
  }
  const app = window.kridaDesktop?.signIn ? desktopApp() : null;
  if (app) {
    return {
      redirect: () => app.core.invoke<string>("sign_in_listen"),
      open: (url) => app.core.invoke("sign_in_open", { url }),
      onReturn: (listener) => {
        let off: (() => void) | null = null;
        let live = true;
        void app.event.listen<string>("signin", (e) => listener(e.payload)).then((stop) => (live ? (off = stop) : stop()));
        return () => {
          live = false;
          off?.();
        };
      },
      returned: () => null,
    };
  }
  return null;
}

/** The provider a Clerk social button signs in with (`cl-socialButtonsBlockButton__google`), or null for any other. */
export function strategyOf(classNames: Iterable<string>): OAuthStrategy | null {
  for (const name of classNames) {
    const provider = /^cl-socialButtons(?:Block|Icon)Button__([a-z0-9_]+)$/.exec(name)?.[1];
    if (provider && !provider.startsWith("web3")) return `oauth_${provider}` as OAuthStrategy;
  }
  return null;
}

/** Starts a sign-in with `strategy` that comes back to the app, and opens its page in the browser. */
export async function signInOutside(clerk: Clerk, app: Outside, strategy: OAuthStrategy) {
  const redirectUrl = await app.redirect();
  const signIn = await clerk.client!.signIn.create({ strategy, redirectUrl });
  const page = signIn.firstFactorVerification.externalVerificationRedirectURL;
  if (!page) throw new Error(`Clerk gave no page to sign in with ${strategy}`);
  await app.open(page.href);
}

/**
 * Finishes the sign-in the browser came back from (`link` is where it landed): signs in, or makes the account when
 * that Google account is new to Krida. Throws when neither happened.
 */
export async function finishSignIn(clerk: Clerk, link: string) {
  const nonce = new URL(link).searchParams.get("rotating_token_nonce") ?? undefined;
  const client = clerk.client!;
  const signIn = await client.signIn.reload({ rotatingTokenNonce: nonce });
  if (signIn.status === "complete") return clerk.setActive({ session: signIn.createdSessionId });
  if (signIn.firstFactorVerification.status === "transferable") {
    const signUp = await client.signUp.create({ transfer: true });
    if (signUp.status === "complete") return clerk.setActive({ session: signUp.createdSessionId });
    throw new Error(`The new account needs ${signUp.missingFields.join(", ") || signUp.status}`);
  }
  throw new Error(`Signing in came back ${signIn.status ?? "empty"} (${signIn.firstFactorVerification.status ?? "unverified"})`);
}

function failed(error: unknown) {
  logProblem("signin", error instanceof Error ? error.message : String(error));
  toast.error("Couldn't sign in with Google", { description: "Try again, or use a code by email." });
}

/**
 * In an app, Clerk's social buttons sign in through the browser. Call once Clerk has loaded; returns the undo.
 * The click is taken before Clerk's own handler, which would open Google inside the app.
 */
export function startAppSignIn(clerk: Clerk) {
  const app = outside();
  if (!app) return () => {};
  const click = (e: MouseEvent) => {
    const button = e.target instanceof Element ? e.target.closest("button") : null;
    const strategy = button ? strategyOf(button.classList) : null;
    if (!strategy) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    signInOutside(clerk, app, strategy).catch(failed);
  };
  document.addEventListener("click", click, true);
  const stop = app.onReturn((link) => void finishSignIn(clerk, link).catch(failed));
  const early = app.returned();
  if (early) finishSignIn(clerk, early).catch(failed);
  return () => {
    document.removeEventListener("click", click, true);
    stop();
  };
}
