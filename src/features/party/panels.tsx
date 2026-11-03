import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Pane } from "../../ui/bubbles";
import { motion } from "motion/react";
import {
  PopcornIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { getMeta, nextEpisode, useAsync } from "../../data/cinemeta";
import { mediaFor, type Media } from "../play";
import { offsetIn } from "../../ui/anchor";
import { Avatar, cx, IconButton } from "../../ui/ui";
import type { Member, RoomData } from "./shared";
import { presenceLine, type Presence } from "./presence";
import { ChatBody, useUnread } from "./chat";
import { CopyLinkButton, PartyMenu } from "./partyMenu";
import { EpisodesView } from "./episodes";
import { Invites } from "./invitePanel";
import { NextRow } from "./lobby";

/** Header buttons: 32px for a mouse, 44px under a finger. */
export const HEADER_ICON = "text-fg-muted pointer-coarse:size-11";

// ---------------------------------------------------------------------------------------------
// The Party button

/**
 * Who's here, in one button, with a dot when there's chat you haven't read. In the player's controls it's an
 * icon in the capsule's glass, not glass of its own.
 */
export function PartyButton({
  room,
  online,
  active,
  onClick,
  tone = "glass",
  className,
}: {
  room: RoomData;
  online: Member[];
  active: boolean;
  onClick: () => void;
  tone?: "glass" | "capsule";
  className?: string;
}) {
  const unread = useUnread(room._id, active, true);
  const label = unread ? `Party, ${unread} new message${unread === 1 ? "" : "s"}` : "Party";
  const dot = unread > 0 && <span className="absolute top-1 right-1 size-2.5 rounded-full bg-accent ring-2 ring-black/60" />;
  if (tone === "capsule")
    return (
      <IconButton
        label={label}
        aria-pressed={active}
        onClick={onClick}
        className={cx("relative size-11", active ? "lens" : "hover:bg-white/14", className)}
      >
        <PopcornIcon weight={active ? "fill" : "regular"} />
        {dot}
      </IconButton>
    );
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cx("press glass relative flex h-10 items-center gap-2 rounded-full pr-4 pl-1.5", active ? "bg-white/20!" : "hover:bg-white/14!", className)}
    >
      <span className="flex -space-x-2">
        {online.slice(0, 3).map((m) => (
          <Avatar key={m._id} name={m.name} hue={m.hue} size={28} ring className="ring-black/60" />
        ))}
      </span>
      <span className="text-body font-medium">Party</span>
      {unread > 0 && <span className="absolute -top-0.5 -right-0.5 size-3 rounded-full bg-accent ring-2 ring-black" />}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Panels

/** The gap between a panel and its button, and between a panel and the frame's edges. */
const GAP = 12;
/** Tall enough for the chat, short of the whole height: the picture still shows above it. */
const PANEL_MAX = { width: 372, height: 520 };
/** Shorter than this (a phone held sideways), the panel's top gives the chat more of it (PanelTop). */
const SHORT_PANEL = 380;
/**
 * A frame this short is a phone held sideways, where the picture fills the width: the panel goes to the edge and
 * narrows, so it covers a side of the picture rather than its middle.
 */
const SIDEWAYS_FRAME = 500;
const SIDEWAYS_WIDTH = 300;

/**
 * Places a panel at the button that opened it (`data-panel-anchor`): above it when the button sits low, as in the
 * player's controls, below it when high, as in the top bar. Its right edge lines up with the button's group
 * (`data-panel-edge`), or on a phone held sideways the frame's edge, and it grows from the button. The first
 * rendered button wins, so Episodes falls back to More.
 */
function useAnchoredPlace(anchor: string, ref: React.RefObject<HTMLElement | null>) {
  const [place, setPlace] = useState<{ style: CSSProperties; short: boolean } | null>(null);
  useLayoutEffect(() => {
    const panel = ref.current;
    const frame = panel?.offsetParent as HTMLElement | null;
    if (!panel || !frame) return;
    const measure = () => {
      const button = [...frame.querySelectorAll<HTMLElement>(`[data-panel-anchor~="${anchor}"]`)].find((el) => el.offsetWidth > 0);
      if (!button) return;
      const W = frame.clientWidth;
      const H = frame.clientHeight;
      const b = offsetIn(button, frame);
      const edge = offsetIn((button.closest("[data-panel-edge]") as HTMLElement | null) ?? button, frame);
      const sideways = H < SIDEWAYS_FRAME;
      const width = Math.min(sideways ? SIDEWAYS_WIDTH : PANEL_MAX.width, W - 2 * GAP);
      const right = sideways ? GAP : Math.min(Math.max(W - (edge.x + edge.w), GAP), W - width - GAP);
      const left = W - right - width;
      const centre = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const above = centre.y > H / 2;
      const room = above ? b.y - 2 * GAP : H - b.y - b.h - 2 * GAP;
      setPlace({
        short: Math.min(PANEL_MAX.height, room) < SHORT_PANEL,
        style: above
          ? {
              right,
              width,
              bottom: H - b.y + GAP,
              height: `min(${PANEL_MAX.height}px, calc(${b.y - 2 * GAP}px - var(--safe-top)))`,
              transformOrigin: `${centre.x - left}px calc(100% + ${centre.y - (b.y - GAP)}px)`,
            }
          : {
              right,
              width,
              top: b.y + b.h + GAP,
              height: `min(${PANEL_MAX.height}px, calc(${H - b.y - b.h - 2 * GAP}px - var(--safe-bottom)))`,
              transformOrigin: `${centre.x - left}px ${centre.y - (b.y + b.h + GAP)}px`,
            },
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [anchor, ref]);
  return place;
}

/**
 * Party and Episodes, over the picture: a pane of glass that grows out of its button and leaves the controls where
 * they are. Closed with its own button, Escape, or its button again.
 */
export function SidePanel({ label, anchor, onClose, children }: { label: string; anchor: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog on top handles its own Escape.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Closed, focus goes back to the button that opened it, unless it has already moved on.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    return () => {
      const at = document.activeElement;
      if ((!at || at === document.body || panel?.contains(at)) && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const place = useAnchoredPlace(anchor, ref);
  return (
    <motion.aside
      ref={ref}
      aria-label={label}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1, transition: { type: "spring", stiffness: 380, damping: 30 } }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12, ease: "easeIn" } }}
      // Unplaced for the one frame before it's measured.
      style={place?.style ?? { visibility: "hidden" }}
      data-short={place?.short || undefined}
      className="group/panel absolute z-20 flex flex-col"
    >
      <Pane family="menu">{children}</Pane>
    </motion.aside>
  );
}

export type UpNext =
  | { kind: "next"; media: Media; addedBy: Id<"profiles"> }
  | { kind: "episode"; media: Media; thumbnail?: string }
  | { kind: "stopped"; by: Id<"profiles"> }
  | { kind: "none" };

/**
 * What comes after this: whatever someone lined up, then the next episode, unless someone said stop.
 * `stoppedNext` is what would have played, for the end card's "Play it anyway".
 */
export function useUpNext(room: RoomData) {
  const media = room.media;
  const series = useAsync(media?.type === "series" ? `meta:series:${media.imdbId}` : null, () =>
    getMeta("series", media!.imdbId),
  );
  const nextEp = series.data && media ? nextEpisode(series.data, media.videoId) : undefined;
  const autoNext = series.data && nextEp ? mediaFor(series.data, nextEp) : undefined;
  const stopped = !!media && room.stopAfter?.videoId === media.videoId;
  const upNext: UpNext = !media
    ? { kind: "none" }
    : stopped
      ? { kind: "stopped", by: room.stopAfter!.by }
      : room.next
        ? { kind: "next", media: room.next.media as Media, addedBy: room.next.addedBy }
        : autoNext
          ? { kind: "episode", media: autoNext, thumbnail: nextEp?.thumbnail }
          : { kind: "none" };
  const stoppedNext = stopped ? ((room.next?.media as Media | undefined) ?? autoNext) : undefined;
  return { upNext, stoppedNext };
}

/** Each member and what they're doing right now. */
function usePresence(room: RoomData, online: Member[]): (Presence & { hue: number })[] {
  const onlineById = new Map(online.map((m) => [m._id as string, m]));
  return room.members.map((m) => {
    const here = onlineById.get(m._id);
    const status = !here
      ? "away"
      : here.buffering
        ? "buffering"
        : here.watching
          ? room.status === "idle"
            ? "here"
            : "watching"
          : "browsing";
    return { id: m._id, name: m.name, hue: m.hue, isMe: m.isMe, status };
  });
}

/**
 * "Party", the people in it and what they're doing, then the link, the rarely used options and a
 * way to close. The title row is as tall as the top nav, so the two read as one bar.
 */
export function PartyHeader({
  room,
  online,
  inPlayer,
  onClose,
}: {
  room: RoomData;
  online: Member[];
  inPlayer?: boolean;
  onClose: () => void;
}) {
  const people = usePresence(room, online);
  const line = presenceLine(people);
  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-4">
      <div className="-mr-2 flex h-10 items-center gap-1">
        <h2 className="min-w-0 flex-1 text-title font-semibold">Party</h2>
        <CopyLinkButton roomId={room._id} />
        <PartyMenu room={room} inPlayer={inPlayer} />
        <IconButton label="Close" size="sm" className={cx(HEADER_ICON, "bg-white/8")} onClick={onClose}>
          <XIcon />
        </IconButton>
      </div>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex shrink-0 -space-x-1.5">
          {people.slice(0, 4).map((p) => (
            <span key={p.id} className={cx("relative", p.status === "away" && "opacity-50")}>
              <Avatar name={p.name} hue={p.hue} size={24} className="ring-2 ring-surface" />
              {p.status !== "away" && (
                <span
                  aria-hidden
                  className={cx(
                    "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface",
                    p.status === "browsing" ? "bg-fg-faint" : "bg-success",
                  )}
                />
              )}
            </span>
          ))}
        </span>
        <p className="min-w-0 flex-1 truncate text-body text-fg-muted" title={line}>
          {line}
        </p>
      </div>
    </div>
  );
}

/**
 * The top of the panel: invites, then what's on the table or what's playing and next. It scrolls on
 * its own past half the panel (a quarter in a short one), so the conversation always keeps room.
 */
export function PanelTop({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-h-[50%] min-h-0 shrink-0 flex-col gap-4 overflow-y-auto overscroll-contain px-2 pb-4 group-data-short/panel:max-h-[25%] group-data-short/panel:pb-2">
      {children}
    </div>
  );
}

/**
 * The party inside the player: who isn't here, what comes next, and the conversation. Episodes
 * swaps in over the chat and back.
 */
export function PartyPanel({
  room,
  online,
  upNext,
  onClose,
}: {
  room: RoomData;
  online: Member[];
  upNext: UpNext;
  onClose: () => void;
}) {
  const [view, setView] = useState<"chat" | "episodes">("chat");
  const isSeries = room.media?.type === "series";
  return (
    <SidePanel label="Party" anchor="party" onClose={onClose}>
      {view === "episodes" && room.media ? (
        <EpisodesView room={room} online={online} onBack={() => setView("chat")} onClose={onClose} />
      ) : (
        <>
          <PartyHeader room={room} online={online} inPlayer onClose={onClose} />
          <PanelTop>
            <Invites room={room} />
            {room.media && <NextRow room={room} upNext={upNext} onEpisodes={isSeries ? () => setView("episodes") : undefined} />}
          </PanelTop>
          <ChatBody room={room} />
        </>
      )}
    </SidePanel>
  );
}
