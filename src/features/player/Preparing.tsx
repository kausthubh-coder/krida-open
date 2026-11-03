import { useEffect, useState, type ReactNode } from "react";
import { ArrowClockwiseIcon, CheckIcon, FilmStripIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { art } from "../../data/cinemeta";
import { episodeLabel } from "../../ui/format";
import { Art, TitleArt } from "../../ui/artwork";
import { Button, cx, Spinner } from "../../ui/ui";
import type { RoomData } from "../party";
import { useOnboardingStatus } from "../../data/keys";

const STEPS = ["Finding sources…", "Adding to TorBox…", "Starting stream…"];
/** Another debrid service's file plays from its link: no TorBox, no stream to start (engine.ts `buildStream`). */
const DIRECT_STEPS = ["Finding sources…", "Asking your debrid service…"];
/** Most steps take a second or two; past this one says so and offers picking a source more plainly. */
const SLOW_STEP_MS = 10_000;

/** Between picking a title and the picture starting: what's happening, and who picked it. */
export function Preparing({
  room,
  topBar,
  pickedBy,
  onRetry,
  onSources,
  onFallback,
  refreshing,
}: {
  room: RoomData;
  topBar: ReactNode;
  pickedBy?: string;
  onRetry: () => void;
  onSources: () => void;
  onFallback: () => void;
  refreshing: boolean;
}) {
  const status = useOnboardingStatus();
  // The room plays its host's account's service: in a party that's TorBox, alone it's this account's.
  const steps = room.kind !== "party" && status && !status.torbox && status.debrid ? DIRECT_STEPS : STEPS;
  const current = steps.indexOf(room.step ?? "");
  // The step that has lasted past SLOW_STEP_MS, so the next step starts its wait from nothing.
  const [slowStep, setSlowStep] = useState<string | undefined>();
  useEffect(() => {
    const id = setTimeout(() => setSlowStep(room.step), SLOW_STEP_MS);
    return () => clearTimeout(id);
  }, [room.step]);
  // The server's note says why ("That copy was slow. Trying another."); without one, only that it's slow.
  const note = room.stepNote ?? (slowStep === room.step ? "Taking longer than usual." : undefined);
  const m = room.media!;
  return (
    <div className="relative isolate flex h-full flex-col">
      <Art
        src={m.background ?? art.backgroundLarge(m.imdbId)}
        alt=""
        eager
        className="absolute inset-0 -z-10 bg-page"
        imgClassName="scale-105 blur-2xl brightness-[0.35]"
      />
      {topBar}
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-24 text-center">
        <div className="flex max-w-xl flex-col items-center gap-3">
          <TitleArt imdbId={m.imdbId} name={m.name} logo={m.logo} size="page" />
          {(m.episodeTitle || pickedBy) && (
            <p className="text-subhead text-fg-muted">
              {m.episodeTitle && `${episodeLabel(m.season, m.episode)} · ${m.episodeTitle}`}
              {m.episodeTitle && pickedBy && " · "}
              {pickedBy && <span className="text-fg-faint">picked by {pickedBy}</span>}
            </p>
          )}
        </div>
        {room.status === "error" ? (
          <div className="flex max-w-md flex-col items-center gap-4">
            <div className="flex flex-col items-center gap-1.5">
              <p className="flex items-center gap-2 text-subhead font-medium text-fg">
                <WarningCircleIcon className="shrink-0 text-danger" size={20} />
                This stream couldn’t start
              </p>
              {/* What went wrong: which service, or what happened to each copy tried. */}
              {room.error && <p className="text-body text-pretty text-fg-muted">{room.error}</p>}
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              {room.sourceFallback ? (
                <Button variant="primary" onClick={onFallback}>Play in {room.sourceFallback.resolution}</Button>
              ) : (
                <Button variant="primary" icon={<ArrowClockwiseIcon weight="bold" />} loading={refreshing} onClick={onRetry}>
                  Refresh sources
                </Button>
              )}
              <Button icon={<FilmStripIcon />} onClick={onSources}>
                Choose another source
              </Button>
            </div>
            {room.errorDetail && (
              <details className="max-w-full text-caption text-fg-muted">
                <summary className="cursor-pointer rounded-control px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2">Technical details</summary>
                <p className="mt-2 break-words">{room.errorDetail}</p>
              </details>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-5">
            <ol className="flex flex-col gap-2 text-left">
              {steps.map((s, i) => {
                const done = current > i;
                const active = current === i || (current === -1 && i === 0);
                return (
                  <li
                    key={s}
                    className={cx(
                      "flex items-center gap-3 text-subhead",
                      done ? "text-fg-muted" : active ? "text-fg" : "text-fg-faint",
                    )}
                  >
                    <span className="grid size-5 place-items-center">
                      {done ? (
                        <CheckIcon weight="bold" className="text-success" />
                      ) : active ? (
                        <Spinner />
                      ) : (
                        <span className="size-1.5 rounded-full bg-fg-faint" />
                      )}
                    </span>
                    {s.replace("…", "")}
                  </li>
                );
              })}
            </ol>
            {note && <p className="text-caption text-fg-muted">{note}</p>}
            <Button variant={note ? "secondary" : "ghost"} icon={<FilmStripIcon />} onClick={onSources}>
              Pick a source myself
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
