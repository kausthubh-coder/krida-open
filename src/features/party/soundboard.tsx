import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { cx, Toggle } from "../../ui/ui";
import animeWow from "./sounds/anime-wow.mp3";
import rizz from "./sounds/rizz.mp3";
import vineBoom from "./sounds/vine-boom.mp3";
import tacoBell from "./sounds/taco-bell.mp3";
import rukoZara from "./sounds/ruko-zara.mp3";
import sus from "./sounds/sus.mp3";
import ohNo from "./sounds/oh-no.mp3";
import huhCat from "./sounds/huh-cat.mp3";
import ewBrother from "./sounds/ew-brother.mp3";
import metalPipe from "./sounds/metal-pipe.mp3";
import fahh from "./sounds/fahh.mp3";
import emotionalDamage from "./sounds/emotional-damage.mp3";

/**
 * Party reactions are meme sounds. The emoji is what's sent and what floats over the picture, so a
 * tab from before this still shows them; the sound plays for everyone in the party. In rows of four:
 * hype, tension, and things going wrong.
 */
const REACTIONS = [
  { emoji: "🤩", label: "Anime wow", short: "Wow", sound: animeWow },
  { emoji: "😏", label: "Rizz", short: "Rizz", sound: rizz },
  { emoji: "💥", label: "Vine boom", short: "Boom", sound: vineBoom },
  { emoji: "🔔", label: "Taco Bell bong", short: "Bong", sound: tacoBell },
  { emoji: "⏳", label: "Ruko zara, sabar karo", short: "Ruko zara", sound: rukoZara },
  { emoji: "📮", label: "Sus", short: "Sus", sound: sus },
  { emoji: "😬", label: "Oh no no no", short: "Oh no", sound: ohNo },
  { emoji: "🐱", label: "Huh? cat", short: "Huh?", sound: huhCat },
  { emoji: "🤢", label: "Ew brother", short: "Ew", sound: ewBrother },
  { emoji: "🔩", label: "Metal pipe", short: "Pipe", sound: metalPipe },
  { emoji: "😫", label: "Fahhh", short: "Fahhh", sound: fahh },
  { emoji: "💔", label: "Emotional damage", short: "Damage", sound: emotionalDamage },
] as const;

const byEmoji = new Map<string, (typeof REACTIONS)[number]>(REACTIONS.map((r) => [r.emoji, r]));

/**
 * The clips are normalized to the same loudness; this sits them a little under a film's dialogue.
 * In the player they follow its volume, so a film turned down for the night doesn't get a loud meme.
 */
const GAIN = 0.7;

/** Sounds are per device: one of you can mute them without muting the other. */
const PREF_KEY = "krida.reactionSounds";
const soundsOn = () => localStorage.getItem(PREF_KEY) !== "off";

function useReactionSoundsPref() {
  const [on, setOn] = useState(soundsOn);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === PREF_KEY && setOn(e.newValue !== "off");
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const set = (value: boolean) => {
    localStorage.setItem(PREF_KEY, value ? "on" : "off");
    setOn(value);
  };
  return [on, set] as const;
}

// Web Audio rather than <audio>: it mixes over the film without pausing it on phones, starts without
// a network wait once decoded, and lets a new reaction cut off the last one.
let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const playing = new Map<string, { source: AudioBufferSourceNode; emoji: string }>();

// Which sounds are playing right now, so their tiles light up: the sound is never the only sign.
let sounding: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
function changed() {
  sounding = new Set([...playing.values()].map((p) => p.emoji));
  for (const l of listeners) l();
}
function useSounding() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sounding,
  );
}

function context() {
  try {
    ctx ??= new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

function load(url: string) {
  let buffer = buffers.get(url);
  if (!buffer) {
    const ac = context();
    buffer = ac
      ? fetch(url)
          .then((r) => r.arrayBuffer())
          .then((data) => ac.decodeAudioData(data))
          .catch(() => {
            buffers.delete(url);
            return null;
          })
      : Promise.resolve(null);
    buffers.set(url, buffer);
  }
  return buffer;
}

async function play(emoji: string, sender: string) {
  const reaction = byEmoji.get(emoji);
  const ac = context();
  if (!reaction || !ac || !soundsOn()) return;
  if (ac.state !== "running") {
    // Before any click or key on the page the browser won't play; a late burst would be worse than none.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    void ac.resume();
  }
  // iPhones mute Web Audio with the silent switch unless the page says it's playing media, as the film is.
  const session = (navigator as { audioSession?: { type: string } }).audioSession;
  if (session) session.type = "playback";
  const buffer = await load(reaction.sound);
  if (!buffer) return;
  // One sound per person at a time, so tapping fast replaces rather than piles up.
  playing.get(sender)?.source.stop();
  const source = ac.createBufferSource();
  source.buffer = buffer;
  const gain = ac.createGain();
  gain.gain.value = GAIN * (document.querySelector("video")?.volume ?? 1);
  source.connect(gain).connect(ac.destination);
  source.onended = () => {
    if (playing.get(sender)?.source !== source) return;
    playing.delete(sender);
    changed();
  };
  playing.set(sender, { source, emoji });
  changed();
  source.start();
}

/** Yours plays the moment you tap; when it comes back from the server, that copy stays quiet. */
const echoes: { emoji: string; at: number }[] = [];
function isEcho(emoji: string) {
  const i = echoes.findIndex((e) => e.emoji === emoji && Date.now() - e.at < 5000);
  if (i >= 0) echoes.splice(i, 1);
  return i >= 0;
}

/**
 * Plays everyone's reactions on this device. One caller per screen (the player or the dock), the
 * same places that blip for chat.
 */
export function useReactionSounds(roomId: Id<"rooms">) {
  const { token, me } = useAuthed();
  const messages = useQuery(api.messages.list, { token, roomId });
  const heard = useRef<number | null>(null);
  useEffect(() => {
    for (const r of REACTIONS) void load(r.sound);
  }, []);
  useEffect(() => {
    if (!messages) return;
    const reactions = messages.filter((m) => m.kind === "reaction");
    // Only what arrives from now on: opening the party doesn't replay the last few.
    if (heard.current !== null) {
      for (const m of reactions) {
        if (m.createdAt <= heard.current || (m.profileId === me._id && isEcho(m.body))) continue;
        void play(m.body, m.profileId);
      }
    }
    heard.current = Math.max(heard.current ?? 0, reactions.at(-1)?.createdAt ?? 0);
  }, [messages, me._id]);
}

/** The board: emoji to spot one fast, its name underneath, and the switch for this device. */
export function ReactionPicker({ onReact, className }: { onReact: (emoji: string) => void; className?: string }) {
  const { me } = useAuthed();
  const [on, setOn] = useReactionSoundsPref();
  const now = useSounding();
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      {/* Tiles touch, so there's no dead gap between targets; the inset ring survives the panel's clipping. */}
      <div className="grid grid-cols-4">
        {REACTIONS.map((r) => (
          <button
            key={r.emoji}
            aria-label={`React with ${r.label}`}
            title={r.label}
            onClick={() => {
              echoes.push({ emoji: r.emoji, at: Date.now() });
              void play(r.emoji, me._id);
              onReact(r.emoji);
            }}
            className={cx(
              "press flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-control px-1 focus-visible:outline-offset-[-2px]",
              now.has(r.emoji) ? "bg-white/12" : "hover:bg-white/8",
            )}
          >
            <span aria-hidden className="text-[20px] leading-none">
              {r.emoji}
            </span>
            <span className={cx("w-full truncate text-center text-caption", now.has(r.emoji) ? "text-fg" : "text-fg-muted")}>
              {r.short}
            </span>
          </button>
        ))}
      </div>
      <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-control px-3 py-1 hover:bg-white/8 pointer-coarse:min-h-11">
        <span className="min-w-0 flex-1 text-body text-fg-muted">Play sounds on this device</span>
        <Toggle checked={on} onChange={setOn} />
      </label>
    </div>
  );
}
