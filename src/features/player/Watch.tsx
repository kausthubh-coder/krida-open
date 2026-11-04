import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useAction, useMutation } from "convex/react";
import { toast } from "../../ui/toast";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { AnimatePresence } from "motion/react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { currentScreen } from "../../ui/screen";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { episodeLabel } from "../../ui/format";
import { errorMessage, type Media, SourcesSheet } from "../play";
import { playReady } from "../../ui/sound";
import { ButtonLink, cx, IconButton, Spinner } from "../../ui/ui";
import { desktopApp } from "../../data/desktop";
import { usePartyPanel, SwitchPrompt, EpisodesPanel, PartyButton, PartyPanel, useUpNext, ArrivalBanner, useEventToasts, useJoinMoments, useReactionSounds, ONLINE_MS, useRoomPeople, useServerNow, type RoomData } from "../party";
import { Preparing } from "./Preparing";
import { PlayElsewhere } from "./elsewhere";
import { browserCanPlay, playsIn } from "./playsIn";
import { Player } from "./Player";
import { useReleaseOrientation } from "./touch";
import { useSideways } from "../../ui/sideways";
import { enterPlayerLandscape } from "../../ui/fullscreen";
import { nativePlayer, useAndroidWatching } from "./androidPlayer";
import { usePlayTiming } from "./playTiming";
import { canGoBack } from "../../ui/history";

export function Watch() {
  const { roomId } = useParams<{ roomId: string }>();
  const { token } = useAuthed();
  const id = roomId as Id<"rooms">;
  // A room shows only to its members, so it's read once this screen has joined it.
  const [joined, setJoined] = useState<string | null>(null);
  const room = useQuery(api.rooms.get, joined === id ? { token, roomId: id } : "skip");
  const join = useMutation(api.rooms.join);
  const leave = useMutation(api.rooms.leave);
  const [joinError, setJoinError] = useState<string | null>(null);
  const kind = useRef<string | undefined>(undefined);
  kind.current = room?.kind;

  useEffect(() => {
    join({ token, roomId: id }).then(() => setJoined(id), (e) => setJoinError(errorMessage(e, "Couldn't join this party")));
    // Walking away from a party keeps you in it (the header takes you back); a solo room just ends.
    const leaveIfSolo = () => {
      if (kind.current === "solo") void leave({ token, roomId: id });
    };
    window.addEventListener("pagehide", leaveIfSolo);
    return () => {
      window.removeEventListener("pagehide", leaveIfSolo);
      leaveIfSolo();
    };
  }, [id, token, join, leave]);

  const m = room?.media;
  useEffect(() => {
    if (room === undefined || room === null) return;
    document.title = !m
      ? "Watch party — Krida"
      : m.episodeTitle
        ? `${m.name} · ${episodeLabel(m.season, m.episode)} — Krida`
        : `${m.name} — Krida`;
    return () => {
      document.title = "Krida";
    };
  }, [m?.videoId, room === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (room === undefined && !joinError)
    return (
      <div className="grid h-dvh place-items-center bg-black">
        <Spinner className="text-fg-faint" />
      </div>
    );
  if (joinError || !room || room.closedAt)
    return (
      <div className="grid h-dvh place-items-center bg-page px-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-subhead font-medium">{joinError ?? "This party has ended"}</p>
          <p className="max-w-[40ch] text-body text-fg-muted">Start a new one from the header, or play something.</p>
          <ButtonLink to="/" className="mt-2">
            Go home
          </ButtonLink>
        </div>
      </div>
    );
  // A party that's still picking is picked from the app itself, with the Party panel open.
  if (room.status === "idle" || !room.media) return <BackToPicking />;
  return <Room room={room} />;
}

function BackToPicking() {
  const [, setPanelOpen] = usePartyPanel();
  useEffect(() => setPanelOpen(true), [setPanelOpen]);
  return <Navigate to="/" replace />;
}

function Room({ room }: { room: RoomData }) {
  const { token, me } = useAuthed();
  const navigate = useNavigate();
  // lastSeenAt is the server's time; a device clock 20 s off would show everyone as away.
  const now = useServerNow(5000);
  const profiles = useRoomPeople(room._id);
  // One side panel at a time, beside the picture: the party, or the show's episodes.
  const [panel, setPanel] = useState<"party" | "episodes" | null>(null);
  const partyOpen = panel === "party";
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const chooseSource = useMutation(api.rooms.chooseSource);
  const retry = useMutation(api.rooms.retry);
  const listSources = useAction(api.sources.listRanked);
  const [refreshing, setRefreshing] = useState(false);
  const [audioLanguage, setAudioLanguage] = useState<string | undefined>(me.prefs.audioLang);
  const heartbeat = useMutation(api.rooms.heartbeat);

  useReleaseOrientation();
  // How this device plays the stream; a file it can't play gets the places it does play instead of a player.
  const how = room.stream ? playsIn(room.stream, { app: !!desktopApp(), native: nativePlayer(), canPlay: browserCanPlay }) : undefined;
  const ready = room.status === "ready" && !!room.stream;
  const elsewhere = ready && how?.mode === "elsewhere";
  // Always sideways on a phone: turned for real where the browser can (Play asked already; a first press here asks
  // again, for a party joined from a link), and otherwise the room turns itself on the upright screen. The Android
  // app turns the phone itself. A file that plays elsewhere is a page to read, so it stays upright.
  const sideways = useSideways(!elsewhere);
  useAndroidWatching();
  useEffect(() => {
    document.documentElement.dataset.player = "";
    return () => {
      delete document.documentElement.dataset.player;
    };
  }, []);

  usePlayTiming(room);
  const online = room.members.filter((m) => m.isMe || now - m.lastSeenAt < ONLINE_MS);
  const arrival = useJoinMoments(room.members);
  useEventToasts(room, partyOpen);
  useReactionSounds(room._id);

  // A stream that took a while to start gets a cue: you may have looked away while it prepared.
  const preparingSince = useRef<number | null>(null);
  useEffect(() => {
    if (room.status === "preparing") preparingSince.current ??= Date.now();
    else if (room.status === "ready" && preparingSince.current !== null) {
      if (Date.now() - preparingSince.current > 2500) playReady();
      preparingSince.current = null;
    } else preparingSince.current = null;
  }, [room.status]);

  // Outside the player (preparing, an error, playing elsewhere) we're still here and watching the screen.
  const playing = ready && !elsewhere;
  useEffect(() => {
    if (playing) return;
    const beat = () => void heartbeat({ token, roomId: room._id, watching: true, screen: currentScreen() }).catch(() => {});
    beat();
    const id = setInterval(beat, 5000);
    return () => clearInterval(id);
  }, [playing, heartbeat, token, room._id]);

  const media = room.media!;
  const refreshSources = async () => {
    setRefreshing(true);
    try {
      await listSources({ token, type: media.type, videoId: media.videoId, refresh: true, screen: currentScreen() });
      await retry({ token, roomId: room._id });
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't refresh sources. Try again."));
    } finally {
      setRefreshing(false);
    }
  };
  const { upNext, stoppedNext } = useUpNext(room);
  const exit = () => (canGoBack() ? navigate(-1) : navigate("/"));
  const pickedBy =
    room.requestedBy && room.requestedBy !== me._id
      ? profiles?.find((p) => p._id === room.requestedBy)?.name
      : undefined;
  const togglePanel = () => setPanel((p) => (p === "party" ? null : "party"));
  const episodesOpen = panel === "episodes" && media.type === "series";

  // In the player it sits in the controls' glass; while preparing it floats on its own. The panel opens from it.
  const partyButton = (tone: "glass" | "capsule") => (
    <span data-panel-anchor="party" className="flex">
      <PartyButton room={room} online={online} active={partyOpen} onClick={togglePanel} tone={tone} />
    </span>
  );

  return (
    <div
      onPointerDownCapture={elsewhere ? undefined : enterPlayerLandscape}
      className={cx(
        "fixed overflow-hidden text-fg",
        // In the apps, mpv's or ExoPlayer's picture is under the page: the room is see-through while it plays.
        !(playing && (how?.mode === "mpv" || how?.mode === "native")) && "bg-black",
        // A quarter turn clockwise about the top left, moved back on screen: the frame is the phone's length wide.
        sideways ? "top-0 left-full h-[100vw] w-[100dvh] origin-top-left rotate-90" : "inset-0",
      )}
    >
      {playing ? (
        <Player
          key={room.stream!._id}
          room={room}
          online={online}
          panelOpen={partyOpen || episodesOpen}
          partyButton={partyButton("capsule")}
          episodesOpen={episodesOpen}
          onEpisodes={() => setPanel((p) => (p === "episodes" ? null : "episodes"))}
          onClosePanel={() => setPanel(null)}
          upNext={upNext}
          stoppedNext={stoppedNext}
          onExit={exit}
          onSources={() => setSourcesOpen(true)}
          onOpenParty={() => setPanel("party")}
          audioLanguage={audioLanguage}
          onAudioLanguage={setAudioLanguage}
          mode={how!.mode as "hls" | "mpv" | "file" | "native"}
        />
      ) : ready && how?.why ? (
        <PlayElsewhere
          room={room}
          why={how.why}
          onSources={() => setSourcesOpen(true)}
          topBar={
            <div className="flex items-center gap-3 p-4 stage:p-6">
              <IconButton label="Back" tone="glass" onClick={exit}>
                <ArrowLeftIcon />
              </IconButton>
            </div>
          }
        />
      ) : (
        <Preparing
          room={room}
          pickedBy={pickedBy}
          onRetry={() => void refreshSources()}
          refreshing={refreshing}
          onFallback={() => {
            if (room.sourceFallback) void chooseSource({ token, roomId: room._id, index: room.sourceFallback.index, key: room.sourceFallback.key });
          }}
          onSources={() => setSourcesOpen(true)}
          topBar={
            <div className="flex items-center gap-3 p-4 stage:p-6">
              <IconButton label="Back" tone="glass" onClick={exit}>
                <ArrowLeftIcon />
              </IconButton>
              <div className="ml-auto flex items-center gap-2">{partyButton("glass")}</div>
            </div>
          }
        />
      )}

      {/* One leaves before the other arrives, so two panes of glass never stack over the picture. */}
      <AnimatePresence mode="wait">
        {partyOpen && <PartyPanel key="party" room={room} online={online} upNext={upNext} onClose={() => setPanel(null)} />}
        {episodesOpen && <EpisodesPanel key="episodes" room={room} online={online} onClose={() => setPanel(null)} />}
      </AnimatePresence>

      <SwitchPrompt room={room} panelOpen={partyOpen || episodesOpen} />

      <SourcesSheet
        media={sourcesOpen ? (media as Media) : null}
        currentIndex={ready ? room.sourceIndex : undefined}
        currentKey={ready ? room.sourceKey : undefined}
        onClose={() => setSourcesOpen(false)}
        onPick={(index, key) => {
          setSourcesOpen(false);
          void chooseSource({ token, roomId: room._id, index, key });
        }}
      />

      <ArrivalBanner name={arrival} className="absolute top-4" />
      <span className="sr-only" aria-live="polite">
        {room.status === "preparing" ? room.step : arrival ? `${arrival} joined` : ""}
      </span>
    </div>
  );
}
