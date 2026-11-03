import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowClockwiseIcon, ArrowLeftIcon, CornersOutIcon, FastForwardIcon, FilmStripIcon, PlayIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { logProblem } from "../../data/log";
import { android } from "../../ui/android";
import { canFullscreen, toggleFullscreen as toggleAppFullscreen, useFullscreen } from "../../ui/fullscreen";
import { Button, cx, IconButton, Spinner } from "../../ui/ui";
import type { Media } from "../play";
import { ReactionLayer, SITE, type Member, type RoomData, type UpNext } from "../party";
import { useAndroidPlayer, useAndroidVolumeKeys } from "./androidPlayer";
import { AUTO_SKIPS, joinNames, MIN_AUTO_SKIP, useAutomatic, type SkipPart } from "./automatic";
import { fade } from "./chrome";
import { useFramePreview } from "./framePreview";
import { FilmEnded, NextCards, StillWatching } from "./endCards";
import { useAutoHide, usePlayerKeys, type PlayerMenu } from "./keys";
import { useFloatingChat, useRoomNotes } from "./notes";
import { ChatOverlay, GesturePill, LevelMeter, ScrubCard, SeekRipple, SkipStack, StatusPills, TouchTransport } from "./overlays";
import { speedLabel, usePictureInPicture, useSpeed } from "./playback";
import { useRoomSync, type Playback } from "./playbackSync";
import { PlayerControls } from "./PlayerControls";
import { landing, type Part } from "./skips";
import { useSeek } from "./skipping";
import { playerMarks, useAutoSkip, useBufferingHold } from "./together";
import { useUpNextFlow } from "./upNext";
import { usePresence, useSaveProgress } from "./useProgress";
import { useSubtitles } from "./useSubtitles";
import { brightnessFilter, FITS, useAutoRotate, useFitScale, useMediaSession, useTouchGestures } from "./touch";
import { useAutoStart, useFileStream, useHlsStream, useLasting, useVideoState } from "./useVideo";
import type { PlayMode } from "./playsIn";
import { mpvDebands, mpvFits, mpvLiftsSubtitles, mpvTrims, useBarsState, useDeband, useDesktopStream, useMpvVideo, useTrimBars } from "./desktop";
import { usePlaybackHealth } from "./playTiming";
import { episodeLabel } from "../../ui/format";

/** How far subtitles rise while the controls show: the page's own (`-translate-y-36`) and mpv's alike. */
const SUBTITLE_LIFT_PX = 144;

/**
 * The player. Each part of what it does is a hook in this folder (the stream and the element, presence and
 * progress, subtitles, automatic playback, Up next, notes and chat, the keyboard, holding for buffering, auto-skip),
 * called in this order; what it shows is the components in overlays.tsx, endCards.tsx and PlayerControls.tsx.
 */
export function Player({
  room,
  online,
  panelOpen,
  partyButton,
  episodesOpen,
  onEpisodes,
  onClosePanel,
  upNext,
  stoppedNext,
  onExit,
  onSources,
  onOpenParty,
  audioLanguage,
  onAudioLanguage,
  mode,
}: {
  room: RoomData;
  online: Member[];
  panelOpen: boolean;
  /** The Party button, drawn for the controls' capsule. */
  partyButton: ReactNode;
  /** The show's episodes are open beside the picture. */
  episodesOpen: boolean;
  onEpisodes: () => void;
  onClosePanel: () => void;
  upNext: UpNext;
  /** What would have played if nobody had stopped autoplay, for "Play it anyway". */
  stoppedNext?: Media;
  onExit: () => void;
  onSources: () => void;
  onOpenParty: () => void;
  audioLanguage?: string;
  onAudioLanguage: (language: string | undefined) => void;
  /** How this device plays the stream (playsIn.ts): never "elsewhere" here, Watch shows those options instead. */
  mode: Exclude<PlayMode, "elsewhere">;
}) {
  const { token, me } = useAuthed();
  const stream = room.stream!;
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  // In the app, mpv plays the picture under the page and stands in for the element (desktop.ts).
  const mpv = useMpvVideo(mode === "mpv");
  const video = mpv ? (mpv as unknown as HTMLVideoElement) : element;
  usePlaybackHealth(video, stream, !!mpv);
  const heartbeat = useMutation(api.rooms.heartbeat);
  const saveProgress = useMutation(api.progress.save);
  const advance = useMutation(api.rooms.advance);
  const requestSwitch = useMutation(api.rooms.requestSwitch);
  const setStopAfter = useMutation(api.rooms.setStopAfter);
  const watchCreditsFor = useMutation(api.rooms.watchCredits);
  const stopParty = useMutation(api.rooms.stop);
  const leave = useMutation(api.rooms.leave);
  const sendMessage = useMutation(api.messages.send);
  const warmNext = useMutation(api.rooms.warm);
  const m = room.media!;
  const isSeries = m.type === "series";
  const nextUp = upNext.kind === "next" || upNext.kind === "episode" ? upNext : undefined;

  // The room keeps the selected language while a source switch unmounts this player.
  const preferredAudio = useMemo(() => {
    const i = stream.audios.findIndex((a) => a.language === (audioLanguage ?? me.prefs.audioLang));
    return i === -1 ? 0 : i;
  }, [stream.audios, audioLanguage, me.prefs.audioLang]);
  const [audio, setAudio] = useState(preferredAudio);
  const src = `${SITE}/hls/playlist.m3u8?s=${stream._id}&a=${audio}&t=${token}`;
  // The timeline's preview has no sound, so it keeps the first track and its frames through an audio switch.
  // Another service's file has no HLS and isn't in TorBox's keyframe store, so it has no preview pictures.
  const torbox = mode !== "file";
  const preview = useFramePreview(torbox ? `${SITE}/hls/playlist.m3u8?s=${stream._id}&a=0&t=${token}` : "", torbox ? stream.size : undefined, video);

  const fullscreen = useFullscreen();
  const [blocked, setBlocked] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [menu, setMenu] = useState<PlayerMenu>(null);
  // Menus and panels open from the same capsule, so one gives way to the other.
  const openMenu = useCallback(
    (next: PlayerMenu | ((menu: PlayerMenu) => PlayerMenu)) => {
      const to = typeof next === "function" ? next(menu) : next;
      if (to) onClosePanel();
      setMenu(to);
    },
    [menu, onClosePanel],
  );
  const [panelWas, setPanelWas] = useState(panelOpen);
  if (panelOpen !== panelWas) {
    setPanelWas(panelOpen);
    if (panelOpen) setMenu(null);
  }

  // ----- speed: yours alone in the room; a party shares one clock, so it plays at 1×. Holding the picture is 2×.
  const speed = useSpeed(room.kind === "party");
  const [held, setHeld] = useState(false);
  const rate = !speed ? 1 : held ? 2 : speed.speed;
  const browserPip = usePictureInPicture(video);

  const sync = useRoomSync({
    video,
    playback: room.playback as Playback,
    roomId: room._id,
    token,
    enabled: !!video && !fatal,
    rate,
    myId: me._id,
    videoId: m.videoId,
    onAutoplayBlocked: useCallback(() => setBlocked(true), []),
  });

  // ----- the stream, the element's state, and starting once ready
  useHlsStream(mode === "hls" ? video : null, src, sync, setFatal);
  useFileStream(mode === "file" ? element : null, stream._id, token, sync, setFatal);
  useDesktopStream({
    video: mpv,
    streamId: stream._id,
    token,
    audio,
    title: m.episodeTitle ? `${m.name} · ${episodeLabel(m.season, m.episode)}` : m.name,
    startAt: sync.expected,
    setFatal,
  });
  useEffect(() => {
    if (fatal) logProblem("player", `${fatal} ${m.videoId}`, { stream: stream._id, mpv: !!mpv });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fatal]);
  const marksAt = (duration: number) => playerMarks([stream.intro, stream.recap, stream.outro], duration);
  const { paused, time, setTime, duration, waiting, canPlay, volume, setVolume, muted, ended } = useVideoState(video, stream.duration ?? 0, setBlocked, marksAt);
  useAutoStart(video, room, online, me, sync, setBlocked);

  // ----- presence and progress
  // Buffering means "can't play here yet", whether or not we're paused, so a party that paused to
  // wait for us can tell when we've caught up.
  const roomRunning = room.playback.playing || room.playback.action === "wait";
  const buffering = waiting && (roomRunning || !paused);
  usePresence(heartbeat, video, buffering, token, room._id);
  const save = useSaveProgress(saveProgress, video, m, stream.duration, paused, token);

  // ----- controls
  const togglePlay = useCallback(() => {
    if (!video) return;
    if (video.paused && !video.ended && room.playback.playing) {
      // The room plays on without us (the browser blocked autoplay, or we just came back): join it where it is.
      // Sending "play" from here would pull everyone back to where we stopped.
      sync.apply(room.playback as Playback);
    } else if (video.paused) {
      video.play().catch(() => setBlocked(true));
      sync.send("play", true, video.currentTime);
    } else {
      video.pause();
      sync.send("pause", false, video.currentTime);
    }
  }, [video, sync, room.playback]);

  // Back and forward (keys, buttons, a double tap, a headset) gather quick presses into one seek; `aim` is where
  // they're headed, for the timeline, until the picture goes there.
  const { seekTo, skipBy, aim } = useSeek({ video, duration, sync, setTime });

  // In the Android app: the screen kept on, the small window, the phone's brightness given back on the way out.
  const appPip = useAndroidPlayer({ video, paused, togglePlay });
  const pip = appPip ?? browserPip;

  // ----- skippable parts (IntroDB, or the file's own chapters): intro, recap, credits.
  // A skip is a seek, so in a party it moves everyone.
  const within = (seg?: { start: number; end: number }) => !!seg && time >= seg.start && time < seg.end - 1;
  const inIntro = within(stream.intro);
  const inRecap = within(stream.recap);
  const inOutro = within(stream.outro);
  const skip: { label: string; to: number; part: SkipPart | "outro" } | null = inIntro
    ? { label: "Skip intro", to: stream.intro!.end, part: "intro" }
    : inRecap
      ? { label: "Skip recap", to: stream.recap!.end, part: "recap" }
      : // With something up next or a stop, the credits get their own card.
        inOutro && !nextUp && upNext.kind !== "stopped"
        ? { label: "Skip credits", to: stream.outro!.end, part: "outro" }
        : null;

  // The whole app goes full screen, so the Party panel and toasts stay on screen and it lasts after you leave.
  // A phone turns sideways with it. iPhones only let the video itself go full screen, and turn it themselves.
  const toggleFullscreen = useCallback(() => {
    if (canFullscreen()) toggleAppFullscreen({ landscape: true });
    else if (!android) (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
  }, [video]);

  const subtitles = useSubtitles(video, room, me, mpv);

  // ----- automatic playback: your own switches, or in a party everyone's
  const automatic = useAutomatic(online, me, token);
  const { others, mine, allOn, autoNextOn } = automatic;
  // The parts that would skip themselves right now. "Watch it" keeps one playing for the rest of the title.
  const declined = useRef(new Set<SkipPart>());
  const autoParts: Part<SkipPart>[] = AUTO_SKIPS.flatMap(({ part, setting }) => {
    const seg = stream[part];
    return seg && seg.end - seg.start >= MIN_AUTO_SKIP && !declined.current.has(part) && allOn(setting)
      ? [{ part, start: seg.start, end: seg.end }]
      : [];
  });
  // Pressing Skip recap also passes an intro it lands in, when intros skip themselves.
  const skipIntro = useCallback(() => {
    if (skip) seekTo(landing(autoParts, skip.to));
  }, [skip, seekTo, autoParts]);

  const next = useUpNextFlow({
    room, upNext, time, duration, ended, autoNextOn, save, token,
    mutations: { requestSwitch, advance, warmNext, watchCreditsFor },
  });

  const note = useRoomNotes(room, me);
  const { overlayOn, floating } = useFloatingChat(room, me, token);

  const { active, wake, rest } = useAutoHide();
  const visible = active || paused || menu !== null || blocked || !!fatal;
  // The file's own subtitles, which mpv draws, rise above the controls with them, as the page's own do below.
  useEffect(() => {
    if (mpv && mpvLiftsSubtitles()) mpv.liftSubtitles(visible ? SUBTITLE_LIFT_PX : 0);
  }, [mpv, visible]);
  const touch = useTouchGestures({
    video, visible, duration, preview, seekTo, skipBy, volume, setVolume, fullscreen, toggleFullscreen,
    onTap: (wasVisible) => {
      if (menu) setMenu(null);
      else if (wasVisible) rest();
      else wake();
    },
    onHold: speed ? setHeld : null,
  });
  useAndroidVolumeKeys(touch.showLevel);
  // Measured on the page's own element. In the app it has no picture: mpv draws it, and sets the fit itself.
  const fitScale = useFitScale(element, touch.fit);
  const fit = !mpv || mpvFits() ? { fit: touch.fit, setFit: touch.setFit } : null;
  useEffect(() => {
    if (mpv && mpvFits()) mpv.setFit(touch.fit);
  }, [mpv, touch.fit]);
  // In the app, mpv trims black bars built into the film too, unless they're switched off in the Picture menu.
  const [trimBars, setTrimBars] = useTrimBars();
  const trims = !!mpv && mpvTrims();
  useEffect(() => {
    if (mpv && trims) mpv.setTrim(trimBars);
  }, [mpv, trims, trimBars]);
  const barsState = useBarsState(trims ? mpv : null);
  const bars = trims ? { state: barsState, setTrim: setTrimBars } : null;
  const toggleBars = trims
    ? () => {
        setTrimBars(!trimBars);
        touch.showFlash("zoom", trimBars ? "Keeping black bars" : "Trimming black bars");
      }
    : null;
  // And evens out colour banding, unless that's switched off.
  const [deband, setDeband] = useDeband();
  const debands = !!mpv && mpvDebands();
  useEffect(() => {
    if (mpv && debands) mpv.setDeband(deband);
  }, [mpv, debands, deband]);
  const smooth = debands ? { on: deband, set: setDeband } : null;
  const cycleFit = fit
    ? () => {
        const to = FITS[(FITS.findIndex((x) => x.fit === fit.fit) + 1) % FITS.length]!;
        fit.setFit(to.fit);
        touch.showFlash("zoom", to.flash);
      }
    : null;
  useAutoRotate(!paused);
  // A finger on the picture leaves the controls to its tap: a double tap or a drag adjusts without bringing them up.
  const wakeFor = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || e.target !== video) wake();
  };

  usePlayerKeys({
    video, menu, setMenu: openMenu, wake, togglePlay, skipBy, setVolume, toggleFullscreen,
    toggleSubtitles: subtitles.toggle,
    skip: skip ? skipIntro : null,
    playNext: nextUp ? next.playNext : null,
    episodes: isSeries ? onEpisodes : null,
    reactions: room.kind === "party",
    speed: speed && ((by) => touch.showFlash("speed", `Speed ${speedLabel(speed.step(by))}`)),
    pictureInPicture: pip?.toggle ?? null,
    cycleFit,
    toggleBars,
  });

  useMediaSession({ media: m, video, togglePlay, seekTo, skipBy, playNext: nextUp ? next.playNext : null });

  const othersBuffering = online.filter((x) => !x.isMe && x.buffering);
  const { holdFor, iLead, waitingForOthers, together } = useBufferingHold({ video, room, online, me, buffering, sync, setBlocked });
  const skipped = useAutoSkip({ video, room, iLead, waitingForOthers, autoParts, declined, seekTo, serverNow: sync.serverNow });

  // In a party, say why a skip didn't happen on its own: you'd have skipped, someone else keeps it.
  const skipSetting = skip && skip.part !== "outro" ? AUTO_SKIPS.find((x) => x.part === skip.part)!.setting : null;
  const keepers = skipSetting && mine(skipSetting) ? others.filter((x) => !x.auto[skipSetting]) : [];
  const keepersNote =
    keepers.length > 0 && skip
      ? `${joinNames(keepers.map((x) => x.name))} ${keepers.length === 1 ? "keeps" : "keep"} ${skip.part}s on`
      : null;

  const reduceMotion = useReducedMotion();
  // A wait that ends quickly (most skips) shows nothing; one that lasts brings up the spinner.
  const stalled = useLasting(waiting && !paused, 400);
  const loading = stalled || (!video?.readyState && !fatal);
  // The one-capsule layout's play and skip buttons in the middle of the picture, while the controls show. Not at the end (its cards
  // decide what's next), or over "Start watching" and errors.
  const transport = visible && !ended && !blocked && !fatal && !touch.scrub;
  const marks = useMemo(
    () => [stream.recap, stream.intro, stream.outro].filter((x): x is NonNullable<typeof x> => !!x),
    [stream.recap, stream.intro, stream.outro],
  );
  const nextIsEpisode = !!nextUp && nextUp.media.type === "series" && nextUp.media.imdbId === m.imdbId;
  const closeMenu = useCallback(() => setMenu(null), []);

  const doneForTonight = () => {
    if (video && !video.paused) {
      video.pause();
      sync.send("pause", false, video.currentTime);
    }
    onExit();
  };

  return (
    <div
      // Over the picture the glass is clearer than elsewhere, but still dims what's behind it by about a third
      // (Apple's figure for clear glass over bright media), so it reads over the brightest frame.
      className={cx("relative h-full w-full select-none [--glass-tint:oklch(0.18_0.006_60/0.36)]", !visible && "cursor-none")}
      onPointerMove={wakeFor}
      onPointerDown={wakeFor}
    >
      <video
        ref={setElement}
        playsInline
        preload="auto"
        // The picture takes every touch itself: a swipe on it is full screen, never a scroll or a zoom. Filling the
        // screen grows it on a spring rather than switching object-fit, which can't move. In the app it stays empty and
        // clear, over mpv's picture, and still takes the clicks.
        className={cx(
          "absolute inset-0 h-full w-full touch-none object-contain transition-[scale] duration-300 ease-spring",
          mpv ? "bg-transparent" : "bg-black",
        )}
        style={{ filter: brightnessFilter(touch.brightness), scale: fitScale }}
        {...touch.handlers}
        // Touch has its own taps (useTouchGestures); these are the mouse's.
        onClick={() => {
          if (touch.touching()) return;
          if (menu) setMenu(null);
          else if (!visible) wake();
          else togglePlay();
        }}
        onDoubleClick={() => !touch.touching() && toggleFullscreen()}
      />
      <SeekRipple seek={touch.seek} />
      <LevelMeter level={touch.level} />
      <GesturePill
        icon={held || touch.flash?.kind === "speed" ? <FastForwardIcon weight="fill" size={18} /> : <CornersOutIcon size={18} />}
        text={held ? "2× speed" : (touch.flash?.text ?? null)}
      />
      <ScrubCard scrub={touch.scrub} preview={preview} />

      {/* Subtitles ride above the controls when they're showing. */}
      {subtitles.cueHtml && (
        <div
          className={cx(
            "pointer-events-none absolute inset-x-0 bottom-12 flex justify-center px-6 text-center transition-transform duration-200 ease-snappy",
            visible && "-translate-y-36",
          )}
        >
          <p
            className="subtitle-cue max-w-[42ch] text-white"
            // How this profile likes them drawn (Settings → Playback); unset is medium white with a shadow.
            data-size={me.prefs.subtitleSize}
            data-color={me.prefs.subtitleColor}
            data-edge={me.prefs.subtitleEdge}
            dangerouslySetInnerHTML={{ __html: subtitles.cueHtml }}
          />
        </div>
      )}

      {/* In the one-capsule layout, with the controls up, the spinner sits between its play and skip buttons instead. */}
      {loading && (
        <div className={cx("pointer-events-none absolute inset-0 grid place-items-center", transport && "compact:hidden")}>
          <Spinner className="size-10 border-[3px] text-white/80" />
        </div>
      )}

      {/* Scrims keep controls readable on bright frames: the bottom one reaches up behind the title. */}
      <div
        aria-hidden
        className={cx(
          "pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,oklch(0_0_0/0.45),transparent_20%,transparent_55%,oklch(0_0_0/0.75))] transition-opacity duration-200",
          visible ? "opacity-100" : "opacity-0",
        )}
      />

      {/* Top bar: above the "Start watching" and error screens, so Back still answers there. Party is in the controls. */}
      <div
        className={cx(
          // Clear of a notch and the status bar; the picture itself runs under them.
          "pointer-events-none absolute top-[var(--safe-top)] right-[var(--safe-right)] left-[var(--safe-left)] z-10 flex items-center gap-3 p-4 transition-[padding] duration-200 stage:p-6",
          panelOpen && "stage:pr-[408px]",
        )}
      >
        <IconButton label="Back" tone="glass" onClick={onExit} className={cx("pointer-events-auto", fade(visible))}>
          <ArrowLeftIcon />
        </IconButton>
        <span className="flex-1" />
        {othersBuffering.length > 0 && (
          <span
            className={cx("hidden items-center gap-2 rounded-full glass px-3 py-1.5 text-caption text-fg-muted sm:flex", fade(visible))}
          >
            <Spinner className="size-3" /> {othersBuffering.map((o) => o.name).join(", ")} is buffering
          </span>
        )}
      </div>

      <TouchTransport
        visible={transport}
        paused={paused}
        loading={loading || waitingForOthers}
        onPlay={togglePlay}
        onBack={() => skipBy(-10)}
        onForward={() => skipBy(10)}
      />

      {/* Paused: one glass play button in the middle of the picture (the one-capsule layout has its own, above). Not while there's nothing to play yet, at the
          end (its cards decide what's next), or while the party waits for someone: pressing it there would start
          everyone. Pausing is frequent, so it's quick and doesn't bounce. */}
      <AnimatePresence>
        {paused && canPlay && !ended && !waitingForOthers && !blocked && !fatal && (
          <motion.div
            key="paused"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.15 } }}
            exit={{ opacity: 0, transition: { duration: 0.1, ease: "easeIn" } }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 compact:hidden"
          >
            {/* A big target for a pointer; keyboards and screen readers have Play in the controls. */}
            <IconButton tone="glass" label="Play" aria-hidden tabIndex={-1} onClick={togglePlay} className="size-24 text-[40px]">
              {/* Phosphor's triangle sits right of its box's centre already; this brings its weight to the middle. */}
              <PlayIcon weight="fill" className="-translate-x-0.5" />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Center: autoplay needs a tap, or the stream failed */}
      {blocked && !fatal && (
        <div className="absolute inset-0 grid place-items-center bg-black/40">
          <Button
            variant="primary"
            size="lg"
            icon={<PlayIcon weight="fill" />}
            onClick={() => {
              setBlocked(false);
              sync.apply(room.playback as Playback);
              if (video?.paused) togglePlay();
            }}
          >
            {room.playback.playing ? "Join playback" : "Start watching"}
          </Button>
        </div>
      )}
      {fatal && (
        <div className="absolute inset-0 grid place-items-center bg-black/70 px-6">
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <p className="flex items-center gap-2 text-subhead font-medium">
              <WarningCircleIcon className="text-danger" size={20} /> {fatal}
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Button variant="primary" icon={<ArrowClockwiseIcon weight="bold" />} onClick={() => location.reload()}>
                Reload
              </Button>
              <Button icon={<FilmStripIcon />} onClick={onSources}>
                Choose another source
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Alone, the spinner is enough: nobody is waiting for you. */}
      <StatusPills panelOpen={panelOpen} waitingForOthers={waitingForOthers && together} holdFor={holdFor} note={note} />

      <SkipStack
        visible={visible}
        panelOpen={panelOpen}
        menuOpen={!!menu}
        receipt={skipped.receipt}
        held={skipped.held}
        onHold={skipped.setHeldSeq}
        onFocusHold={skipped.setFocusedSeq}
        onReceiptDone={skipped.dismissReceipt}
        watchSkipped={skipped.watchSkipped}
        skip={skip}
        keepersNote={keepersNote}
        onSkip={skipIntro}
        reduceMotion={reduceMotion}
      />

      <StillWatching
        show={next.stillWatching}
        room={room}
        nextUp={nextUp}
        nextIsEpisode={nextIsEpisode}
        onPlay={(media) => next.moveOn(media)}
        onDone={doneForTonight}
      />

      <NextCards
        room={room}
        upNext={upNext}
        nextUp={nextUp}
        panelOpen={panelOpen}
        showUpNext={next.showUpNext}
        hidden={!!skip}
        atCredits={next.atCredits}
        ended={ended}
        countdown={next.countdown}
        counting={next.counting}
        autoNextOn={autoNextOn}
        reduceMotion={reduceMotion}
        stoppedNext={stoppedNext}
        onPlayNow={() => (next.atCredits && nextUp ? next.moveOn(nextUp.media) : next.playNext())}
        onWatchCredits={next.watchCredits}
        onStopHere={() => void setStopAfter({ token, roomId: room._id, on: true, videoId: m.videoId })}
        onPlayAnyway={(media) => void requestSwitch({ token, roomId: room._id, media })}
        onBackToPicking={() => void stopParty({ token, roomId: room._id })}
      />

      <FilmEnded
        show={ended && upNext.kind === "none" && room.kind === "party"}
        room={room}
        panelOpen={panelOpen}
        onBackToPicking={() => void stopParty({ token, roomId: room._id })}
        onLeave={async () => {
          await leave({ token, roomId: room._id, announce: true });
          onExit();
        }}
      />

      {overlayOn && !panelOpen && floating.length > 0 && (
        <ChatOverlay room={room} floating={floating} visible={visible} onOpenParty={onOpenParty} />
      )}

      <PlayerControls
        room={room}
        video={video}
        visible={visible}
        paused={paused}
        duration={duration}
        marks={marks}
        preview={preview}
        volume={volume}
        muted={muted}
        fullscreen={fullscreen}
        menu={menu}
        setMenu={openMenu}
        closeMenu={closeMenu}
        nextUp={nextUp}
        episodesOpen={episodesOpen}
        partyButton={partyButton}
        audio={audio}
        setAudio={(index) => {
          setAudio(index);
          onAudioLanguage(stream.audios[index]?.language);
        }}
        subtitles={subtitles}
        automatic={automatic}
        togglePlay={togglePlay}
        seekTo={seekTo}
        skipBy={skipBy}
        aim={aim}
        setVolume={setVolume}
        // The Android app's player is always full screen and sideways.
        toggleFullscreen={android ? null : toggleFullscreen}
        playNext={next.playNext}
        fit={fit}
        bars={bars}
        deband={smooth}
        pip={pip}
        onEpisodes={onEpisodes}
        onSources={onSources}
        onReact={(emoji) => void sendMessage({ token, roomId: room._id, kind: "reaction", body: emoji })}
      />
      <ReactionLayer room={room} className={cx("right-8 bottom-40 h-64 w-24", panelOpen && "stage:right-[408px]")} />
    </div>
  );
}
