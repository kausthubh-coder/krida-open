import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { ClerkProvider, useAuth, useClerk, useUser } from "@clerk/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { AccountContext, type Account } from "./account";
import { startAppSignIn } from "./appSignIn";
import { rememberSignedIn } from "./hint";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/** Clerk, and Convex signed in through it; plain Convex when this build has no Clerk key (account.ts). */
export function AccountProviders({ client, children }: { client: ConvexReactClient; children: ReactNode }) {
  if (!publishableKey) return <ConvexProvider client={client}>{children}</ConvexProvider>;
  return (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        <ClerkAccount>{children}</ClerkAccount>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function ClerkAccount({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const signOut = useCallback(() => clerk.signOut(), [clerk]);
  // So the next visit to / loads the app straight away, or only the landing page (src/main.tsx).
  useEffect(() => {
    if (isLoaded) rememberSignedIn(!!isSignedIn);
  }, [isLoaded, isSignedIn]);
  // In Krida's apps, Google signs in through the phone's or computer's browser.
  useEffect(() => (isLoaded ? startAppSignIn(clerk) : undefined), [isLoaded, clerk]);
  const value = useMemo<Account>(
    () => ({
      enabled: true,
      loaded: isLoaded,
      signedIn: !!isSignedIn,
      firstName: user?.firstName ?? null,
      email: user?.primaryEmailAddress?.emailAddress ?? null,
      signOut,
    }),
    [isLoaded, isSignedIn, user?.firstName, user?.primaryEmailAddress?.emailAddress, signOut],
  );
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
