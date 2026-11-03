import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../convex/_generated/api";
import { onProduction } from "./backend";
import { useAccount } from "./account";
import { forgetStored } from "./stored";
import { forgetSynced } from "./sync";

// One session per backend, so switching a preview between its own data and yours keeps both signed in.
export const SESSION_KEY = onProduction ? "krida.session.production" : "krida.session";

/** The signed-in profile as the server sends it (profiles.me), prefs included: one shape, written in convex/schema.ts. */
export type Me = NonNullable<FunctionReturnType<typeof api.profiles.me>>;

type Session = {
  token: string | null;
  me: Me | null | undefined;
  setToken: (token: string | null) => void;
  /** Back to the profile picker: ends this device's profile session, keeps the account signed in. */
  signOut: () => Promise<void>;
  /** Signs the account out of this device, with every profile session it chose here. */
  signOutAccount: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem(SESSION_KEY));
  const me = useQuery(api.profiles.me, token ? { token } : "skip");
  const signOutMutation = useMutation(api.profiles.signOut);
  const signOutAccountMutation = useMutation(api.profiles.signOutAccount);
  const account = useAccount();

  const setToken = useCallback((next: string | null) => {
    if (next) localStorage.setItem(SESSION_KEY, next);
    else {
      localStorage.removeItem(SESSION_KEY);
      forgetStored();
      void forgetSynced();
    }
    setTokenState(next);
  }, []);

  const signOut = useCallback(async () => {
    const current = token;
    setToken(null);
    if (current) await signOutMutation({ token: current }).catch(() => {});
  }, [token, setToken, signOutMutation]);

  const signOutAccount = useCallback(async () => {
    // While Clerk still vouches for this device, so the server can find every session it chose here.
    await signOutAccountMutation({ token: token ?? undefined }).catch(() => {});
    setToken(null);
    await account.signOut();
  }, [token, setToken, signOutAccountMutation, account]);

  const value = useMemo<Session>(
    () => ({ token, me: token ? me : null, setToken, signOut, signOutAccount }),
    [token, me, setToken, signOut, signOutAccount],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** For screens behind the profile gate: the token is always present there. */
export function useAuthed() {
  const { token, me } = useSession();
  if (!token || !me) throw new Error("useAuthed outside the profile gate");
  return { token, me };
}
