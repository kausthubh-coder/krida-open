// What floats over the picture: who's being waited for, what someone did, skips, chat while the panel is shut, and
// what a finger on the picture is doing.
import { useCallback, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CheckIcon,
  ClockClockwiseIcon,
  ClockCounterClockwiseIcon,
  PauseIcon,
  PlayIcon,
  SkipForwardIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerSlashIcon,
  SunDimIcon,
  SunIcon,
} from "@phosphor-icons/react";
import { formatTime } from "../../ui/format";
import { Avatar, cx, IconButton, Spinner } from "../../ui/ui";
import type { Member, RoomData } from "../party";
import { fade, MotionButton } from "./chrome";
import type { FramePreview, PreviewState } from "./framePreview";
import type { Note, useFloatingChat } from "./notes";
import { RECEIPT_SECONDS, type Receipt } from "./together";
import type { TouchLevel, TouchScrub, TouchSeek } from "./touch";

/**
 * On touch, and in a window too narrow for two capsules (`compact:`), play and the 10-second skips sit in the middle
 * of the picture while the controls show, as Netflix and YouTube have them on phones, where a thumb can reach them;
 * the capsule along the bottom drops them. Three
 * clear bubbles, big enough for a thumb, as a phone's player has them. While the stream loads, the spinner takes play's place.
 */
export function TouchTransport({ visible, paused, loading, onPlay, onBack, onForward }: {
  visible: boolean;
  paused: boolean;
  loading: boolean;
  onPlay: () => void;
  onBack: () => void;
  onForward: () => void;
}) {
  const skip = "size-15 text-[30px]";
  return (
    <div
      className="pointer-events-none absolute top-1/2 left-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-8 compact:flex sm:gap-14"
    >
      <IconButton tone="glass" label="Back 10 seconds" onClick={onBack} className={cx(skip, "pointer-events-auto", fade(visible))}>
        <ClockCounterClockwiseIcon />
      </IconButton>
      {loading ? (
        <span className="grid size-20 place-items-center">
          <Spinner className="size-10 border-[3px] text-white/80" />
        </span>
      ) : (
        <IconButton
          tone="glass"
          label={paused ? "Play" : "Pause"}
          onClick={onPlay}
          className={cx("pointer-events-auto size-20 text-[36px]", fade(visible))}
        >
          {/* Phosphor's triangle sits right of its box's centre already; this brings its weight to the middle. */}
          {paused ? <PlayIcon weight="fill" className="-translate-x-0.5" /> : <PauseIcon weight="fill" />}
        </IconButton>
      )}
      <IconButton tone="glass" label="Forward 10 seconds" onClick={onForward} className={cx(skip, "pointer-events-auto", fade(visible))}>
        <ClockClockwiseIcon />
      </IconButton>
    </div>
  );
}

/**
 * What a held or pinching finger changed: "2× speed" for as long as it holds, "Zoomed to fill" for a moment. One
 * small capsule at the top, where the level meter goes.
 */
export function GesturePill({ icon, text }: { icon?: ReactNode; text: string | null }) {
  return (
    <AnimatePresence>
      {text && (
        <motion.div
          key="gesture"
          role="status"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.15, ease: "easeIn" } }}
          className="glass pointer-events-none absolute top-[calc(var(--safe-top)+20px)] left-1/2 flex h-11 -translate-x-1/2 items-center gap-2 rounded-full px-4 text-body font-medium whitespace-nowrap text-fg"
        >
          {icon}
          {text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Sliding a finger sideways along the picture: the picture at the time it would land on, that time, and how far it
 * is from where you were. A dark card, not glass, since it changes with every move, as the timeline's does.
 */
export function ScrubCard({ scrub, preview }: { scrub: TouchScrub | null; preview: FramePreview | null }) {
  const [frame, setFrame] = useState<PreviewState>({ shown: false, stale: false });
  const canvas = useCallback(
    (c: HTMLCanvasElement | null) => {
      preview?.attach(c, setFrame);
      return () => preview?.attach(null, null);
    },
    [preview],
  );
  if (!scrub) return null;
  return (
    <div
      role="status"
      aria-label={`Seek to ${formatTime(scrub.to)}`}
      className="pointer-events-none absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
    >
      {preview && (
        <canvas
          ref={canvas}
          aria-hidden
          className={cx(
            "aspect-video w-[min(240px,45vw)] rounded-card bg-black object-contain shadow-raised outline-1 -outline-offset-1 outline-white/10",
            !frame.shown && "hidden",
            frame.stale && "opacity-50",
          )}
        />
      )}
      <div className="flex items-baseline gap-2 rounded-full bg-black/75 px-4 py-1.5 tabular-nums shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]">
        <span className="text-subhead font-semibold text-fg">{formatTime(scrub.to)}</span>
        <span className="text-caption text-fg-muted">
          {scrub.by < 0 ? "−" : "+"}
          {formatTime(Math.abs(scrub.by))}
        </span>
      </div>
    </div>
  );
}

/**
 * A double tap on a side of the picture lights that side and says how far it went, growing as you keep tapping.
 * A wash of light, not glass: it comes and goes over playing video.
 */
export function SeekRipple({ seek }: { seek: TouchSeek | null }) {
  return (
    <AnimatePresence>
      {seek && (
        <motion.div
          key={seek.side}
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.12 } }}
          exit={{ opacity: 0, transition: { duration: 0.2, ease: "easeIn" } }}
          className={cx(
            "pointer-events-none absolute inset-y-0 grid w-[38%] place-items-center bg-white/10",
            seek.side === "back" ? "left-0 rounded-r-[50%]" : "right-0 rounded-l-[50%]",
          )}
        >
          <span className="flex flex-col items-center gap-1.5 text-body font-medium text-white tabular-nums drop-shadow-[0_1px_8px_oklch(0_0_0/0.6)]">
            {seek.side === "back" ? <ClockCounterClockwiseIcon size={28} /> : <ClockClockwiseIcon size={28} />}
            {seek.seconds} seconds
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Brightness or volume while a finger drags it: one small capsule at the top, so the picture it changes stays in
 * view. Instant, like the controls; it only fades on the way out.
 */
export function LevelMeter({ level }: { level: TouchLevel | null }) {
  const icon = !level
    ? null
    : level.kind === "brightness"
      ? level.value < 0.5 ? <SunDimIcon size={20} /> : <SunIcon size={20} />
      : level.value === 0 ? <SpeakerSlashIcon size={20} /> : level.value < 0.5 ? <SpeakerLowIcon size={20} /> : <SpeakerHighIcon size={20} />;
  return (
    <AnimatePresence>
      {level && (
        <motion.div
          key="level"
          role="status"
          aria-label={`${level.kind === "brightness" ? "Brightness" : "Volume"} ${Math.round(level.value * 100)}%`}
          exit={{ opacity: 0, transition: { duration: 0.15, ease: "easeIn" } }}
          className="glass pointer-events-none absolute top-[calc(var(--safe-top)+20px)] left-1/2 flex h-11 -translate-x-1/2 items-center gap-3 rounded-full px-4 text-fg"
        >
          {icon}
          <span className="relative h-1 w-32 overflow-hidden rounded-full bg-white/25">
            <span className="absolute inset-y-0 left-0 rounded-full bg-fg" style={{ width: `${level.value * 100}%` }} />
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function StatusPills({ panelOpen, waitingForOthers, holdFor, note }: {
  panelOpen: boolean;
  waitingForOthers: boolean;
  holdFor: Member[];
  note: Note | null;
}) {
  return (
    <div
      className={cx(
        "pointer-events-none absolute inset-x-0 top-20 flex flex-col items-center gap-2 px-4",
        panelOpen && "stage:pr-[408px]",
      )}
    >
      <AnimatePresence>
        {waitingForOthers && (
          <motion.div
            key="waiting"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
            className="flex items-center gap-2 rounded-full glass px-4 py-2 text-body whitespace-nowrap"
            role="status"
          >
            <Spinner className="size-3.5" />
            {holdFor.some((x) => !x.isMe)
              ? `Waiting for ${holdFor.filter((x) => !x.isMe).map((x) => x.name).join(" and ")} to catch up`
              : holdFor.length
                ? "Loading, everyone’s waiting for you…"
                : "Starting again…"}
          </motion.div>
        )}
        {note && (
          <motion.div
            key={note.key}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
            className="flex max-w-full items-center gap-2 rounded-full glass py-1.5 pr-4 pl-1.5 text-body"
            role="status"
          >
            {note.who && <Avatar name={note.who.name} hue={note.who.hue} size={24} />}
            <span className="truncate">
              <span className="font-medium">{note.who?.name ?? "Someone"}</span>{" "}
              <span className="text-fg-muted">{note.text}</span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Skip buttons, and what was skipped, stay visible on their own, even with the controls hidden. They make room for
 * the controls by transform: moving glass by layout would re-blur it every frame.
 */
export function SkipStack({ visible, panelOpen, menuOpen, receipt, held, onHold, onFocusHold, onReceiptDone, watchSkipped, skip, keepersNote, onSkip, reduceMotion }: {
  visible: boolean;
  panelOpen: boolean;
  menuOpen: boolean;
  receipt: Receipt | null;
  held: boolean;
  onHold: (seq: number | null) => void;
  onFocusHold: (seq: number | null) => void;
  onReceiptDone: () => void;
  watchSkipped: () => void;
  skip: { label: string } | null;
  keepersNote: string | null;
  onSkip: () => void;
  reduceMotion: boolean | null;
}) {
  return (
    <div
      className={cx(
        "pointer-events-none absolute right-4 bottom-8 flex flex-col items-end gap-2 transition-transform duration-200 ease-snappy stage:right-6",
        visible && "-translate-y-36",
        panelOpen && "stage:right-[408px]",
      )}
    >
      <AnimatePresence>
        {receipt && !menuOpen && (
          <motion.div
            key={`receipt-${receipt.seq}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
            onPointerEnter={() => onHold(receipt.seq)}
            onPointerLeave={() => onHold(null)}
            onFocus={() => onFocusHold(receipt.seq)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) onFocusHold(null);
            }}
            className="glass pointer-events-auto relative flex h-12 items-center gap-1 overflow-hidden rounded-full pr-1.5 pl-4 text-white"
            role="status"
          >
            <CheckIcon weight="bold" className="text-accent" />
            <span className="ml-1.5 text-body font-medium">Skipped {receipt.parts.join(" and ")}</span>
            <span aria-hidden className="mr-1 ml-2.5 h-5 w-px bg-white/20" />
            <button
              onClick={watchSkipped}
              className="press h-9 rounded-full px-3 text-body font-medium hover:bg-white/12 focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11"
            >
              Watch it
            </button>
            {/* The time left to undo. It is also the timer, so with reduced motion it runs unseen. */}
            <span
              aria-hidden
              onAnimationEnd={onReceiptDone}
              className={cx("absolute inset-x-0 bottom-0 h-0.5 origin-left bg-white/45", reduceMotion && "opacity-0")}
              style={{
                animation: `hero-progress ${RECEIPT_SECONDS}s linear reverse forwards`,
                animationPlayState: held ? "paused" : "running",
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* The wrapper rises; each piece of glass fades itself, so it blurs the picture the whole time. */}
      <AnimatePresence>
        {skip && !menuOpen && (
          <motion.div
            key={skip.label}
            initial={{ y: 8 }}
            animate={{ y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            className="pointer-events-auto flex flex-col items-end gap-2"
          >
            {keepersNote && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
                exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
                className="glass rounded-full px-2.5 py-0.5 text-caption text-white/80"
              >
                {keepersNote}
              </motion.span>
            )}
            <MotionButton
              variant="overlay"
              size="lg"
              icon={<SkipForwardIcon weight="fill" />}
              onClick={onSkip}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
            >
              {skip.label}
            </MotionButton>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Chat over the picture while the panel is closed: a glance, and a tap opens the conversation. */
export function ChatOverlay({ room, floating, visible, onOpenParty }: {
  room: RoomData;
  floating: ReturnType<typeof useFloatingChat>["floating"];
  visible: boolean;
  onOpenParty: () => void;
}) {
  return (
    <div
      className={cx(
        "absolute bottom-8 left-4 flex max-w-[min(420px,calc(100%-32px))] flex-col items-start gap-2 transition-transform duration-200 ease-snappy stage:left-6",
        visible && "-translate-y-36",
      )}
    >
      <AnimatePresence initial={false}>
        {floating.map((x) => {
          const who = room.members.find((p) => p._id === x.profileId);
          return (
            <motion.button
              key={x._id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.2, ease: "easeIn" } }}
              onClick={onOpenParty}
              className="flex max-w-full items-center gap-2 rounded-full glass py-1.5 pr-4 pl-1.5 text-left text-body"
            >
              {who && <Avatar name={who.name} hue={who.hue} size={24} />}
              <span className="truncate">{x.body}</span>
            </motion.button>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
