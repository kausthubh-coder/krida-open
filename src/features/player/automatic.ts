// Automatic playback (skip intros and recaps, play the next episode): your own switches, or in a party everyone's.
import { useUpdateProfile } from "../../data/profile";
import type { Me } from "../../data/session";
import type { Member } from "../party";

export type AutoKey = "skipIntro" | "skipRecap" | "autoNext";
export const AUTO_ROWS: { key: AutoKey; label: string }[] = [
  { key: "skipIntro", label: "Skip intros" },
  { key: "skipRecap", label: "Skip recaps" },
  { key: "autoNext", label: "Play next episode" },
];
/** Parts that skip themselves. Credits never do: films have scenes after them, and episodes get Up next. */
export const AUTO_SKIPS = [
  { part: "intro", setting: "skipIntro" },
  { part: "recap", setting: "skipRecap" },
] as const;
export type SkipPart = (typeof AUTO_SKIPS)[number]["part"];
/** Shorter "intros" are usually bad data. */
export const MIN_AUTO_SKIP = 5;

export function joinNames(names: string[]) {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * A skip or moving on changes things for everyone, so it happens only when everyone watching has it on.
 */
export function useAutomatic(online: Member[], me: Me, token: string) {
  const updateProfile = useUpdateProfile();
  const others = online.filter((x) => !x.isMe && x.watching);
  const mine = (key: AutoKey) => me.prefs[key] !== false;
  const allOn = (key: AutoKey) => mine(key) && others.every((x) => x.auto[key]);
  const setMine = (key: AutoKey, on: boolean) => void updateProfile({ token, prefsPatch: { [key]: on } });
  /** "On for both of you", or "On for you · off for Sam". */
  const whoHasIt = (key: AutoKey) => {
    const on = [...(mine(key) ? ["you"] : []), ...others.filter((x) => x.auto[key]).map((x) => x.name)];
    const off = [...(mine(key) ? [] : ["you"]), ...others.filter((x) => !x.auto[key]).map((x) => x.name)];
    const everyone = others.length === 1 ? "both of you" : "everyone";
    if (off.length === 0) return `On for ${everyone}`;
    if (on.length === 0) return `Off for ${everyone}`;
    return `On for ${joinNames(on)} · off for ${joinNames(off)}`;
  };
  return { others, mine, allOn, setMine, whoHasIt, autoNextOn: allOn("autoNext") };
}
