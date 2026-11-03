import { createContext, useContext } from "react";

/*
 * The account: one Clerk sign-in (Google, or a code by email). Convex sees it through Clerk's "convex" JWT template,
 * and choosing a profile of the account (profiles.choose) gives the session token everything else takes. Without a
 * publishable key (a cloud VM with no keys, `npm run regress`), there's no Clerk at all and only QA sign-in (/qa)
 * gets in. The providers are in accountProviders.tsx.
 */
export type Account = {
  /** Clerk is set up for this build. */
  enabled: boolean;
  /** Clerk has said whether someone is signed in. */
  loaded: boolean;
  signedIn: boolean;
  /** The Clerk user's first name, to suggest for their first profile. */
  firstName: string | null;
  email: string | null;
  /** Ends the Clerk sign-in on this device (callers end its profile sessions first, while Convex still knows who). */
  signOut: () => Promise<void>;
};

const signedOut: Account = { enabled: false, loaded: true, signedIn: false, firstName: null, email: null, signOut: async () => {} };
export const AccountContext = createContext<Account>(signedOut);

export function useAccount() {
  return useContext(AccountContext);
}
