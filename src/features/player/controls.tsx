import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Slider, useBubble } from "bubli";
import type { Bubble } from "bubli/engine";
import { CheckIcon, SpeakerHighIcon, SpeakerLowIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { offsetIn } from "../../ui/anchor";
import { formatTime, languageName } from "../../ui/format";
import { Grow } from "../../ui/grow";
import { tick } from "../../ui/haptics";
import { pointIn } from "../../ui/sideways";
import { cx, IconButton, Spinner } from "../../ui/ui";
import type { FramePreview, PreviewState } from "./framePreview";
import { shiftSubtitleDelay } from "./subtitles";

// ---------------------------------------------------------------------------------------------
// Controls

/**
 * The time at each end and the timeline between them. It follows the video on its own, so the player around it
 * doesn't re-render with every tick, and only while it's on screen (`shown`): hidden under a playing film, it would
 * redraw four times a second for no one. It catches up as it shows.
 */
export function Timeline({
  video,
  shown,
  duration,
  aim,
  marks,
  preview,
  onSeek,
  onSkip,
  className,
}: {
  video: HTMLVideoElement | null;
  shown: boolean;
  duration: number;
  /** Where quick skips are headed, shown before the picture goes there. */
  aim: number | null;
  marks: { start: number; end: number }[];
  preview?: FramePreview | null;
  onSeek: (t: number) => void;
  /** Back and forward with the arrow keys, gathered like the player's own (skipping.ts). */
  onSkip: (seconds: number) => void;
  className?: string;
}) {
  const [now, setTime] = useState(0);
  const time = aim ?? now;
  const [buffered, setBuffered] = useState(0);
  useEffect(() => {
    if (!video || !shown) return;
    const update = () => {
      setTime(video.currentTime);
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= video.currentTime + 0.5 && b.end(i) >= video.currentTime) setBuffered(b.end(i));
      }
    };
    update();
    video.addEventListener("timeupdate", update);
    video.addEventListener("seeking", update);
    return () => {
      video.removeEventListener("timeupdate", update);
      video.removeEventListener("seeking", update);
    };
  }, [video, shown]);
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <span className="w-16 text-caption text-fg-muted tabular-nums">{formatTime(time)}</span>
      <div className="min-w-0 flex-1">
        <Seekbar time={time} duration={duration} buffered={buffered} marks={marks} preview={preview} onSeek={onSeek} onSkip={onSkip} />
      </div>
      <span className="w-16 text-right text-caption text-fg-muted tabular-nums">−{formatTime(Math.max(0, duration - time))}</span>
    </div>
  );
}

export function Seekbar({
  time,
  duration,
  buffered,
  marks = [],
  preview,
  onSeek,
  onSkip,
}: {
  time: number;
  duration: number;
  buffered: number;
  /** Skippable parts (intro, recap, credits), drawn lighter on the track. */
  marks?: { start: number; end: number }[];
  /** Frames of the video to show above the pointer. */
  preview?: FramePreview | null;
  onSeek: (t: number) => void;
  onSkip: (seconds: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  // Where the pointer is: the time under it, and where the tooltip's middle goes along the bar. The tooltip is
  // wider than the bar on a phone, so it's kept inside the window rather than the bar.
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [frame, setFrame] = useState<PreviewState>({ shown: false, stale: false });
  const shown = drag ?? time;
  const thumb = useRef<HTMLDivElement>(null);
  const film = useRef<HTMLCanvasElement>(null);
  const bubble = useRef<Bubble | null>(null);
  const [width, setWidth] = useState(0);
  // A drag just let go: the player hasn't reached that time yet, and the thumb shouldn't dip back to the old one.
  const landing = useRef(0);
  const [held, setHeld] = useState<number | null>(null);
  const showing = drag ?? held ?? shown;
  const fraction = duration > 0 ? Math.min(1, Math.max(0, showing / duration)) : 0;
  const center = THUMB.width / 2 + fraction * Math.max(0, width - THUMB.width);
  const last = useRef({ center, at: 0 });
  const sync = () => {
    const created = bubble.current;
    if (!created || !width) return;
    // The line keeps its buffer and intro marks in the page; the shader draws only what's been watched, over them.
    created.setLayer({ x: THUMB.bleed, y: THUMB.bleed + (BAR_HEIGHT - LINE) / 2, width, height: LINE, radius: LINE / 2, fill: fraction, track: "oklch(1 0 0 / 0)", from: WHITE, to: WHITE });
    created.moved();
  };
  const { mode } = useBubble({
    host: thumb,
    canvas: film,
    stateRoot: bar,
    pointerTarget: bar,
    preset: "thumb",
    material: { bevel: 8 },
    onReady(created) {
      bubble.current = created;
      sync();
    },
  });
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.offsetWidth));
    observer.observe(el);
    setWidth(el.offsetWidth);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    sync();
    const now = performance.now();
    if (drag !== null && last.current.at && now > last.current.at && last.current.center !== center)
      bubble.current?.moveWith(((center - last.current.center) / (now - last.current.at)) * 1000, 0);
    last.current = { center, at: now };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, center, drag]);
  useEffect(() => {
    bubble.current?.setSwell(drag !== null ? THUMB.swell : 1);
  }, [drag === null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (held === null) return;
    const timer = window.setTimeout(() => setHeld(null), Math.max(0, landing.current - performance.now()));
    return () => window.clearTimeout(timer);
  }, [held]);
  const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);
  // In the bar's own frame, which on an upright phone is turned a quarter (sideways.ts).
  const at = (e: { clientX: number; clientY: number }) => {
    const p = pointIn(bar.current!, e.clientX, e.clientY);
    const x = Math.min(p.width, Math.max(0, p.x));
    const half = preview ? PREVIEW_WIDTH / 2 + 8 : 0;
    return { t: (x / p.width) * duration, x: Math.min(p.frameWidth - half - p.left, Math.max(half - p.left, x)), along: x };
  };
  const point = (p: { t: number; x: number }) => {
    setHover(p);
    preview?.show(p.t);
  };
  const away = () => {
    setHover(null);
    preview?.hide();
  };
  const canvas = useCallback(
    (c: HTMLCanvasElement | null) => {
      preview?.attach(c, setFrame);
      return () => preview?.attach(null, null);
    },
    [preview],
  );
  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
        if (e.key === "ArrowLeft") onSkip(-5);
        if (e.key === "ArrowRight") onSkip(5);
      }}
      onPointerDown={(e) => {
        if (!duration) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = at(e);
        setDrag(p.t);
        // A finger has no hover: the picture shows while it holds the bar.
        point(p);
      }}
      onPointerMove={(e) => {
        if (!duration) return;
        const p = at(e);
        point(p);
        if (drag === null) return;
        setDrag(p.t);
      }}
      onPointerUp={(e) => {
        if (drag !== null) {
          const to = at(e).t;
          onSeek(to);
          landing.current = performance.now() + 500;
          setHeld(to);
          if (e.pointerType !== "mouse") tick();
        }
        setDrag(null);
        if (e.pointerType !== "mouse") away();
      }}
      onPointerCancel={() => {
        setDrag(null);
        away();
      }}
      onPointerLeave={away}
      // A finger gets 44px to land on; the line it moves stays thin.
      className="group/seek relative isolate flex h-11 cursor-pointer touch-none items-center"
      style={{ "--bubli-control-bleed": `${THUMB.bleed}px` } as CSSProperties}
    >
      <canvas ref={film} aria-hidden className="bubli-canvas" />
      <div className="relative -z-2 h-1.5 w-full overflow-hidden rounded-full bg-white/18">
        <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${pct(buffered)}%` }} />
        {marks.map((mk) => (
          <div
            key={mk.start}
            className="absolute inset-y-0 bg-white/25"
            style={{ left: `${pct(mk.start)}%`, width: `${pct(mk.end) - pct(mk.start)}%` }}
          />
        ))}
        {/* What the shader draws once the bubble's up; until then, and without WebGL, this is the line. */}
        {mode.glass !== "bubble" && <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${fraction * 100}%` }} />}
      </div>
      {/* It sits exactly at the time, never chasing it on a spring, and swells while it's dragged. */}
      <div
        ref={thumb}
        className={cx("pointer-events-none absolute top-1/2 h-6 w-[38px] -translate-x-1/2 -translate-y-1/2 rounded-full", mode.glass !== "bubble" && "bg-white shadow-raised")}
        style={{ left: center }}
      />
      {/* The picture at that time over a dark scrim, not glass: it moves with every pointer move, and glass would
          re-blur the video each time. It appears and follows instantly; a frame from far off stays dimmed until
          the right one loads. Before the first frame there's only the time. */}
      {hover !== null && (
        <div
          className="pointer-events-none absolute bottom-full left-0 mb-2 flex flex-col items-center gap-1.5"
          style={{ transform: `translateX(${hover.x}px) translateX(-50%)` }}
        >
          {preview && (
            <canvas
              ref={canvas}
              aria-hidden
              style={{ width: PREVIEW_WIDTH }}
              className={cx(
                "aspect-video rounded-card bg-black object-contain shadow-raised outline-1 -outline-offset-1 outline-white/10",
                !frame.shown && "hidden",
                frame.stale && "opacity-50",
              )}
            />
          )}
          <div className="rounded-full bg-black/75 px-2.5 py-1 text-caption text-fg tabular-nums shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]">
            {formatTime(hover.t)}
          </div>
        </div>
      )}
    </div>
  );
}

/** The timeline's thumb: the size bubli's own sliders use, and the room its canvas keeps around the bar. */
const WHITE = "oklch(0.97 0.004 60)";
const THUMB = { width: 38, bleed: 20, swell: 1.45 };
const BAR_HEIGHT = 44;
const LINE = 6;

/** The preview's width in CSS px; its height follows the video. */
const PREVIEW_WIDTH = 176;

export function Volume({
  volume,
  muted,
  onVolume,
  onMute,
  className,
  buttonClassName,
}: {
  volume: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMute: () => void;
  className?: string;
  buttonClassName?: string;
}) {
  const level = muted ? 0 : volume;
  return (
    <div className={cx("group/vol items-center", className)}>
      <IconButton label={muted ? "Unmute (M)" : "Mute (M)"} onClick={onMute} className={buttonClassName}>
        {level === 0 ? <SpeakerSlashIcon /> : level < 0.5 ? <SpeakerLowIcon /> : <SpeakerHighIcon />}
      </IconButton>
      {/* It sits inside a bubble, so it takes its width at once and only fades: a growing width would stretch the bubble every frame. */}
      <Slider
        value={level}
        min={0}
        max={1}
        step={0.05}
        label="Volume"
        from={WHITE}
        onValueChange={onVolume}
        className="pointer-events-none w-0 min-w-0 opacity-0 transition-opacity duration-100 group-hover/vol:pointer-events-auto group-hover/vol:mr-3 group-hover/vol:w-28 group-hover/vol:opacity-100 group-focus-within/vol:pointer-events-auto group-focus-within/vol:mr-3 group-focus-within/vol:w-28 group-focus-within/vol:opacity-100"
      />
    </div>
  );
}

/**
 * A player menu. It opens above the controls, beside their glass rather than inside it, so its own glass blurs
 * the picture. The buttons that open menus toggle them themselves; any other press outside closes it. The
 * controls' layer lets presses through to the video, so the menu takes them back (pointer-events-auto).
 */
export function Popover({
  open,
  title,
  showTitle = true,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  /** Menus made of labelled sections name themselves only to screen readers. */
  showTitle?: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element;
      if (ref.current?.contains(target)) return;
      if (ref.current?.parentElement?.contains(target) && target.closest("[aria-expanded]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose, open]);
  // Opened from the keyboard, focus goes into the menu; a click leaves it on the button.
  const focusIn = () => {
    if (document.activeElement?.matches(":focus-visible")) ref.current?.querySelector<HTMLElement>("button, input")?.focus();
  };
  return (
    <Grow
      ref={ref}
      inline
      open={open}
      // It grows out of the button that opened it. Worked out in the player's own frame, which on an upright phone is turned a
      // quarter (sideways.ts), and given back as if on screen, which is what the panel subtracts its own place from.
      from={() => {
        const menu = ref.current!;
        const frame = menu.offsetParent as HTMLElement;
        const own = menu.getBoundingClientRect();
        const button = frame.querySelector<HTMLElement>('[aria-expanded="true"]');
        const b = button ? offsetIn(button, frame) : { x: frame.offsetWidth - 44, y: 0, w: 44, h: 44 };
        return { x: own.left + b.x - menu.offsetLeft, y: own.top + b.y - menu.offsetTop, width: b.w, height: b.h };
      }}
      radius={24}
      onPlaced={focusIn}
      className="pointer-events-auto absolute! right-0 bottom-full mb-3 w-72 max-w-none"
      style={{ maxHeight: "min(420px, calc(var(--frame-height) * 0.6))" }}
      role="dialog"
      aria-label={title}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {showTitle && <MenuLabel className="px-4">{title}</MenuLabel>}
        <div className="p-1">{children}</div>
      </div>
    </Grow>
  );
}

/** A menu's title, or the name of a section in it. */
export function MenuLabel({ children, className = "px-3" }: { children: ReactNode; className?: string }) {
  return <p className={cx("pt-3 pb-1 text-caption font-semibold tracking-[0.08em] text-fg-faint uppercase", className)}>{children}</p>;
}

export function MenuRow({
  selected,
  onClick,
  hint,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      // Inside a bubble the choice in use is a soft shade, never a bubble in a bubble.
      className={cx(
        "flex min-h-10 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-body pointer-coarse:min-h-11",
        selected ? "lens" : "hover:bg-white/8",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center text-accent">{selected && <CheckIcon weight="bold" />}</span>
      <span className={cx("min-w-0 flex-1 truncate", selected ? "text-fg" : "text-fg-muted")}>{children}</span>
      {hint && <span className="shrink-0 text-caption text-fg-faint">{hint}</span>}
    </button>
  );
}

/** A track's own name when it says more than its language: "SDH", "Signs & Songs". */
function trackHint(t: { lang?: string; title?: string }) {
  const title = t.title?.trim();
  if (!title || title.toLowerCase() === languageName(t.lang).toLowerCase()) return undefined;
  return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}

/** "English", "English and Spanish", "English, Spanish and French". */
function listLanguages(tracks: { lang?: string }[]) {
  const names = [...new Set(tracks.map((t) => languageName(t.lang)))];
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

export function SubtitleMenu({
  native,
  fileTracks,
  filePlayable,
  options,
  current,
  error,
  offset,
  onOffset,
  onPick,
  localSubs,
  onLoadFile,
  fileError,
}: {
  /** ExoPlayer plays the file and draws its own tracks, which it can't shift in time. */
  native?: boolean;
  /** The file's own tracks, which only Krida for Windows can show (`filePlayable`). */
  fileTracks: { id: string; lang?: string; title?: string }[];
  filePlayable: boolean;
  options: { id: string; lang: string }[] | undefined;
  current: string | null;
  error: boolean;
  offset: number;
  onOffset: (n: number) => void;
  onPick: (id: string | null) => void;
  localSubs: { id: string; name: string }[];
  onLoadFile: (file: File) => Promise<void>;
  fileError: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  const grouped = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const o of options ?? []) map.set(o.lang, [...(map.get(o.lang) ?? []), o.id]);
    return [...map.entries()].sort(([a], [b]) =>
      a === "eng" ? -1 : b === "eng" ? 1 : languageName(a).localeCompare(languageName(b)),
    );
  }, [options]);
  return (
    <div className="flex flex-col">
      <MenuRow selected={current === null} onClick={() => onPick(null)}>
        Off
      </MenuRow>
      <input ref={input} type="file" accept=".srt,.vtt,.ass,.ssa" className="hidden" aria-label="Subtitle file" onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = "";
        if (file) void onLoadFile(file);
      }} />
      <MenuRow selected={false} onClick={() => input.current?.click()}>Load a subtitle file</MenuRow>
      {fileError && <p role="alert" className="px-3 py-2 text-body text-danger">{fileError}</p>}
      {localSubs.map((s) => <MenuRow key={s.id} selected={current === s.id} onClick={() => onPick(s.id)}>{s.name}</MenuRow>)}
      {!filePlayable && fileTracks.length > 0 && (
        <p className="px-3 py-2 text-caption text-fg-faint">
          This file’s own {listLanguages(fileTracks)} subtitles show only in the Krida app for Windows and Mac.
        </p>
      )}
      {filePlayable && fileTracks.length > 0 && (
        <>
          <MenuLabel>In this file</MenuLabel>
          {fileTracks.map((t) => (
            <MenuRow key={t.id} selected={current === t.id} onClick={() => onPick(t.id)} hint={trackHint(t)}>
              {languageName(t.lang)}
            </MenuRow>
          ))}
          <MenuLabel>OpenSubtitles</MenuLabel>
        </>
      )}
      {options === undefined && (
        <p className="flex items-center gap-2 px-3 py-2 text-body text-fg-faint">
          <Spinner className="size-3" /> Looking for subtitles…
        </p>
      )}
      {options?.length === 0 && (
        <p className="px-3 py-2 text-body text-fg-faint">
          {filePlayable && fileTracks.length > 0 ? "None found" : "No subtitles found for this video"}
        </p>
      )}
      {/* One row per language. A language with several files offers them as numbered choices at its end. */}
      {grouped.map(([lang, ids]) => {
        const files = ids.slice(0, 3);
        const picked = files.indexOf(current ?? "");
        return (
          <div key={lang} className="flex items-center gap-1">
            <MenuRow selected={picked >= 0} onClick={() => onPick(picked >= 0 ? files[picked] : files[0])}>
              {languageName(lang)}
            </MenuRow>
            {files.length > 1 &&
              files.map((id, i) => (
                <button
                  key={id}
                  onClick={() => onPick(id)}
                  aria-pressed={current === id}
                  aria-label={`${languageName(lang)}, file ${i + 1}`}
                  className={cx(
                    "grid size-8 shrink-0 place-items-center rounded-full text-caption tabular-nums pointer-coarse:size-10",
                    current === id ? "lens text-fg" : "text-fg-muted hover:bg-white/8 hover:text-fg",
                  )}
                >
                  {i + 1}
                </button>
              ))}
          </div>
        );
      })}
      {error && <p className="px-3 py-2 text-body text-danger">That subtitle file didn’t load. Try another.</p>}
      {/* Media3 1.9 has no embedded-track offset; addon and loaded cues are timed by the page and still support it. */}
      {current && !(native && current.startsWith("file:")) && (
        <div className="mt-1 flex items-center gap-2 border-t border-line px-3 pt-3 pb-2">
          <span className="flex-1 text-body text-fg-muted">Timing</span>
          <IconButton label="Show subtitles 0.1 seconds earlier (G)" size="sm" onClick={() => onOffset(shiftSubtitleDelay(offset, -1))}>
            −
          </IconButton>
          <span className="w-12 text-center text-body tabular-nums">{offset > 0 ? `+${offset}` : offset}s</span>
          <IconButton label="Show subtitles 0.1 seconds later (H)" size="sm" onClick={() => onOffset(shiftSubtitleDelay(offset, 1))}>
            +
          </IconButton>
        </div>
      )}
    </div>
  );
}

