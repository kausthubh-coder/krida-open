// The end of a title: Up next with its countdown, "Still watching?", a stop someone asked for, and a finished film.
import { Pane } from "../../ui/bubbles";
import { AnimatePresence, motion } from "motion/react";
import { PlayIcon, SignOutIcon, SkipForwardIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { art } from "../../data/cinemeta";
import { useAuthed } from "../../data/session";
import { Art } from "../../ui/artwork";
import { episodeLabel } from "../../ui/format";
import { Button, cx } from "../../ui/ui";
import type { Media } from "../play";
import { mediaLabel, type RoomData, type UpNext } from "../party";
import { AUTO_NEXT_SECONDS } from "./upNext";

type Next = Extract<UpNext, { kind: "next" | "episode" }>;

/** After a few in a row started on their own. */
export function StillWatching({ show, room, nextUp, nextIsEpisode, onPlay, onDone }: {
  show: boolean;
  room: RoomData;
  nextUp: Next | undefined;
  nextIsEpisode: boolean;
  onPlay: (media: Media) => void;
  onDone: () => void;
}) {
  return (
    <AnimatePresence>
      {show && nextUp && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
          className="absolute inset-0 grid place-items-center bg-black/55 px-6"
          role="dialog"
          aria-label="Still watching?"
        >
          <div className="flex max-w-md flex-col items-center gap-1.5 text-center">
            <p className="font-display text-title font-semibold">Still watching?</p>
            <p className="text-body text-fg-muted">
              {room.autoStreak} in a row started on their own. Up next: {mediaLabel(nextUp.media)}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              <Button variant="primary" size="lg" icon={<PlayIcon weight="fill" />} onClick={() => onPlay(nextUp.media)} autoFocus>
                {nextIsEpisode ? "Play next episode" : "Play next"}
              </Button>
              <Button variant="ghost" size="lg" onClick={onDone}>
                Done for tonight
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Up next, or, when someone stopped autoplay, the end of this one. */
export function NextCards({ room, upNext, nextUp, panelOpen, showUpNext, hidden, atCredits, ended, countdown, counting, autoNextOn, reduceMotion, stoppedNext, onPlayNow, onWatchCredits, onStopHere, onPlayAnyway, onBackToPicking }: {
  room: RoomData;
  upNext: UpNext;
  nextUp: Next | undefined;
  panelOpen: boolean;
  showUpNext: boolean;
  /** A skip button is up; it comes first. */
  hidden: boolean;
  atCredits: boolean;
  ended: boolean;
  countdown: number | null;
  counting: boolean;
  autoNextOn: boolean;
  reduceMotion: boolean | null;
  stoppedNext?: Media;
  onPlayNow: () => void;
  onWatchCredits: () => void;
  onStopHere: () => void;
  onPlayAnyway: (media: Media) => void;
  onBackToPicking: () => void;
}) {
  const m = room.media!;
  const blurUnwatched = !!useAuthed().me.prefs.blurUnwatched;
  return (
    <AnimatePresence>
      {showUpNext && nextUp && !hidden && (
        <motion.div
          key="next"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
          className={cx(
            "absolute right-4 bottom-44 flex w-[min(400px,calc(100%-32px))] stage:right-6",
            panelOpen && "stage:right-[408px]",
          )}
        >
          <Pane family="toast" radius={24} className="flex min-h-0 flex-1 gap-3 p-3">
          <Art
            src={(upNext.kind === "episode" ? upNext.thumbnail : undefined) ?? nextUp.media.background ?? art.background(nextUp.media.imdbId)}
            alt=""
            // The next episode's still is a spoiler for a profile that hides unwatched episodes.
            className={cx("aspect-video w-28 shrink-0 rounded-[8px] img-outline", upNext.kind === "episode" && upNext.thumbnail && blurUnwatched && "spoiler overflow-hidden")}
          />
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
            <div className="min-w-0">
              <p
                className={cx(
                  "text-caption font-semibold tracking-[0.08em] uppercase",
                  countdown !== null ? "text-accent" : "text-fg-muted",
                )}
              >
                {countdown !== null ? (
                  <>
                    {upNext.kind === "episode" ? "Next episode" : "Up next"} in{" "}
                    <span className="tabular-nums">{Math.max(countdown, 0)}</span>
                  </>
                ) : (
                  "Up next"
                )}
              </p>
              <p className="truncate text-body font-medium" title={mediaLabel(nextUp.media)}>
                {mediaLabel(nextUp.media)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                className="relative isolate h-9 overflow-hidden px-3.5"
                icon={<SkipForwardIcon weight="fill" />}
                onClick={onPlayNow}
              >
                {/* The countdown fills the button, so it's felt without reading the number. */}
                {countdown !== null && !reduceMotion && (
                  <span
                    key={nextUp.media.videoId}
                    aria-hidden
                    className="absolute inset-0 -z-10 origin-left bg-accent-hover"
                    style={{ animation: `hero-progress ${AUTO_NEXT_SECONDS}s linear forwards` }}
                  />
                )}
                Play now
              </Button>
              {/* In the credits, waiting for the end; at the end (or before credits), turning autoplay off. */}
              {counting && !ended ? (
                <Button variant="ghost" className="h-9 px-3.5" onClick={onWatchCredits}>
                  Watch credits
                </Button>
              ) : (
                autoNextOn && (
                  <Button variant="ghost" className="h-9 px-3.5" onClick={onStopHere}>
                    Stop here
                  </Button>
                )
              )}
            </div>
          </div>
          </Pane>
        </motion.div>
      )}
      {atCredits && upNext.kind === "stopped" && !hidden && (
        <motion.div
          key="stopped"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
          className={cx(
            "absolute right-4 bottom-44 flex w-[min(360px,calc(100%-32px))] stage:right-6",
            panelOpen && "stage:right-[408px]",
          )}
        >
          <Pane family="toast" radius={24} className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div>
            <p className="text-caption font-semibold text-fg-faint">
              End of {m.season !== undefined ? episodeLabel(m.season, m.episode) : m.name}
            </p>
            <p className="text-subhead font-medium">Stopping here, like you said</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {stoppedNext && (
              <Button className="h-9 px-3.5" onClick={() => onPlayAnyway(stoppedNext)}>
                Play {stoppedNext.imdbId === m.imdbId && stoppedNext.season !== undefined ? episodeLabel(stoppedNext.season, stoppedNext.episode) : stoppedNext.name} anyway
              </Button>
            )}
            {room.kind === "party" && (
              <Button variant="ghost" className="h-9 px-3.5" onClick={onBackToPicking}>
                Back to picking
              </Button>
            )}
          </div>
          </Pane>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A film that ended with nothing after it: nothing autoplays, the party decides. */
export function FilmEnded({ show, room, panelOpen, onBackToPicking, onLeave }: {
  show: boolean;
  room: RoomData;
  panelOpen: boolean;
  onBackToPicking: () => void;
  onLeave: () => void;
}) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.3, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.15, ease: "easeIn" } }}
          className={cx("absolute inset-0 grid place-items-center bg-black/70 px-6 backdrop-blur-sm", panelOpen && "stage:pr-[384px]")}
        >
          <div className="flex max-w-md flex-col items-center gap-5 text-center">
            <div className="flex flex-col gap-1">
              <p className="text-body text-fg-muted">You finished {room.media!.name} together</p>
              <p className="font-display text-display font-semibold">What’s next?</p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              <Button variant="primary" icon={<SquaresFourIcon />} onClick={onBackToPicking}>
                Back to picking
              </Button>
              <Button variant="ghost" icon={<SignOutIcon />} onClick={onLeave}>
                Leave party
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
