import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../convex/_generated/api";
import { useAuthed, useSession } from "./session";

/**
 * Which of the account's keys are saved (Settings → Connections), by their last four characters. Undefined while it
 * loads; null for a temporary guest, who has no account.
 */
export function useConnections() {
  const { token } = useAuthed();
  return useQuery(api.accounts.connections, { token });
}

/**
 * True once it's known the account has no TMDB key that works (none, or one TMDB refuses). Home, Search and title pages
 * then run on the addons and Cinemeta, and leave out what only TMDB has (trending rows, picks, people, genre browsing)
 * rather than asking for it and failing. A party guest, with no account, plays on as before.
 */
export function useNeedsTmdbKey() {
  const status = useOnboardingStatus();
  return !!status && status.tmdb !== "valid";
}

/**
 * True once it's known the account has no TMDB key at all. /api/rows refuses only then: with a key TMDB turned down it
 * still answers its Cinemeta rows (popular, top-rated by genre), leaving out only TMDB's and Netflix's.
 */
export function useHasNoTmdbKey() {
  return useOnboardingStatus()?.tmdb === "none";
}

/**
 * Where the session's account and profile are in onboarding (convex/onboarding.ts): its keys, whether each still
 * works, and the steps it went past. Undefined while it loads; null for a party guest or no session.
 */
export function useOnboardingStatus() {
  const { token } = useSession();
  return useQuery(api.onboarding.status, token ? { token } : "skip");
}

/**
 * True once it's known the account can't host a party or play in the browser: both stream from TorBox, so they need a
 * TorBox key TorBox still accepts (a guest, with no account, never hosts either).
 */
export function useNeedsTorBox() {
  const status = useOnboardingStatus();
  return status !== undefined && status?.torbox !== true;
}

/**
 * True once it's known the profile can't play: alone, Play streams from the account's debrid service or an addon's
 * plain web video, so it needs a debrid key its service still accepts or a stream addon. TorBox's play anywhere;
 * another service's and plain web videos play in the browser when they're MP4, WebM or HLS, and in the desktop app or
 * an external player otherwise.
 */
export function useNeedsDebrid() {
  const status = useOnboardingStatus();
  return status !== undefined && status?.play !== true;
}

/** Why Play can't start here, said up front instead of failing once a stream job runs (docs/models/Onboarding.tla). */
export const PLAY_NEEDS_DEBRID = "Playing needs a debrid service";

export type DebridService = "torbox" | "realdebrid" | "alldebrid" | "premiumize" | "debridlink" | "offcloud" | "easydebrid";

/** Every debrid service an account can use, TorBox first, with where each one shows its API key. */
export const DEBRID_SERVICES: { value: DebridService; name: string; keys: string }[] = [
  { value: "torbox", name: "TorBox", keys: "https://torbox.app/settings" },
  { value: "realdebrid", name: "Real-Debrid", keys: "https://real-debrid.com/apitoken" },
  { value: "alldebrid", name: "AllDebrid", keys: "https://alldebrid.com/apikeys/" },
  { value: "premiumize", name: "Premiumize", keys: "https://www.premiumize.me/account" },
  { value: "debridlink", name: "Debrid-Link", keys: "https://debrid-link.com/webapp/apikey" },
  { value: "offcloud", name: "Offcloud", keys: "https://offcloud.com/#/account" },
  { value: "easydebrid", name: "EasyDebrid", keys: "https://easydebrid.com" },
];

export const debridName = (service: DebridService) => DEBRID_SERVICES.find((s) => s.value === service)!.name;

const referral = ((import.meta.env.VITE_TORBOX_REFERRAL as string | undefined) ?? "").trim();
/**
 * Where to sign up for TorBox: a referral link when this build has one (VITE_TORBOX_REFERRAL, a whole link or just
 * the referral code), else TorBox's own page.
 */
export const TORBOX_SIGNUP = !referral
  ? "https://torbox.app"
  : /^https?:\/\//.test(referral)
    ? referral
    : `https://torbox.app/subscription?referral=${encodeURIComponent(referral)}`;
