import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePageShown } from "../../ui/pageShown";
import { animate } from "motion/react";
import { playTrailer, type TrailerControls, type TrailerSource } from "./trailerPlayer";
import { cx } from "../../ui/ui";

// Sound comes in with the picture rather than at full volume. Ease-in, because loudness is heard on a log
// scale: a straight ramp would sound like it jumps up at the start.
const SOUND_FADE = { duration: 0.5, ease: "easeIn" } as const;

/**
 * A title's trailer playing silently behind artwork, with no controls, sized to cover its frame: IMDb's file
 * when there is one, else YouTube (`trailerPlayer.ts`). It stays invisible until it is actually playing, so the
 * artwork under it never flashes black or a spinner, and silent until then too, so the sound never starts
 * before the picture. Paused, it hides again. A trailer that won't play moves on to the next source; when none
 * play, the artwork simply stays. `delay` waits before loading anything, so passing by costs nothing.
 */
export function AmbientTrailer({
  kind,
  sources,
  active: wanted,
  muted,
  delay = 0,
  onShown,
  onEnded,
  className,
}: {
  /** Which shared YouTube player it plays in, when it falls back to YouTube. */
  kind: "banner" | "poster";
  /** Best first. */
  sources: TrailerSource[];
  /** Playing when true, paused when false (it keeps its place). */
  active: boolean;
  muted: boolean;
  delay?: number;
  onShown?: (shown: boolean) => void;
  onEnded?: () => void;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const slot = useRef<HTMLDivElement>(null);
  const controls = useRef<TrailerControls | null>(null);
  const source = sources[index];
  const sourceKey = source && (source.kind === "file" ? source.url : source.id);
  // Read by the player's events without re-creating it. Kept current in a layout effect, before the one below.
  // On a kept page you've left, it stops as it would have on a page that had gone.
  const pageShown = usePageShown();
  const active = wanted && pageShown;
  const latest = useRef({ active, muted, source, onShown, onEnded });
  useLayoutEffect(() => {
    latest.current = { active, muted, source, onShown, onEnded };
  });

  useEffect(() => {
    if (!active || mounted || !sourceKey) return;
    const t = setTimeout(() => setMounted(true), delay);
    return () => clearTimeout(t);
  }, [active, mounted, sourceKey, delay]);

  // A layout effect, so a shared YouTube player leaves the slot before React takes the slot off the page.
  useLayoutEffect(() => {
    const { source } = latest.current;
    if (!mounted || !source || !slot.current) return;
    const show = (on: boolean) => {
      setShown(on);
      latest.current.onShown?.(on);
    };
    const release = playTrailer(kind, slot.current, source, {
      onReady: (c) => {
        controls.current = c;
        if (latest.current.active) c.play();
        else c.pause();
      },
      onState: (state) => {
        if (state === 1) show(true);
        // Paused, YouTube shows "More videos" over the picture.
        if (state === 2) show(false);
        if (state === 0) {
          show(false);
          latest.current.onEnded?.();
        }
      },
      onError: () => {
        show(false);
        controls.current = null;
        setIndex((i) => i + 1);
      },
      onLost: () => {
        show(false);
        controls.current = null;
      },
    });
    return () => {
      controls.current = null;
      release();
    };
  }, [kind, mounted, sourceKey]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (active) c.play();
    else c.pause();
  }, [active]);

  // Heard only while it can be seen. It starts muted, and is ready before it can show.
  const audible = shown && !muted;
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    if (!audible) {
      c.mute();
      return;
    }
    c.setVolume(0);
    c.unMute();
    const fade = animate(0, 100, { ...SOUND_FADE, onUpdate: (v) => c.setVolume(Math.round(v)) });
    return () => fade.stop();
  }, [audible]);

  // Tell the parent it's hidden again when this goes away mid-play.
  useEffect(() => () => latest.current.onShown?.(false), []);

  if (!mounted || !source) return null;
  return (
    <div
      ref={slot}
      aria-hidden
      className={cx(
        "pointer-events-none absolute inset-0 overflow-hidden transition-opacity",
        shown ? "opacity-100 duration-300 ease-out" : "opacity-0 duration-200 ease-in",
        className,
      )}
      style={{ containerType: "size" }}
    />
  );
}
