// Choosing an episode together: the Episodes side panel and its list.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { toast } from "../../ui/toast";
import {
  ArrowLeftIcon,
  PlayIcon,
  QueueIcon,
  XIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { art, episodeTitle, getMeta, useAsync, type Video } from "../../data/cinemeta";
import { timeLeft } from "../../ui/format";
import { errorMessage, mediaFor } from "../play";
import { playAdd } from "../../ui/sound";
import { Art } from "../../ui/artwork";
import { useWheelScrollsX } from "../../ui/wheelScroll";
import { Button, cx, IconButton, Spinner } from "../../ui/ui";
import type { Member, RoomData } from "./shared";
import { HEADER_ICON, SidePanel } from "./panels";

/** The show's episodes beside the picture, from the player's Episodes button, in a party or on your own. */
export function EpisodesPanel({ room, online, onClose }: { room: RoomData; online: Member[]; onClose: () => void }) {
  return (
    <SidePanel label="Episodes" anchor="episodes" onClose={onClose}>
      <EpisodesView room={room} online={online} onClose={onClose} />
    </SidePanel>
  );
}

/**
 * The show's episodes, inside the panel: play one now (picking up where you left it), or line it up for after
 * this. Opening an episode is intent enough to get its stream ready.
 */
export function EpisodesView({
  room,
  online,
  onBack,
  onClose,
}: {
  room: RoomData;
  online: Member[];
  /** Reached from the Party panel, it goes back to the chat; from the player's own button it only closes. */
  onBack?: () => void;
  onClose: () => void;
}) {
  const { token, me } = useAuthed();
  // Unwatched episodes keep their stills blurred and their descriptions hidden (Settings → Home).
  const blurUnwatched = !!me.prefs.blurUnwatched;
  const media = room.media!;
  const meta = useAsync(`meta:series:${media.imdbId}`, () => getMeta("series", media.imdbId));
  const progress = useQuery(api.progress.forTitle, { token, imdbId: media.imdbId });
  const requestSwitch = useMutation(api.rooms.requestSwitch);
  const setNext = useMutation(api.rooms.setNext);
  const warm = useMutation(api.rooms.warm);
  const seasons = useMemo(() => {
    const list = [...new Set((meta.data?.videos ?? []).map((v) => v.season))].sort((a, b) => a - b);
    return [...list.filter((s) => s > 0), ...list.filter((s) => s === 0)];
  }, [meta.data?.videos]);
  const [season, setSeason] = useState(media.season ?? 1);
  const [open, setOpen] = useState<string | null>(null);
  const byVideo = useMemo(() => new Map((progress ?? []).map((p) => [p.videoId, p])), [progress]);
  const episodes = (meta.data?.videos ?? []).filter((v) => v.season === season);
  const someoneElseWatching = online.some((m) => !m.isMe && m.watching);
  const current = useRef<HTMLLIElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  useWheelScrollsX(tabs, seasons.length > 1);
  // Opened from the keyboard, focus goes in: to the episode after this one, or the first that can be picked.
  const byKeyboard = useRef(!!document.activeElement?.matches(":focus-visible"));
  useEffect(() => {
    if (!meta.data) return;
    current.current?.scrollIntoView({ block: "center" });
    tabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!byKeyboard.current) return;
    byKeyboard.current = false;
    const after = current.current?.nextElementSibling?.querySelector<HTMLButtonElement>("button:enabled");
    (after ?? list.current?.querySelector<HTMLButtonElement>("button:enabled"))?.focus({ preventScroll: true });
  }, [meta.data]);
  const warmed = useRef(new Set<string>());

  const playNow = async (v: Video) => {
    const row = byVideo.get(v.id);
    const result = await requestSwitch({
      token,
      roomId: room._id,
      media: mediaFor(meta.data!, v),
      startAt: row && !row.finished && row.position > 5 ? row.position : undefined,
    }).catch((e) => {
      toast.error(errorMessage(e, "Couldn't switch to that"));
      return null;
    });
    // Played, it's getting ready behind the panel; asked, the prompt waits for the others.
    if (result) onClose();
  };

  return (
    <>
      <div className={cx("flex h-16 shrink-0 items-center gap-1 pr-2", onBack ? "pl-2" : "pl-4")}>
        {onBack && (
          <IconButton label="Back to chat" size="sm" className={HEADER_ICON} onClick={onBack}>
            <ArrowLeftIcon />
          </IconButton>
        )}
        <h2 className="flex-1 text-title font-semibold">Episodes</h2>
        <IconButton label="Close" size="sm" className={cx(HEADER_ICON, "bg-white/8")} onClick={onClose}>
          <XIcon />
        </IconButton>
      </div>
      {seasons.length > 1 && (
        <div ref={tabs} role="tablist" aria-label="Seasons" className="flex shrink-0 gap-1 overflow-x-auto px-4 pb-3 scrollbar-none scroll-fade-x">
          {seasons.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={s === season}
              onClick={() => {
                setSeason(s);
                setOpen(null);
              }}
              className={cx(
                "press h-9 shrink-0 rounded-full px-3.5 text-body font-medium pointer-coarse:h-11",
                s === season ? "lens text-fg" : "text-fg-muted hover:bg-white/8 hover:text-fg",
              )}
            >
              {s === 0 ? "Specials" : `Season ${s}`}
            </button>
          ))}
        </div>
      )}
      {!meta.data && (
        <p className="flex items-center gap-2 px-4 py-2 text-body text-fg-faint">
          {meta.error ? (
            "Couldn’t load the episodes. Close this and try again."
          ) : (
            <>
              <Spinner className="size-3.5" /> Loading episodes…
            </>
          )}
        </p>
      )}
      <ol ref={list} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-2 pb-4 scroll-fade-y">
        {episodes.map((v) => {
          const row = byVideo.get(v.id);
          const isCurrent = v.id === media.videoId;
          const isNext = v.id === room.next?.media.videoId;
          const upcoming = v.released ? new Date(v.released).getTime() > Date.now() : false;
          const expanded = open === v.id && !isCurrent;
          return (
            <li
              key={v.id}
              ref={isCurrent ? current : undefined}
              // Anime seasons can run to a thousand episodes: rows out of view skip layout and paint.
              className={cx(
                "rounded-card [contain-intrinsic-size:auto_70px] [content-visibility:auto]",
                (isCurrent || expanded) && "bg-white/6",
                isCurrent && "lens episode-now",
              )}
            >
              <button
                disabled={upcoming || isCurrent}
                onClick={() => {
                  setOpen(expanded ? null : v.id);
                  if (expanded || warmed.current.has(v.id)) return;
                  warmed.current.add(v.id);
                  void warm({ token, media: mediaFor(meta.data!, v), roomId: room._id }).catch(() => {});
                }}
                aria-expanded={expanded}
                className={cx(
                  "flex w-full items-center gap-3 rounded-card p-2 text-left",
                  !expanded && "enabled:hover:bg-white/5",
                  row?.finished && !isCurrent && "opacity-55",
                )}
              >
                <Art
                  src={v.thumbnail ?? art.background(media.imdbId)}
                  alt=""
                  className={cx("aspect-video w-24 shrink-0 rounded-[6px] img-outline", blurUnwatched && !row && !isCurrent && "spoiler overflow-hidden")}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">
                    <span className="text-fg-faint tabular-nums">{v.episode}.</span> {episodeTitle(v)}
                  </span>
                  <span className={cx("block truncate text-caption", isCurrent || isNext ? "text-accent" : "text-fg-faint")}>
                    {isCurrent
                      ? "Watching now"
                      : isNext
                        ? "Lined up for after this"
                        : upcoming
                          ? "Not out yet"
                          : row?.finished
                            ? "Watched"
                            : row
                              ? timeLeft(row.position, row.duration)
                              : blurUnwatched
                                ? ""
                                : (v.overview ?? "")}
                  </span>
                </span>
              </button>
              {expanded && (
                <div className="flex flex-wrap gap-2 px-2 pb-2">
                  <Button variant="primary" className="h-9 px-3.5" icon={<PlayIcon weight="fill" />} onClick={() => void playNow(v)}>
                    {someoneElseWatching ? "Ask to play now" : "Play now"}
                  </Button>
                  {!isNext && (
                    <Button
                      className="h-9 px-3.5"
                      icon={<QueueIcon />}
                      onClick={() => {
                        playAdd();
                        void setNext({ token, roomId: room._id, media: mediaFor(meta.data!, v) });
                        setOpen(null);
                      }}
                    >
                      Play after this
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
