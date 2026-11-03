import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";

/*
 * Where Krida sends someone, as docs/models/Onboarding.tla's `Route`: signed out, the landing page; signed in without a
 * profile, the picker (which makes the first one); then the first onboarding step still needed; then Home. Home is
 * never shown without a profile and a TMDB key that works (HomeNeedsProfileAndTmdb). Pure, so tests/onboarding.test.ts
 * checks it with every input.
 */

export type Status = NonNullable<FunctionReturnType<typeof api.onboarding.status>>;
export type Step = "tmdbKey" | "debrid" | "addons" | "extras";
export type Screen = "landing" | "picker" | Step | "home";

export type RouteInput = {
  /** Signed in on this device: a Clerk account, or a QA sign-in. */
  signedIn: boolean;
  /** A profile is chosen. */
  profile: boolean;
  /** onboarding.status: null for a party guest, who has no account and plays on the host's keys. */
  status: Status | null;
};

export function route({ signedIn, profile, status }: RouteInput): Screen {
  if (!signedIn) return "landing";
  if (!profile) return "picker";
  if (status === null) return "home";
  if (status.tmdb !== "valid") return "tmdbKey";
  if (!status.debridAsked) return "debrid";
  if (status.addons === "todo") return "addons";
  if (!status.extrasAsked) return "extras";
  return "home";
}

/** The steps in order, for the progress dots and Back. */
export const STEPS: Step[] = ["tmdbKey", "debrid", "addons", "extras"];

export const stepBefore = (step: Step): Step | null => STEPS[STEPS.indexOf(step) - 1] ?? null;


/** Signed out, / is the landing page; any other address asks to sign in first (then opens it). */
export const signedOutScreen = (path: string): "landing" | "signIn" => (path === "/" ? "landing" : "signIn");

/** Simkl's sign-in comes back here mid-onboarding (its optional step), so the guard lets it finish. */
export const exemptFromOnboarding = (path: string) => path === "/connect/simkl";
