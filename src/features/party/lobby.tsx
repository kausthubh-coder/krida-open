// The lobby in the party panel: what's on, what's suggested and voted on, and what's next.
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { toast } from "../../ui/toast";
import {
  ListNumbersIcon,
  PlayIcon,
  QueueIcon,
  RepeatIcon,
  StopCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { art } from "../../data/cinemeta";
import { episodeLabel, timeLeft } from "../../ui/format";
import type { Media } from "../play";
import { playAdd, playRemove } from "../../ui/sound";
import { Art } from "../../ui/artwork";
import { Button, cx, IconButton } from "../../ui/ui";
import { mediaLabel, useRoomPeople, useServerNow, type Member, type RoomData, type Suggestion } from "./shared";
import { PanelTop, PartyHeader, type UpNext, useUpNext } from "./panels";
import { Invites } from "./invitePanel";
import { ChatBody } from "./chat";
import { ReactionLayer } from "./reactions";
import { names } from "./presence";

/**
 * The party while you browse: who's here, then what's on the table (picking) or what's playing and
 * what's next (watching), then the conversation.
 */
export function BrowsePanel({ room, online, onClose }: { room: RoomData; online: Member[]; onClose: () => void }) {
  const navigate = useNavigate();
  const { upNext } = useUpNext(room);
  const media = room.media;
  return (
    <>
      <PartyHeader room={room} online={online} onClose={onClose} />
      <PanelTop>
        <Invites room={room} />
        {room.status === "idle" || !media ? (
          <Table room={room} online={online} />
        ) : (
          <div className="flex flex-col gap-1">
            <NowRow room={room} media={media as Media} />
            <NextRow
              room={room}
              upNext={upNext}
              onEpisodes={media.type === "series" ? () => navigate(`/title/series/${media.imdbId}`) : undefined}
            />
          </div>
        )}
      </PanelTop>
      <ChatBody room={room} />
      {/* Out here there's no picture to float over, so reactions rise over the panel instead. */}
      <ReactionLayer room={room} className="right-6 bottom-24 h-48 w-20" />
    </>
  );
}

/** What the party is watching right now; the whole row is the way back to it. */
function NowRow({ room, media }: { room: RoomData; media: Media }) {
  const navigate = useNavigate();
  const now = useServerNow(1000);
  const p = room.playback;
  const position = p.playing ? p.position + (now - p.anchorAt) / 1000 : p.position;
  const duration = room.stream?.duration;
  const failed = room.status === "error";
  const ready = room.status === "ready";
  const state = failed ? "Couldn’t start" : !ready ? "Getting it ready" : p.playing ? "Playing" : "Paused";
  const detail = failed ? room.error : !ready ? room.step : duration ? timeLeft(position, duration) : undefined;
  return (
    <button
      onClick={() => navigate(`/watch/${room._id}`)}
      aria-label={`Back to the player · ${mediaLabel(media)}`}
      className="press-soft group flex w-full items-center gap-3 rounded-card p-2 text-left hover:bg-white/5"
    >
      <Thumb media={media} />
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate text-caption tabular-nums", failed ? "text-danger" : "text-fg-faint")}>
          {state}
          {detail && ` · ${detail}`}
        </span>
        <span className="block truncate text-body font-medium" title={mediaLabel(media)}>
          {mediaLabel(media)}
        </span>
      </span>
      <span
        aria-hidden
        title="Back to the player"
        className="grid size-10 shrink-0 place-items-center rounded-full fill-primary bg-accent text-[18px] text-on-accent group-hover:bg-accent-hover"
      >
        <PlayIcon weight="fill" />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// The table: what's been suggested while picking

/** A small label over a group of rows, on the same edge as the text below it. */
function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="flex items-baseline gap-1.5 px-2 pb-1 text-caption font-medium text-fg-faint">{children}</h3>;
}

/** What's been suggested, who's in for each, and the countdown when everyone is. */
function Table({ room, online }: { room: RoomData; online: Member[] }) {
  const here = online.filter((m) => m.watching || m.isMe);
  const list = room.suggestions;
  return (
    <section className="flex flex-col">
      <SectionLabel>
        On the table
        {list.length > 0 && <span className="tabular-nums">{list.length}</span>}
      </SectionLabel>
      {list.length === 0 ? (
        <p className="px-2 text-body text-pretty text-fg-muted">
          {here.length > 1
            ? "Nothing yet. Press Suggest on any title. It starts when you’re all in."
            : "Nothing yet. Suggest something for when they get here, or press Play to start now."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {list.map((item, i) => (
            <SuggestionRow key={item.id} room={room} item={item} index={i} here={here} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionRow({ room, item, index, here }: { room: RoomData; item: Suggestion; index: number; here: Member[] }) {
  const { token, me } = useAuthed();
  const profiles = useRoomPeople(room._id);
  const vote = useMutation(api.rooms.vote);
  const play = useMutation(api.rooms.playSuggestion);
  const cancel = useMutation(api.rooms.cancelStart);
  const remove = useMutation(api.rooms.removeSuggestion);
  const restore = useMutation(api.rooms.restoreSuggestion);
  const now = useServerNow(250);
  const name = (id: string) => profiles?.find((p) => p._id === id)?.name ?? "Someone";

  const m = item.media;
  const starting = room.starting?.suggestionId === item.id ? room.starting : undefined;
  const countdown = starting ? Math.max(1, Math.ceil((starting.at - now) / 1000)) : 0;
  const someoneElseStarting = !!room.starting && !starting;
  const iAmIn = item.inIds.includes(me._id);
  const waitingOn = here.filter((p) => !item.inIds.includes(p._id));
  const alone = here.length < 2;
  const by = item.by === me._id ? "You suggested" : `${name(item.by)} suggested`;

  const status = starting
    ? `Starting in ${countdown}`
    : alone
      ? by
      : iAmIn
        ? waitingOn.length
          ? `You’re in · waiting for ${names(waitingOn.map((p) => p.name))}`
          : "Everyone’s in"
        : `${by} · waiting for you`;

  return (
    <li
      className={cx(
        "group flex items-center gap-2 rounded-card p-2",
        starting ? "bg-accent/10 ring-[1.5px] ring-accent ring-inset" : "hover:bg-white/5",
      )}
    >
      <Link
        to={`/title/${m.type}/${m.imdbId}`}
        aria-label={`Open ${m.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-[6px] outline-offset-2"
      >
        <Thumb media={m} compact />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium" title={mediaLabel(m)}>
            {mediaLabel(m)}
          </span>
          <span
            // Two lines rather than a cut: "waiting for …" is the part that says what to do.
            className={cx("line-clamp-2 text-caption tabular-nums", starting ? "font-semibold text-accent" : "text-fg-faint")}
            aria-live={starting ? "polite" : undefined}
          >
            {status}
          </span>
        </span>
      </Link>
      {starting ? (
        <Button variant="ghost" className="h-8 shrink-0 px-3" onClick={() => void cancel({ token, roomId: room._id })}>
          Cancel
        </Button>
      ) : alone || iAmIn ? (
        // Round, like the way back to the player: the title and who's waiting keep the row's width.
        <IconButton
          label={`Play ${m.name} now`}
          size="sm"
          className={cx(
            "size-9 shrink-0 text-[16px] pointer-coarse:size-11",
            alone && !someoneElseStarting ? "fill-primary bg-accent text-on-accent hover:bg-accent-hover!" : "fill-raised bg-white/10 hover:bg-white/15!",
          )}
          onClick={() => void play({ token, roomId: room._id, suggestionId: item.id })}
        >
          <PlayIcon weight="fill" />
        </IconButton>
      ) : (
        <Button
          variant={someoneElseStarting ? "secondary" : "primary"}
          className="h-8 shrink-0 px-3"
          onClick={() => {
            playAdd();
            void vote({ token, roomId: room._id, suggestionId: item.id, in: true });
          }}
        >
          I’m in
        </Button>
      )}
      {!starting && (
        <IconButton
          label={`Take ${m.name} off the table`}
          size="sm"
          // A 32px button with a 44px target under a finger, so the title keeps its room on phones.
          className="relative -mr-1 shrink-0 text-fg-faint pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
          onClick={async () => {
            await remove({ token, roomId: room._id, suggestionId: item.id });
            playRemove();
            toast(`Took ${m.name} off the table`, {
              duration: 5000,
              action: { label: "Undo", onClick: () => void restore({ token, roomId: room._id, item, index }) },
            });
          }}
        >
          <XIcon />
        </IconButton>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// What comes next

export function NextRow({ room, upNext, onEpisodes }: { room: RoomData; upNext: UpNext; onEpisodes?: () => void }) {
  const { token, me } = useAuthed();
  const profiles = useRoomPeople(room._id);
  const setStopAfter = useMutation(api.rooms.setStopAfter);
  const clearNext = useMutation(api.rooms.clearNext);
  // Always mid-sentence: "lined up by you", "you turned this on".
  const name = (id: string) => (id === me._id ? "you" : (profiles?.find((p) => p._id === id)?.name ?? "Someone"));
  const isSeries = room.media?.type === "series";
  // Quiet actions: what's next leads, these only adjust it.
  const episodes = onEpisodes && (
    <Button variant="ghost" className="h-8 px-3" icon={<ListNumbersIcon />} onClick={onEpisodes}>
      Episodes
    </Button>
  );

  let head: ReactNode;
  let actions: ReactNode;
  if (upNext.kind === "stopped") {
    head = (
      <>
        <Thumb media={room.media as Media} dim />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption text-fg-faint">Autoplay off · {name(upNext.by)} turned this on</span>
          <span className="block truncate text-body font-medium">Stopping after this{isSeries ? " episode" : ""}</span>
        </span>
      </>
    );
    actions = (
      <Button
        className="h-8 px-3"
        icon={<RepeatIcon />}
        onClick={() => void setStopAfter({ token, roomId: room._id, on: false, videoId: room.media!.videoId })}
      >
        Keep going
      </Button>
    );
  } else if (upNext.kind === "none") {
    head = (
      <p className="min-w-0 flex-1 text-body text-pretty text-fg-muted">
        Nothing after this. Use <QueueIcon aria-label="Play after this" className="inline align-[-2px]" /> on any title to
        line something up.
      </p>
    );
    actions = episodes;
  } else {
    const label =
      upNext.media.season !== undefined && upNext.media.imdbId === room.media?.imdbId
        ? `${episodeLabel(upNext.media.season, upNext.media.episode)}${upNext.media.episodeTitle ? ` · ${upNext.media.episodeTitle}` : ""}`
        : mediaLabel(upNext.media);
    head = (
      <>
        <Thumb media={upNext.media} thumbnail={upNext.kind === "episode" ? upNext.thumbnail : undefined} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption text-fg-faint">
            {upNext.kind === "next" ? `Up next · lined up by ${name(upNext.addedBy)}` : "Up next · plays automatically"}
          </span>
          <span className="block truncate text-body font-medium" title={mediaLabel(upNext.media)}>
            {label}
          </span>
        </span>
      </>
    );
    actions = (
      <>
        {episodes}
        {upNext.kind === "next" && (
          <Button variant="ghost" className="h-8 px-3" icon={<XIcon />} onClick={() => void clearNext({ token, roomId: room._id })}>
            Remove
          </Button>
        )}
        <Button
          variant="ghost"
          className="h-8 px-3"
          icon={<StopCircleIcon />}
          onClick={() => void setStopAfter({ token, roomId: room._id, on: true, videoId: room.media!.videoId })}
        >
          Stop after this
        </Button>
      </>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-3">{head}</div>
      {actions && <div className="-mx-1 flex flex-wrap gap-1">{actions}</div>}
    </div>
  );
}

/** `compact` rows carry two controls, so on phones their art steps down to leave the title room. */
function Thumb({ media, thumbnail, dim, compact }: { media: Media; thumbnail?: string; dim?: boolean; compact?: boolean }) {
  return (
    <Art
      src={thumbnail ?? media.background ?? art.background(media.imdbId)}
      alt=""
      fallbackTitle={media.name}
      className={cx(
        "aspect-video shrink-0 rounded-[6px] img-outline",
        compact ? "w-16 md:w-20" : "w-20",
        dim && "brightness-50 grayscale",
      )}
    />
  );
}
