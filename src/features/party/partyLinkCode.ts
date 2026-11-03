import { useEffect } from "react";
import { useNavigate } from "react-router";

/*
 * A party's invite link, `/party#<code>`: the code stays in the hash, out of request URLs, and is kept for the tab
 * until a profile is chosen, since signing in comes first.
 */
const KEY = "krida.partyLink";

/** Run before anything reads the URL: keeps an invite link's code through sign-in, and takes it out of the address. */
export function keepPartyLink() {
  if (location.pathname !== "/party") return;
  const code = location.hash.slice(1);
  if (!/^[0-9a-f]{32}$/.test(code)) return;
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    // Private mode without storage: the link still works if they're already signed in.
  }
  history.replaceState(history.state, "", "/party");
}

export function pendingPartyLink() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetPartyLink() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

/** Signed in at last: back to the link that brought them, if one did. */
export function usePendingPartyLink(signedIn: boolean) {
  const navigate = useNavigate();
  useEffect(() => {
    if (signedIn && pendingPartyLink() && location.pathname !== "/party") navigate("/party", { replace: true });
  }, [signedIn, navigate]);
}
