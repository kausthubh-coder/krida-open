import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePageShown } from "../../ui/pageShown";
import { Film } from "../../ui/film";
import { WHITE } from "../../ui/materials";
import { flushSync } from "react-dom";
import { Link } from "react-router";
import { AnimatePresence, motion, spring } from "motion/react";
import { PlayIcon, SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { Art } from "../../ui/artwork";
import { useLongPress } from "../../ui/longPress";
import { Peek } from "../../ui/peek";
import { AmbientTrailer } from "./ambientTrailer";
import { POSTER_WIDTH } from "../../ui/rail";
import { cardScores, ScoreStack, type ScoreSource } from "../../ui/scores";
import { cx, IconButton, Spinner } from "../../ui/ui";
import { art, type MediaType } from "../../data/cinemeta";
import { warmYouTube } from "./trailerPlayer";
import { useTitleTrailer } from "./trailerSources";
import { usePrefetchTitle } from "../../data/prefetch";
import { useWarmOnHover, type Media } from "../play";
import { useAmbientTrailers, useMarkPreview, useTrailerSound } from "./ambient";

// Resting this long on a poster opens it (hover-intent guidance is 300-500 ms); once one is open, its
// neighbours open almost at once. Resting means settling on the artwork: drifting further than REST_PX starts
// the wait over, so travelling across a poster to its buttons never opens it.
const DWELL_MS = 450;
const REST_PX = 12;
// Leaving keeps it open this long, so slipping off an edge and back doesn't fold the row and open it again.
const CLOSE_DELAY_MS = 400;
const WARM_MS = 180;
const WARM_FOR_MS = 600;
// The trailer starts early in the rest, out of sight, so it is already playing when the poster opens.
const PRIME_MS = 100;
// The trailer file's height for an open poster (about 500 px wide, twice that on a sharp screen).
const FILE_HEIGHT = 720;
// Grows with a little give and settles quietly; closing is quicker and doesn't bounce.
const OPEN = { type: "spring", visualDuration: 0.42, bounce: 0.25 } as const;
const CLOSE = { type: "spring", visualDuration: 0.3, bounce: 0 } as const;
// The same springs as CSS easings ("750ms linear(…)"). The row moves by transforms on CSS transitions, which the
// compositor runs: nothing is laid out again while they play, and a trailer loading or React rendering on the
// main thread can't make them stutter.
const OPEN_EASE = String(spring(OPEN.visualDuration, OPEN.bounce));
const CLOSE_EASE = String(spring(CLOSE.visualDuration, CLOSE.bounce));
// The window over an open poster reaches this far past its left edge, so the spring's overshoot has room.
const SLACK = 40;
// Buttons arriving with the preview settle from 0.9 by its right edge; leaving, they just fade, twice as fast.
const ARRIVE = { initial: { opacity: 0, scale: 0.9 }, animate: { opacity: 1, scale: 1 } } as const;
const LEAVE = { opacity: 0, transition: { duration: 0.1, ease: "easeIn" } } as const;

export type PreviewItem = {
  id: string;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  year?: string;
  genres?: string[];
  description?: string;
  /** The trailer's YouTube id, when the row carries it. */
  trailer?: string;
};

/**
 * A poster that, after the pointer rests on it, widens in place into its backdrop and plays the
 * trailer muted. The row makes room (nothing is covered), and a poster near the row's end pulls the
 * row along so it opens fully on screen. Only with a mouse, never on touch, and not when the profile
 * turned trailers off or motion is reduced; then it is a plain poster.
 *
 * Opening changes the layout once, to the open width, and from then on only moves things: a window
 * over the artwork slides open (two layers moving opposite ways, so its edge moves while the artwork
 * stays put), and the row's cards glide from where they were to where they now are.
 */
export function ExpandingPoster({
  item,
  subtitle,
  caption = true,
  score,
  badge,
  progress,
  actions,
  onPlay,
  playMedia,
  width = POSTER_WIDTH,
}: {
  item: PreviewItem;
  subtitle?: ReactNode;
  /** Over the poster's top corner, e.g. where you stand with the title; it goes with the poster when it opens. */
  badge?: ReactNode;
  /** How far through it you are (0-1), as a bar along the poster's bottom edge. */
  progress?: number;
  /** The name under the poster; without it, the name is there for screen readers only. */
  caption?: boolean;
  score?: ScoreSource;
  actions?: ReactNode;
  onPlay: () => Promise<void>;
  /** What Play would play, worked out on demand so it can be prepared while the pointer rests on Play. */
  playMedia?: () => Promise<Media | undefined>;
  /** The resting width, as classes: Home's poster width, or a grid's column. */
  width?: string;
}) {
  const to = `/title/${item.type}/${item.id}`;
  const enabled = useAmbientTrailers("(hover: hover) and (pointer: fine)");
  const prefetch = usePrefetchTitle(to);
  const root = useRef<HTMLDivElement>(null);
  // The window (its right edge is the poster's), the artwork inside it, and the buttons riding that edge.
  const frame = useRef<HTMLDivElement>(null);
  const artwork = useRef<HTMLDivElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const geometry = useRef({ base: 0, target: 0, shift: 0 });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const primer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Where the current rest began, and where the pointer is now.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const pointerX = useRef(0);
  // Closes it now, while it's waiting out CLOSE_DELAY_MS.
  const closeNow = useRef<(() => void) | null>(null);
  const [warm, setWarm] = useState(false);
  const [primed, setPrimed] = useState(false);
  // Rested on at least once: only then is the open artwork worth loading.
  const [rested, setRested] = useState(false);
  const [open, setOpen] = useState(false);
  // Pressing an open poster leaves its page with the pointer still on it, so nothing else would ever close it.
  const pageShown = usePageShown();
  useEffect(() => {
    if (!pageShown) closeNow.current?.();
  }, [pageShown]);
  const [sized, setSized] = useState(false);
  // The poster's resting width, and its width open. The artwork takes the open size as soon as the pointer
  // arrives, so opening never resizes the trailer (a cross-origin frame, slow to resize) or the backdrop.
  const [rest, setRest] = useState(0);
  const [wide, setWide] = useState(0);
  const [shown, setShown] = useState(false);
  const [sound, setSound] = useTrailerSound();
  useMarkPreview(open);
  // Touch has no hover: a long press opens the title at a glance instead, with Play and the card's actions.
  // Home has hundreds of posters: the sheet is drawn only once a poster has been held.
  const [peeking, setPeeking] = useState<boolean>();
  const longPress = useLongPress(() => setPeeking(true));

  const { sources, meta } = useTitleTrailer(item, FILE_HEIGHT, warm);
  const onYouTube = sources?.[0]?.kind === "youtube";
  const hasScores = !!score && cardScores(score).length > 0;
  const poster = item.poster ?? art.poster(item.id);
  // Anime (Kitsu ids) brings its own backdrop, or an IMDb id whose backdrop TMDB fills in when Metahub has none.
  const linked = meta.data?.imdb_id;
  const backdrop = item.background ?? art.background(item.id) ?? meta.data?.background ?? (linked ? art.background(linked) : undefined);

  // Only titles IMDb has no trailer for need YouTube's player.
  useEffect(() => {
    if (onYouTube) warmYouTube("poster");
  }, [onYouTube]);

  useEffect(() => {
    const el = root.current;
    return () => {
      clearTimeout(timer.current);
      clearTimeout(primer.current);
      clearTimeout(closer.current);
      clearTimeout(settle.current);
      if (closeNow.current) leaving.delete(closeNow.current);
      if (el && opened.delete(el)) snapping(el, false);
    };
  }, []);

  /** Shows `w` px of the open poster from its left edge, springing there with `ease`, or at once. */
  const reveal = (w: number, ease: string | null) => {
    const { target } = geometry.current;
    const parts: [HTMLElement | null, number][] = [
      [frame.current, w - target - SLACK],
      [artwork.current, target + SLACK - w],
      [buttons.current, w - target],
    ];
    for (const [el, x] of parts) if (el) slide(el, x, ease);
  };

  const expand = () => {
    // One open poster at a time: another one still waiting to close goes now.
    for (const close of [...leaving]) close();
    const el = root.current;
    const scroller = el?.closest<HTMLElement>("[data-rail]");
    if (!el || !scroller) return;
    // A poster still closing is back at its resting width already; it opens again from what shows of it.
    const closing = opened.has(el);
    const base = el.offsetWidth;
    const target = openWidth(base);
    const shift = shiftFor(el, scroller, target, pointerX.current);
    if (shift === null) {
      setPrimed(false);
      return;
    }
    const from = closing && frame.current ? target + SLACK + translateOf(frame.current) : base;
    clearTimeout(settle.current);
    // Snapping goes off first, or the row would snap straight back from its shift.
    if (!closing) {
      opened.add(el);
      snapping(el, true);
    }
    let applied = 0;
    glide(scroller, OPEN_EASE, () => {
      flushSync(() => {
        setRest(base);
        setWide(target);
        setSized(true);
        setOpen(true);
      });
      const before = scroller.scrollLeft;
      scroller.scrollLeft += shift;
      applied = scroller.scrollLeft - before;
    });
    geometry.current = { base, target, shift: applied };
    reveal(from, null);
    reveal(target, OPEN_EASE);
  };

  const collapse = () => {
    clearTimeout(timer.current);
    clearTimeout(primer.current);
    setPrimed(false);
    const el = root.current;
    const scroller = el?.closest<HTMLElement>("[data-rail]");
    if (!open || !el || !scroller) return;
    lastClosedAt = performance.now();
    const { base, shift } = geometry.current;
    // Back to its resting width at once: the artwork stays wide while the window closes over it.
    glide(scroller, CLOSE_EASE, () => {
      flushSync(() => setOpen(false));
      scroller.scrollLeft -= shift;
    });
    geometry.current.shift = 0;
    reveal(base, CLOSE_EASE);
    settle.current = setTimeout(() => {
      flushSync(() => setSized(false));
      // Off the spring too, or dropping the transforms would animate.
      for (const part of [frame.current, artwork.current, buttons.current]) {
        part?.style.removeProperty("transition");
        part?.style.removeProperty("transform");
      }
      if (opened.delete(el)) snapping(el, false);
    }, parseFloat(CLOSE_EASE));
  };

  /** Forgets the rest so far, and the trailer loading for it. */
  const cancelOpening = () => {
    clearTimeout(timer.current);
    clearTimeout(primer.current);
    timer.current = undefined;
    anchor.current = null;
    if (!open) setPrimed(false);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // Only a moving mouse counts: a poster that slides under a still pointer as the row makes room stays shut.
    if (!enabled || e.pointerType !== "mouse" || (e.movementX === 0 && e.movementY === 0)) return;
    pointerX.current = e.clientX;
    if (!warm) {
      setWarm(true);
      if (root.current) setWide(openWidth(root.current.offsetWidth));
    }
    if (open) return;
    // The buttons act on the title without opening it, however long the pointer stays on them.
    if ((e.target as Element).closest("[data-card-actions]")) return cancelOpening();
    const at = { x: e.clientX, y: e.clientY };
    const from = anchor.current;
    if (timer.current && from && Math.hypot(at.x - from.x, at.y - from.y) <= REST_PX) return;
    clearTimeout(timer.current);
    clearTimeout(primer.current);
    anchor.current = at;
    const warmRow = opened.size > 0 || performance.now() - lastClosedAt < WARM_FOR_MS;
    if (!primed)
      primer.current = setTimeout(() => {
        setPrimed(true);
        setRested(true);
      }, warmRow ? 0 : PRIME_MS);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      // Not under a status or rating menu that's open.
      if (root.current?.querySelector("[aria-expanded=true]")) return cancelOpening();
      expand();
    }, warmRow ? WARM_MS : DWELL_MS);
  };

  /** Calls off a close that's waiting, when the pointer comes back in time. */
  const stay = () => {
    if (!closeNow.current) return;
    leaving.delete(closeNow.current);
    closeNow.current = null;
    clearTimeout(closer.current);
  };

  const onPointerLeave = () => {
    cancelOpening();
    // A rating or status menu opened from the card keeps it open until the pointer is really gone.
    if (root.current?.querySelector("[aria-expanded=true]")) {
      const watch = (e: PointerEvent) => {
        const el = root.current;
        if (el?.querySelector("[aria-expanded=true]") || el?.contains(e.target as Node)) return;
        document.removeEventListener("pointermove", watch);
        collapse();
      };
      document.addEventListener("pointermove", watch);
      return;
    }
    if (!open) return collapse();
    const close = () => {
      stay();
      collapse();
    };
    closeNow.current = close;
    leaving.add(close);
    closer.current = setTimeout(close, CLOSE_DELAY_MS);
  };

  const restHeight = (rest * 3) / 2;
  const scores = score ? cardScores(score).slice(0, 2) : [];
  // No year: it costs the most room (a show's is a range) and the genres say more beside the buttons.
  const facts = (item.genres ?? []).slice(0, 2).join(" · ");

  return (
    <>
      <div
        ref={root}
        className={cx(
          "group/card relative min-w-0 transition-transform duration-100 ease-out has-[>a:active]:scale-[0.985]",
          width,
        )}
        style={sized ? { width: open ? wide : rest } : undefined}
        data-card
        data-preview={open ? "open" : "closed"}
        {...longPress}
        onPointerMove={(e) => {
          longPress.onPointerMove(e);
          onPointerMove(e);
        }}
        onPointerEnter={stay}
        onPointerLeave={onPointerLeave}
        // A click anywhere on a closed poster (a button, or on the way to the title page) means it shouldn't open.
        onPointerDown={(e) => {
          longPress.onPointerDown(e);
          if (!open) cancelOpening();
        }}
      >
        <Link to={to} className="flex min-w-0 flex-col gap-2 rounded-card outline-offset-4" {...prefetch}>
          <div className={cx("relative w-full", !sized && "aspect-2/3")} style={sized ? { height: restHeight } : undefined}>
            {/* The window rounds the right edge, the artwork its own left corners; only the artwork takes the pointer. */}
            <div
              ref={frame}
              className="pointer-events-none absolute inset-y-0 left-0 w-full overflow-hidden rounded-card"
              style={sized ? { width: wide + SLACK } : undefined}
            >
              <div
                ref={artwork}
                className="pointer-events-auto absolute inset-y-0 left-0 isolate w-full overflow-hidden rounded-card bg-surface img-outline"
                style={sized ? { width: wide } : undefined}
              >
                <div className="absolute inset-y-0 left-0 w-full" style={warm && wide ? { width: wide } : undefined}>
                  {rested && (
                    <>
                      {/* With no backdrop the poster itself fills the frame, cropped toward its top, where faces usually are. */}
                      <img src={poster} alt="" aria-hidden decoding="async" className="absolute inset-0 size-full object-cover object-[50%_22%]" />
                      <Art src={backdrop} alt="" className="absolute inset-0 bg-transparent" />
                    </>
                  )}
                  {(primed || sized) && !!sources?.length && (
                    <AmbientTrailer kind="poster" sources={sources} active={primed || open} muted={!sound || !open} onShown={setShown} className={open ? undefined : "opacity-0!"} />
                  )}
                  <div
                    aria-hidden
                    className={cx(
                      "absolute inset-0 bg-linear-to-t from-black/80 via-black/25 via-45% to-transparent to-70% transition-opacity",
                      open ? "opacity-100 duration-200" : "opacity-0 duration-100",
                    )}
                  />
                  {sized && (
                    <div
                      className={cx(
                        "absolute bottom-3 left-3.5 flex max-w-[58%] flex-col items-start gap-1.5 transition-[opacity,translate]",
                        open ? "translate-y-0 opacity-100 delay-100 duration-200 ease-snappy" : "translate-y-1 opacity-0 duration-100",
                      )}
                    >
                      <PreviewLogo item={item} />
                      <p className="truncate text-caption text-fg-muted">
                        {scores.map((s) => (
                          <span key={s.key} title={s.label}>
                            <span className="font-semibold text-fg tabular-nums">{s.value}</span> {s.short} ·{" "}
                          </span>
                        ))}
                        {facts}
                      </p>
                    </div>
                  )}
                </div>
                {/* The poster keeps its size and fades to show the artwork opening around it. */}
                <div
                  className={cx("absolute inset-y-0 left-0 w-full transition-opacity", open ? "opacity-0 duration-200 ease-out" : "duration-150")}
                  style={sized ? { width: rest } : undefined}
                >
                  <Art src={poster} titleId={item.id} alt="" fallbackTitle={item.name} className="size-full group-hover/card:brightness-110" />
                  {badge && <div className="absolute top-2 left-2">{badge}</div>}
                  {!!progress && (
                    <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
                      <div className="h-full bg-accent" style={{ width: `${Math.min(100, progress * 100)}%` }} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className={cx("min-w-0 px-0.5", !caption && "sr-only")} style={sized ? { width: rest } : undefined}>
            <p className="truncate text-body font-medium text-fg" title={item.name}>
              {item.name}
            </p>
            {subtitle && <p className="line-clamp-2 text-caption text-fg-faint">{subtitle}</p>}
          </div>
        </Link>
        {/* Over the artwork, outside the link: shown while hovered, while a key has focus inside, and while a menu is open.
            Touch screens get them in the peek a long press opens. While open it is as wide as the artwork and rides the window's edge. */}
        <div
          ref={buttons}
          data-hover-reveal
          className={cx(
            "pointer-events-none absolute inset-x-0 top-0 opacity-0 [@media(hover:none)]:hidden",
            "group-hover/card:opacity-100 group-has-focus-visible/card:opacity-100 group-has-[[aria-expanded=true]]/card:opacity-100",
            !sized && "aspect-2/3",
          )}
          style={sized ? { width: wide, height: restHeight } : undefined}
        >
          {!sized && (
            <>
              <div className="absolute inset-x-0 bottom-0 h-1/2 rounded-b-card bg-linear-to-t from-black/55 to-transparent" />
              {/* With previews, scores wait for the preview, which shows them beside the title. */}
              {score && hasScores && !enabled && <ScoreStack source={score} className="absolute bottom-2 left-2" />}
            </>
          )}
          <div
            data-card-actions
            className={cx(
              "absolute right-2 bottom-2 flex items-center gap-1.5",
              "group-hover/card:pointer-events-auto group-has-focus-visible/card:pointer-events-auto group-has-[[aria-expanded=true]]/card:pointer-events-auto",
            )}
          >
            <AnimatePresence initial={false}>
              {shown && open && (
                <motion.div key="sound" {...ARRIVE} exit={LEAVE} transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}>
                  <IconButton label={sound ? "Turn sound off" : "Turn sound on"} tone="glass" className="min-h-11 min-w-11" onClick={() => setSound(!sound)}>
                    {sound ? <SpeakerHighIcon /> : <SpeakerSlashIcon />}
                  </IconButton>
                </motion.div>
              )}
            </AnimatePresence>
            {actions}
            {/* Play comes in last, in the corner: it grows its own room with the poster's spring, so the buttons
                beside it slide aside instead of jumping. The motion sits on the wrapper so the button keeps its press. */}
            <AnimatePresence initial={false}>
              {open && (
                <motion.div
                  key="play"
                  className="flex shrink-0 origin-right justify-end"
                  initial={{ ...ARRIVE.initial, width: 0, marginLeft: -6 }}
                  animate={{ ...ARRIVE.animate, width: 44, marginLeft: 0 }}
                  exit={{ ...LEAVE, width: 0, marginLeft: -6, transition: { ...CLOSE, opacity: LEAVE.transition } }}
                  transition={OPEN}
                >
                  <PreviewPlay name={item.name} onPlay={onPlay} media={playMedia} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      {/* Outside the card, so presses inside the sheet aren't the card's own. */}
      {peeking !== undefined && (
        <Peek
          open={peeking}
          onClose={() => setPeeking(false)}
          to={to}
          title={item.name}
          poster={poster}
          titleId={item.id}
          facts={[item.year, ...(item.genres ?? []).slice(0, 2)].filter(Boolean).join(" · ")}
          description={item.description}
          score={score}
          actions={actions}
          onPlay={onPlay}
        />
      )}
    </>
  );
}

/** A poster's width open: its height at 16:9. */
const openWidth = (base: number) => Math.round(((base * 3) / 2) * (16 / 9));

function PreviewPlay({ name, onPlay, media }: { name: string; onPlay: () => Promise<void>; media?: () => Promise<Media | undefined> }) {
  const [busy, setBusy] = useState(false);
  const warmPlay = useWarmOnHover(media);
  return (
    <button
      aria-label={`Play ${name}`}
      title="Play"
      disabled={busy}
      {...warmPlay}
      onClick={async () => {
        setBusy(true);
        await onPlay();
        setBusy(false);
      }}
      className="press bubble-white grid size-11 shrink-0 place-items-center rounded-full text-[18px] text-on-accent"
    >
      <Film material={WHITE} />
      {busy ? <Spinner /> : <PlayIcon weight="fill" className="-translate-x-px" />}
    </button>
  );
}

/** The title's logo, or its name in the display face when there's none. */
function PreviewLogo({ item }: { item: PreviewItem }) {
  const src = art.logo(item.id) ?? item.logo;
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <p className="line-clamp-2 font-display text-title font-semibold text-balance text-fg">{item.name}</p>;
  return (
    <img
      src={src}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className="max-h-11 w-auto max-w-full object-contain object-left-bottom drop-shadow-[0_2px_12px_oklch(0_0_0/0.5)]"
    />
  );
}

// ---------------------------------------------------------------------------------------------
// The row making room

/** Posters open or still closing, so a neighbour knows to open quickly. */
const opened = new Set<HTMLElement>();
let lastClosedAt = -Infinity;
/** Open posters waiting out their close delay, each with what closes it now. */
const leaving = new Set<() => void>();

/** Where a transform has an element along the row right now, mid-spring included. */
const translateOf = (el: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;

/** Moves `el` to `x` along the row, springing there with `ease` (from wherever it is now), or at once. */
function slide(el: HTMLElement, x: number, ease: string | null) {
  el.style.transition = ease ? `transform ${ease}` : "none";
  el.style.transform = `translateX(${x}px)`;
  // Applied now, so a spring set next starts from here.
  if (!ease) void getComputedStyle(el).transform;
}

/**
 * Changes the row's layout with `change`, then lets each card glide from where it was to its new place
 * (FLIP): one layout, then transforms only. Cards the change didn't move carry on with their own spring.
 */
function glide(scroller: HTMLElement, ease: string, change: () => void) {
  const cards = [...scroller.children] as HTMLElement[];
  const before = cards.map((el) => el.getBoundingClientRect().left);
  change();
  const moved = cards.filter((el, i) => {
    const by = before[i] - el.getBoundingClientRect().left;
    if (Math.abs(by) < 0.5) return false;
    slide(el, translateOf(el) + by, null);
    return true;
  });
  for (const el of moved) {
    el.style.transition = `transform ${ease}`;
    el.style.transform = "";
    el.addEventListener("transitionend", tidy);
  }
}

/** Drops a card's transition once it has arrived, so the row is plain again. */
function tidy(this: HTMLElement, e: TransitionEvent) {
  if (e.target !== this || this.style.transform) return;
  this.style.transition = "";
  this.removeEventListener("transitionend", tidy);
}

/** Open or closing posters per row. While there are any, snapping is off: it would undo the row's shift. */
const sizedIn = new WeakMap<HTMLElement, number>();
function snapping(el: HTMLElement, sized: boolean) {
  const scroller = el.closest<HTMLElement>("[data-rail]");
  if (!scroller) return;
  const n = Math.max(0, (sizedIn.get(scroller) ?? 0) + (sized ? 1 : -1));
  sizedIn.set(scroller, n);
  scroller.style.scrollSnapType = n > 0 ? "none" : "";
}

/**
 * How far the row has to scroll for a poster growing to `target` to end up fully inside it (negative
 * scrolls back), or null when it can't fit at all, or when the pointer at `x` wouldn't be on it any more: a
 * poster half past the row's edge, rested on in the row's margin, would slide out from under the pointer,
 * close, slide back under it and open again, and the row would scroll back and forth on its own. Measured
 * from where its card is laid out, not where a spring has it right now.
 */
function shiftFor(el: HTMLElement, scroller: HTMLElement, target: number, x: number) {
  const s = scroller.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  const start = s.left + parseFloat(style.paddingLeft);
  const end = s.right - parseFloat(style.paddingRight);
  if (target > end - start) return null;
  const card = el.closest<HTMLElement>("[data-rail] > *");
  const left = el.getBoundingClientRect().left - (card ? translateOf(card) : 0);
  const shift = left < start ? left - start : Math.max(0, left + target - end);
  return x < left - shift || x > left - shift + target ? null : shift;
}
