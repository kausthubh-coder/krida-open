// The controls along the bottom: the title, the timeline, and two capsules of glass with their menus.
import type { ReactNode } from "react";
import { Glass } from "bubli";
import {
  ClockClockwiseIcon,
  ClockCounterClockwiseIcon,
  ClosedCaptioningIcon,
  CornersInIcon,
  CornersOutIcon,
  CropIcon,
  FastForwardIcon,
  FilmStripIcon,
  ListNumbersIcon,
  PauseIcon,
  PictureInPictureIcon,
  PlayIcon,
  SkipForwardIcon,
  SmileyIcon,
  TranslateIcon,
} from "@phosphor-icons/react";
import { TitleArt } from "../../ui/artwork";
import { episodeLabel, languageName } from "../../ui/format";
import { cx, IconButton, Kbd, Toggle } from "../../ui/ui";
import { mediaLabel, ReactionPicker, type RoomData, type UpNext } from "../party";
import { AUTO_ROWS, type AutoKey } from "./automatic";
import { CAP, CAPSULE, capOpen, capsuleBubble, fade } from "./chrome";
import { MenuLabel, MenuRow, Popover, SubtitleMenu, Timeline, Volume } from "./controls";
import { SpeedChoice } from "./SpeedChoice";
import type { BarsState } from "./desktop";
import type { FramePreview } from "./framePreview";
import type { PlayerMenu } from "./keys";
import { FITS, type Fit } from "./touch";
import type { useSubtitles } from "./useSubtitles";

type Next = Extract<UpNext, { kind: "next" | "episode" }>;

/** What the Picture menu says under Trim black bars, short enough to fit beside the switch. */
const BARS_HINTS: Record<BarsState, string> = {
  off: "Built-in bars stay",
  looking: "Looking for bars…",
  none: "No bars built in",
  unsure: "Couldn't tell. Try Crop",
  trimmed: "Trimmed the built-in bars",
};

export function PlayerControls(props: {
  room: RoomData;
  video: HTMLVideoElement | null;
  visible: boolean;
  paused: boolean;
  duration: number;
  marks: { start: number; end: number }[];
  preview: FramePreview | null;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  menu: PlayerMenu;
  setMenu: (menu: PlayerMenu) => void;
  closeMenu: () => void;
  nextUp: Next | undefined;
  episodesOpen: boolean;
  partyButton: ReactNode;
  audio: number;
  setAudio: (track: number) => void;
  subtitles: ReturnType<typeof useSubtitles>;
  automatic: { others: unknown[]; mine: (key: AutoKey) => boolean; setMine: (key: AutoKey, on: boolean) => void; whoHasIt: (key: AutoKey) => string };
  togglePlay: () => void;
  seekTo: (t: number) => void;
  skipBy: (seconds: number) => void;
  /** Where quick skips are headed before the picture goes there. */
  aim: number | null;
  setVolume: (volume: number) => void;
  /** Null where the player can't leave full screen (the Android app). */
  toggleFullscreen: (() => void) | null;
  playNext: () => void;
  /** How the picture sits in the frame. Null where the page can't scale the picture (mpv, in the app). */
  fit: { fit: Fit; setFit: (fit: Fit) => void } | null;
  /** Trimming black bars built into the film: only in the app, where mpv can. */
  bars: { state: BarsState; setTrim: (on: boolean) => void } | null;
  /** Evening out colour banding: only in the app, where mpv can. */
  deband: { on: boolean; set: (on: boolean) => void } | null;
  pip: { on: boolean; toggle: () => void } | null;
  speed: { speed: number; setSpeed: (speed: number) => void } | null;
  onShortcuts: () => void;
  onEpisodes: () => void;
  onSources: () => void;
  onReact: (emoji: string) => void;
}) {
  const { room, video, visible, paused, duration, marks, preview, volume, muted, fullscreen, menu, setMenu, closeMenu, nextUp, episodesOpen, partyButton, audio, setAudio, subtitles, automatic, togglePlay, seekTo, skipBy, aim, setVolume, toggleFullscreen, playNext, fit, bars, deband, pip, onEpisodes, onSources, onReact } = props;
  const m = room.media!;
  const stream = room.stream!;
  const isSeries = m.type === "series";
  const manyAudios = stream.audios.length > 1;
  const { others, mine, setMine, whoHasIt } = automatic;
  const autoRows = (
    <>
      {AUTO_ROWS.map(({ key, label }) => (
        <label key={key} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-control px-3 py-2 hover:bg-white/8">
          <span className="min-w-0 flex-1">
            <span className="block text-body">{label}</span>
            {others.length > 0 && <span className="block truncate text-caption text-fg-muted">{whoHasIt(key)}</span>}
          </span>
          <Toggle checked={mine(key)} onChange={(on) => setMine(key, on)} />
        </label>
      ))}
      {others.length > 0 && (
        <p className="mt-1 border-t border-line px-3 pt-2 pb-1.5 text-caption text-fg-faint">
          In a party, Krida only skips or moves on when everyone has it on.
        </p>
      )}
    </>
  );
  // The ways to fit the picture; in the app, trimming bars built into the film and evening out banding; then
  // picture in picture, and the keys for the first two.
  const pictureRows = (
    <>
      <SpeedChoice speed={props.speed} />
      <MenuRow selected={false} onClick={props.onShortcuts} hint="?">Keyboard shortcuts</MenuRow>
      <MenuLabel>Picture</MenuLabel>
      {fit &&
        FITS.map((x) => (
          <MenuRow key={x.fit} selected={fit.fit === x.fit} onClick={() => fit.setFit(x.fit)} hint={x.hint}>
            {x.label}
          </MenuRow>
        ))}
      {(bars || deband) && (
        <div className="mt-1 border-t border-line pt-1">
          {bars && <PictureSwitch label="Trim black bars" hint={BARS_HINTS[bars.state]} checked={bars.state !== "off"} onChange={bars.setTrim} />}
          {deband && <PictureSwitch label="Smooth colour banding" hint="Skies and dark scenes" checked={deband.on} onChange={deband.set} />}
        </div>
      )}
      {pip && (
        <div className={cx(fit && "mt-1 border-t border-line pt-1")}>
          <button
            onClick={() => {
              setMenu(null);
              pip.toggle();
            }}
            className="flex min-h-10 w-full items-center gap-3 rounded-control px-3 py-2 text-left text-body text-fg-muted hover:bg-white/8 hover:text-fg pointer-coarse:min-h-11"
          >
            <PictureInPictureIcon className="size-4 shrink-0" />
            {pip.on ? "Back to the player" : "Picture in picture"}
          </button>
        </div>
      )}
      {fit && (
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line px-3 pt-2 pb-1.5 text-caption text-fg-faint pointer-coarse:hidden">
          <Kbd>V</Kbd> next fit
          {bars && (
            <>
              <span aria-hidden className="px-0.5">
                ·
              </span>
              <Kbd>B</Kbd> trim bars
            </>
          )}
        </p>
      )}
    </>
  );
  const audioRows = stream.audios.map((a, i) => (
    <MenuRow
      key={i}
      selected={i === audio}
      onClick={() => {
        setAudio(i);
        setMenu(null);
      }}
      hint={[a.codec?.toUpperCase(), a.channels ? `${a.channels === 6 ? "5.1" : a.channels === 8 ? "7.1" : `${a.channels} ch`}` : undefined]
        .filter(Boolean)
        .join(" · ")}
    >
      {/* Track titles that only restate the format ("AC3 / 5.1 Ch / 640 kbps") add nothing to the hint. */}
      {a.title && !/\b(ac-?3|e-?ac-?3|dts|aac|truehd|atmos|flac|opus|stereo|surround|kbps|\d\.\d|ch)\b/i.test(a.title)
        ? `${languageName(a.language)} · ${a.title}`
        : languageName(a.language)}
    </MenuRow>
  ));

  return (
    // Each piece fades itself (see `fade`); this wrapper only lets taps through to the video.
    <div
      className={cx(
        "pointer-events-none absolute right-[var(--safe-right)] bottom-[var(--safe-bottom)] left-[var(--safe-left)] flex flex-col gap-2 px-3 pb-4 sm:px-4 stage:px-6 stage:pb-6",
      )}
    >
      {/* Like a cinema: the title's logo and the episode, a thin timeline with the time at each end, then two small
          capsules of glass. The file's details are in Change source, beside "Playing". */}
      <div className={cx("flex min-w-0 flex-col items-start gap-1.5 px-1", fade(visible))}>
        <TitleArt imdbId={m.imdbId} name={m.name} logo={m.logo} size="player" />
        {m.season !== undefined && (
          <p className="max-w-full truncate text-subhead [text-shadow:0_1px_2px_oklch(0_0_0/0.6)]">
            <span className="font-medium">{episodeLabel(m.season, m.episode)}</span>
            {m.episodeTitle && <span className="text-fg-muted"> · {m.episodeTitle}</span>}
          </p>
        )}
      </div>
      <Timeline
        video={video}
        shown={visible}
        duration={duration}
        marks={marks}
        preview={preview}
        aim={aim}
        onSeek={seekTo}
        onSkip={skipBy}
        className={cx("pointer-events-auto [text-shadow:0_1px_2px_oklch(0_0_0/0.6)]", fade(visible))}
      />
      {/*
        Every button shows, always: nothing folds away. Each is 44px and the capsules are 52px tall. Play, ±10 and
        Volume (+88 while its slider shows) on the left, 272; then React (parties), Next, Episodes, Picture,
        Automatic, Subtitles, Audio, Source, Party and Full screen, at most 448. Picture also offers Speed.
        On touch, or a window too narrow for both (`compact:`), the left capsule gives way
        to play and the skips in the middle of the picture (TouchTransport), and the right one sits in the middle.
        Panels and menus open over the picture, so nothing here moves for them.
      */}
      <div className="flex items-center gap-2">
        <Glass {...capsuleBubble()} className={cx(CAPSULE, "pointer-events-auto compact:hidden", fade(visible))}>
          <IconButton label={paused ? "Play (Space)" : "Pause (Space)"} onClick={togglePlay} className={cx(CAP, "text-[24px]")}>
            {/* Phosphor's triangle sits right of its box's centre already; a pixel back balances it. */}
            {paused ? <PlayIcon weight="fill" className="-translate-x-px" /> : <PauseIcon weight="fill" />}
          </IconButton>
          <IconButton label="Back 10 seconds" onClick={() => skipBy(-10)} className={CAP}>
            <ClockCounterClockwiseIcon />
          </IconButton>
          <IconButton label="Forward 10 seconds" onClick={() => skipBy(10)} className={CAP}>
            <ClockClockwiseIcon />
          </IconButton>
          <Volume
            volume={volume}
            muted={muted}
            onVolume={setVolume}
            onMute={() => video && (video.muted = !video.muted)}
            className="flex"
            buttonClassName={CAP}
          />
        </Glass>
        {/* Menus open beside the capsule, not inside it: glass inside glass can't see the picture. Alone, the capsule
            sits in the middle, under play and the skips. Party and Episodes open from it too (data-panel-anchor). */}
        <div className="relative ml-auto max-w-full min-w-0 compact:mr-auto">
          {/* A window too narrow even for this (under about 470px) scrolls it sideways rather than cut it off. */}
          <Glass {...capsuleBubble()} data-panel-edge className={cx(CAPSULE, "pointer-events-auto max-w-full", fade(visible))}>
            <div className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none]">
            {room.kind === "party" && (
              <IconButton
                label="React (R)"
                aria-haspopup="dialog"
                aria-expanded={menu === "react"}
                onClick={() => setMenu(menu === "react" ? null : "react")}
                className={capOpen(menu === "react")}
              >
                <SmileyIcon weight={menu === "react" ? "fill" : "regular"} />
              </IconButton>
            )}
            {nextUp && (
              <IconButton label={`Play next: ${mediaLabel(nextUp.media)}`} onClick={playNext} className={CAP}>
                <SkipForwardIcon />
              </IconButton>
            )}
            {isSeries && (
              <IconButton
                label="Episodes (E)"
                aria-pressed={episodesOpen}
                data-panel-anchor="episodes"
                onClick={() => {
                  setMenu(null);
                  onEpisodes();
                }}
                className={capOpen(episodesOpen)}
              >
                <ListNumbersIcon weight={episodesOpen ? "fill" : "regular"} />
              </IconButton>
            )}
            <>
              <IconButton
                label="Picture and speed"
                aria-haspopup="dialog"
                aria-expanded={menu === "picture"}
                onClick={() => setMenu(menu === "picture" ? null : "picture")}
                className={capOpen(menu === "picture")}
              >
                <CropIcon weight={menu === "picture" || (fit && fit.fit !== "fit") ? "fill" : "regular"} />
              </IconButton>
            </>
            <IconButton
              label="Automatic (A)"
              aria-haspopup="dialog"
              aria-expanded={menu === "auto"}
              onClick={() => setMenu(menu === "auto" ? null : "auto")}
              className={capOpen(menu === "auto")}
            >
              <FastForwardIcon weight={menu === "auto" ? "fill" : "regular"} />
            </IconButton>
            <IconButton
              label="Subtitles (C)"
              aria-haspopup="dialog"
              aria-expanded={menu === "subs"}
              onClick={() => setMenu(menu === "subs" ? null : "subs")}
              className={capOpen(menu === "subs")}
            >
              <ClosedCaptioningIcon weight={subtitles.subId ? "fill" : "regular"} />
            </IconButton>
            {manyAudios && (
              <IconButton
                label="Audio language"
                aria-haspopup="dialog"
                aria-expanded={menu === "audio"}
                onClick={() => setMenu(menu === "audio" ? null : "audio")}
                className={capOpen(menu === "audio")}
              >
                <TranslateIcon />
              </IconButton>
            )}
            <IconButton label="Change source" onClick={onSources} className={CAP}>
              <FilmStripIcon />
            </IconButton>
            {partyButton}
            {toggleFullscreen && (
              <IconButton label={fullscreen ? "Exit full screen (F)" : "Full screen (F)"} onClick={toggleFullscreen} className={CAP}>
                {fullscreen ? <CornersInIcon /> : <CornersOutIcon />}
              </IconButton>
            )}
            </div>
          </Glass>
          <Popover open={menu === "react"} title="React" onClose={closeMenu}>
            <ReactionPicker onReact={onReact} />
          </Popover>
          <Popover open={menu === "picture"} title="Picture" onClose={closeMenu}>
            {pictureRows}
          </Popover>
          <Popover open={menu === "auto"} title="Automatic" onClose={closeMenu}>
            {autoRows}
          </Popover>
          <Popover open={menu === "subs"} title="Subtitles" onClose={closeMenu}>
              <SubtitleMenu
                fileTracks={subtitles.fileSubs}
                filePlayable={subtitles.filePlayable}
                options={subtitles.subs}
                current={subtitles.subId ?? null}
                error={subtitles.subError}
                offset={subtitles.subOffset}
                onOffset={subtitles.setSubOffset}
                localSubs={subtitles.localSubs}
                onLoadFile={subtitles.loadFile}
                fileError={subtitles.fileError}
                onPick={(id) => subtitles.setSubPick(id)}
              />
          </Popover>
          <Popover open={menu === "audio"} title="Audio language" onClose={closeMenu}>
            {audioRows}
          </Popover>
        </div>
      </div>
    </div>
  );
}

/** A switch in the Picture menu, with what it's doing now beneath its name. */
function PictureSwitch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-control px-3 py-2 hover:bg-white/8">
      <span className="min-w-0 flex-1">
        <span className="block text-body">{label}</span>
        <span className="block truncate text-caption text-fg-muted">{hint}</span>
      </span>
      <Toggle checked={checked} onChange={onChange} />
    </label>
  );
}
