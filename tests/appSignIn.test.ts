import { describe, expect, test } from "vitest";
import { finishSignIn, signInOutside, strategyOf, type Outside } from "../src/data/appSignIn";

type Clerk = Parameters<typeof finishSignIn>[0];

/** A stand-in for Clerk with one sign-in, as it reads after the browser came back; `calls` records what was asked. */
function fakeClerk(after: { status: string | null; verification: string | null; signUp?: { status: string; missingFields?: string[] } }) {
  const calls: unknown[][] = [];
  const signIn = {
    status: after.status,
    createdSessionId: after.status === "complete" ? "sess_in" : null,
    firstFactorVerification: { status: after.verification, externalVerificationRedirectURL: new URL("https://accounts.google.com/o/oauth2/auth?state=s1") },
    create: async (params: unknown) => (calls.push(["signIn.create", params]), signIn),
    reload: async (params: unknown) => (calls.push(["signIn.reload", params]), signIn),
  };
  const signUp = {
    create: async (params: unknown) => {
      calls.push(["signUp.create", params]);
      const status = after.signUp?.status ?? "missing_requirements";
      return { status, createdSessionId: status === "complete" ? "sess_up" : null, missingFields: after.signUp?.missingFields ?? [] };
    },
  };
  const clerk = {
    client: { signIn, signUp },
    setActive: async (params: unknown) => void calls.push(["setActive", params]),
  } as unknown as Clerk;
  return { clerk, calls };
}

describe("which Clerk buttons sign in through the browser", () => {
  test("Google's button, block or icon, signs in with Google", () => {
    expect(strategyOf(["cl-socialButtonsBlockButton", "cl-button", "cl-socialButtonsBlockButton__google", "cl-button__google"])).toBe("oauth_google");
    expect(strategyOf(["cl-socialButtonsIconButton", "cl-socialButtonsIconButton__github"])).toBe("oauth_github");
  });

  test("anything else stays Clerk's: the email button, a wallet, a plain button", () => {
    expect(strategyOf(["cl-formButtonPrimary", "cl-button"])).toBe(null);
    expect(strategyOf(["cl-socialButtonsBlockButton__web3_metamask"])).toBe(null);
    expect(strategyOf([])).toBe(null);
  });
});

describe("signing in through the browser", () => {
  test("the sign-in comes back to the app's link, and Google's page opens in the browser", async () => {
    const { clerk, calls } = fakeClerk({ status: "needs_identifier", verification: "unverified" });
    const opened: string[] = [];
    const app: Outside = {
      redirect: async () => "app.krida://sso-callback",
      open: async (url) => void opened.push(url),
      onReturn: () => () => {},
      returned: () => null,
    };
    await signInOutside(clerk, app, "oauth_google");
    expect(calls).toEqual([["signIn.create", { strategy: "oauth_google", redirectUrl: "app.krida://sso-callback" }]]);
    expect(opened).toEqual(["https://accounts.google.com/o/oauth2/auth?state=s1"]);
  });

  test("an account Krida knows: the finished sign-in becomes the session, with the nonce Clerk sent back", async () => {
    const { clerk, calls } = fakeClerk({ status: "complete", verification: "verified" });
    await finishSignIn(clerk, "app.krida://sso-callback?rotating_token_nonce=n42");
    expect(calls).toEqual([
      ["signIn.reload", { rotatingTokenNonce: "n42" }],
      ["setActive", { session: "sess_in" }],
    ]);
  });

  test("a Google account new to Krida makes the account and signs in to it", async () => {
    const { clerk, calls } = fakeClerk({ status: "needs_identifier", verification: "transferable", signUp: { status: "complete" } });
    await finishSignIn(clerk, "http://127.0.0.1:53111/sso-callback");
    expect(calls).toEqual([
      ["signIn.reload", { rotatingTokenNonce: undefined }],
      ["signUp.create", { transfer: true }],
      ["setActive", { session: "sess_up" }],
    ]);
  });

  test("a sign-in that didn't finish (Google closed, refused) signs nobody in and says why", async () => {
    const { clerk, calls } = fakeClerk({ status: "needs_identifier", verification: "failed" });
    await expect(finishSignIn(clerk, "app.krida://sso-callback")).rejects.toThrow("Signing in came back needs_identifier (failed)");
    expect(calls).toEqual([["signIn.reload", { rotatingTokenNonce: undefined }]]);
  });

  test("a new account Clerk wants more for is not signed in to", async () => {
    const { clerk } = fakeClerk({ status: "needs_identifier", verification: "transferable", signUp: { status: "missing_requirements", missingFields: ["username"] } });
    await expect(finishSignIn(clerk, "app.krida://sso-callback")).rejects.toThrow("The new account needs username");
  });
});
