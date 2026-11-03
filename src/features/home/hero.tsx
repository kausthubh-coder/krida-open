// Home's banner, whose rows stay on Krida's neutral page rather than taking each slide's colour: where you left off, then today's picks, each with its trailer behind it.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { InfoIcon, MagnifyingGlassIcon, PlayIcon, SpeakerHighIcon, SpeakerSlashIcon } from "@phosphor-icons/react";
import { useAuthed } from "../../data/session";
import { art } from "../../data/cinemeta";
import { episodeLabel, timeLeft } from "../../ui/format";
import { usePlayNeedsDebrid, usePlayTitle, useTitleTarget, useWarmOnHover } from "../play";
import { useTitleTrailer, useAmbientTrailers, usePreviewOpen, useTrailerSound, AmbientTrailer } from "../trailers";
import { Art, TitleArt } from "../../ui/artwork";
import { cardScores, scoreSource } from "../../ui/scores";
import { Button, cx, IconButton } from "../../ui/ui";
import { useMedia } from "../../ui/media";
import { PlayNeedsDebrid } from "../../ui/needsKey";
import type { ProgressRow, RowItem } from "./Home";
import { type Slide, resumeTarget, useResume } from "./slides";

const SLIDE_SECONDS = 9;

// A slide rests this long on its backdrop before its trailer starts loading.
const HERO_TRAILER_DELAY_MS = 2500;

// The banner's trailer file height: it fills the width of the screen.
const HERO_FILE_HEIGHT = 1080;

export function Hero({ slides }: { slides: Slide[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const current = slides[Math.min(index, slides.length - 1)];
  const next = () => setIndex((i) => (i + 1) % slides.length);

  // Don't rotate while the tab is hidden.
  useEffect(() => {
    const onVisibility = () => {
      setPaused(document.hidden);
      setHidden(document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // A title slide's trailer plays muted behind it. Not for where you left off: you know that one.
  const trailersOn = useAmbientTrailers("(min-width: 768px)");
  const title = current.kind === "title" ? current.item : undefined;
  const { sources } = useTitleTrailer(title, HERO_FILE_HEIGHT, trailersOn);
  const [trailer, setTrailer] = useState(false);
  // Once a slide's trailer has shown, the slide waits for it to end, even while it's paused.
  const [heldFor, setHeldFor] = useState<string>();
  const [sound, setSound] = useTrailerSound();
  const previewOpen = usePreviewOpen();
  const section = useRef<HTMLElement>(null);
  const inView = useInView(section);

  return (
    <section
      ref={section}
      // The artwork runs on under a sideways phone's rail, so its glass has a picture behind it.
      // A tall phone stops at 36rem, so the first row still shows under it.
      // On a phone it takes most of the first screen, as Nuvio's and Apple TV's do, with the top of the next row showing under it.
      className="relative isolate -mt-(--inset-top) -ml-(--rail-pad,0px) flex min-h-[min(82dvh,44rem)] items-end overflow-hidden pl-(--rail-pad,0px) md:min-h-[80dvh]"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      aria-roledescription="carousel"
      aria-label="Featured"
    >
      {/* What the glass buttons bend in Safari and Firefox: a copy of the artwork, not of the whole page. */}
      <div className="absolute inset-0 -z-10">
        {/* Backdrops crossfade; each stays mounted so returning to it is instant. */}
        {slides.map((s, i) => (
          <Art
            key={s.key}
            src={backdropFor(s)}
            alt=""
            eager={i <= 1}
            className={cx(
              "absolute inset-0 -z-20 bg-page transition-opacity duration-700 ease-out motion-reduce:duration-150",
              s === current ? "opacity-100" : "opacity-0",
            )}
            imgClassName="object-[center_25%]"
          />
        ))}
        {/* Paused while a poster below plays its own, while scrolled away, and while the tab is hidden; the slide waits for it to end. */}
        {!!sources?.length && (
          <AmbientTrailer
            key={current.key}
            kind="banner"
            sources={sources}
            active={!hidden && inView && !previewOpen}
            muted={!sound}
            delay={HERO_TRAILER_DELAY_MS}
            onShown={(on) => {
              setTrailer(on);
              if (on) setHeldFor(current.key);
            }}
            onEnded={() => {
              setHeldFor(undefined);
              next();
            }}
            className="-z-20"
          />
        )}
        <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-page from-3% via-page/70 via-32% to-page/0 to-62% md:via-page/45 md:via-25%" />
        <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-r from-page/85 via-page/25 to-transparent max-md:hidden" />
        <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-32 bg-linear-to-b from-page/60 to-transparent md:hidden" />
      </div>

      <div className="flex w-full items-end gap-6 px-5 pt-32 pb-5 md:px-12 md:pb-12 short:pt-16 short:pb-6">
        <AnimatePresence mode="wait" initial={false}>
          {/* The wrapper only moves. The fade is a variable each line and each button applies to itself: opacity
              on an ancestor would hide the backdrop from the glass buttons until the fade ended. */}
          <motion.div
            key={current.key}
            initial={{ "--fade": 0, y: 8 }}
            animate={{ "--fade": 1, y: 0, transition: { duration: 0.32, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ "--fade": 0, transition: { duration: 0.14, ease: "easeIn" } }}
            className="flex w-full max-w-2xl flex-col gap-3 max-md:items-center max-md:text-center md:gap-4 short:gap-3 [&>*:not([data-actions])]:opacity-(--fade) [&>[data-actions]>*]:opacity-(--fade)"
            aria-live="polite"
          >
            {current.kind === "resume" ? <ResumeContent row={current.row} /> : <TitleContent item={current.item} eyebrow={current.eyebrow} />}
          </motion.div>
        </AnimatePresence>
        {/* Level with the buttons beside it. */}
        <div className="ml-auto hidden h-12 shrink-0 items-center gap-4 self-end md:flex">
          {trailer && (
            <IconButton label={sound ? "Turn sound off" : "Turn sound on"} tone="glass" onClick={() => setSound(!sound)}>
              {sound ? <SpeakerHighIcon /> : <SpeakerSlashIcon />}
            </IconButton>
          )}
          {slides.length > 1 && (
            <div className="flex items-center gap-1.5" role="tablist" aria-label="Featured titles">
              {slides.map((s, i) => (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={s === current}
                  aria-label={`Show ${slideName(s)}`}
                  onClick={() => {
                    setHeldFor(undefined);
                    setIndex(i);
                  }}
                  className="group/dot grid h-6 place-items-center px-0.5"
                >
                  <span className={cx("relative block h-1 overflow-hidden rounded-full bg-white/25", s === current ? "w-8" : "w-4 group-hover/dot:bg-white/45")}>
                    {s === current && (
                      <span
                        key={current.key}
                        onAnimationEnd={next}
                        className="absolute inset-0 origin-left rounded-full bg-fg"
                        style={{
                          animation: `hero-progress ${SLIDE_SECONDS}s linear forwards`,
                          animationPlayState: paused || heldFor === current.key ? "paused" : "running",
                        }}
                      />
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Whether most of an element is on screen. */
function useInView(ref: React.RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.4 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

const slideName = (s: Slide) => (s.kind === "resume" ? s.row.media.name : s.item.name);

function backdropFor(s: Slide) {
  const id = s.kind === "resume" ? s.row.media.imdbId : s.item.id;
  return art.backgroundLarge(id) ?? (s.kind === "resume" ? s.row.media.background : s.item.background);
}

/** Round beside Play on a phone, where Play takes the width; with its words on a wide screen. */
function MoreInfo({ onClick }: { onClick: () => void }) {
  const wide = useMedia("(min-width: 768px)");
  return wide ? (
    <Button variant="glass" size="lg" icon={<InfoIcon />} onClick={onClick}>
      More info
    </Button>
  ) : (
    <IconButton label="More info" tone="glass" size="lg" onClick={onClick}>
      <InfoIcon />
    </IconButton>
  );
}

function ResumeContent({ row }: { row: ProgressRow }) {
  const resume = useResume();
  const noDebrid = usePlayNeedsDebrid();
  const warmPlay = useWarmOnHover(async () => (await resumeTarget(row)).media);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const m = row.media;
  const label = m.type === "series" ? [episodeLabel(m.season, m.episode), m.episodeTitle].filter(Boolean).join(" · ") : m.year;
  return (
    <>
      <p className="text-caption font-semibold tracking-[0.08em] text-fg-muted uppercase">
        {row.finished ? "Up next" : "Continue watching"}
      </p>
      <TitleArt imdbId={m.imdbId} name={m.name} logo={m.logo} />
      <p className="truncate text-subhead text-fg-muted">
        {label}
        {!row.finished && <span className="text-fg-faint"> · {timeLeft(row.position, row.duration)}</span>}
      </p>
      {!row.finished && (
        <div className="progress-groove h-1 w-40 overflow-hidden rounded-full bg-white/15 md:w-full md:max-w-sm">
          <div className="h-full rounded-full bg-accent" style={{ width: `${(row.position / row.duration) * 100}%` }} />
        </div>
      )}
      <div data-actions className="mt-2 flex w-full items-center gap-3 md:w-auto">
        <Button
          variant={noDebrid ? "glass" : "primary"}
          size="lg"
          loading={busy}
          icon={<PlayIcon weight="fill" />}
          aria-disabled={noDebrid || undefined}
          {...warmPlay}
          className={cx("max-md:flex-1", noDebrid && "opacity-60")}
          onClick={async () => {
            setBusy(true);
            await resume(row);
            setBusy(false);
          }}
        >
          {row.finished ? "Play next episode" : "Resume"}
        </Button>
        <MoreInfo onClick={() => navigate(`/title/${m.type}/${m.imdbId}`)} />
      </div>
      {noDebrid && <PlayNeedsDebrid />}
    </>
  );
}

function TitleContent({ item, eyebrow }: { item: RowItem; eyebrow: string }) {
  const playTitle = usePlayTitle();
  const noDebrid = usePlayNeedsDebrid();
  const target = useTitleTarget();
  const warmPlay = useWarmOnHover(async () => (await target(item.type, item.id)).media);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const facts = [item.year, ...item.genres.slice(0, 2)].filter(Boolean);
  return (
    <>
      <p className="text-caption font-semibold tracking-[0.08em] text-fg-muted uppercase">{eyebrow}</p>
      <TitleArt imdbId={item.id} name={item.name} logo={item.logo} />
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-fg-muted">
        {cardScores(scoreSource(item)).slice(0, 4).map((s) => (
          <span key={s.key} title={s.label}>
            <span className="font-medium text-fg tabular-nums">{s.value}</span> {s.short}
          </span>
        ))}
        <span>{facts.join(" · ")}</span>
      </p>
      {item.description && <p className="line-clamp-3 max-w-[55ch] text-subhead text-fg-muted max-md:hidden short:line-clamp-2">{item.description}</p>}
      <div data-actions className="mt-2 flex w-full items-center gap-3 md:w-auto">
        <Button
          variant={noDebrid ? "glass" : "primary"}
          size="lg"
          loading={busy}
          icon={<PlayIcon weight="fill" />}
          aria-disabled={noDebrid || undefined}
          {...warmPlay}
          className={cx("max-md:flex-1", noDebrid && "opacity-60")}
          onClick={async () => {
            setBusy(true);
            await playTitle(item.type, item.id);
            setBusy(false);
          }}
        >
          Play
        </Button>
        <MoreInfo onClick={() => navigate(`/title/${item.type}/${item.id}`)} />
      </div>
      {noDebrid && <PlayNeedsDebrid />}
    </>
  );
}

export function WelcomeHero() {
  const navigate = useNavigate();
  const { me } = useAuthed();
  const [query, setQuery] = useState("");
  return (
    <section className="relative isolate -mt-(--inset-top) flex min-h-[64dvh] items-center overflow-hidden px-4 pt-24 pb-8 md:px-12">
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{
          // The profile's own color, the one hue it chose; the rest of the page stays neutral.
          background: `radial-gradient(70% 60% at 20% 0%, oklch(0.36 0.07 ${me.hue} / 0.45), transparent 70%)`,
        }}
      />
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <h1 className="font-display text-[length:clamp(2.25rem,1.5rem+3vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.025em]">
          What are we watching tonight, {me.name}?
        </h1>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/search?q=${encodeURIComponent(query.trim())}`);
          }}
          className="flex h-14 max-w-xl items-center gap-3 rounded-full fill-quiet bg-white/6 pr-2 pl-5 ring-1 ring-line ring-inset focus-within:bg-white/8 focus-within:ring-white/25"
        >
          <MagnifyingGlassIcon size={20} className="shrink-0 text-fg-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search movies and shows"
            aria-label="Search movies and shows"
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-subhead text-fg outline-none placeholder:text-fg-faint"
          />
          <Button type="submit" variant="primary">
            Search
          </Button>
        </form>
      </div>
    </section>
  );
}

export function HeroSkeleton() {
  return <div className="-mt-(--inset-top) min-h-[min(84dvh,44rem)] md:min-h-[80dvh]" />;
}
