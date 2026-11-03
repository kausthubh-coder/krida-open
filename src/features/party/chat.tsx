// The party's chat and activity timeline, unread counts, and the chat-over-the-picture setting.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { AnimatePresence, motion } from "motion/react";
import {
  CheckIcon,
  DotsThreeIcon,
  EyeIcon,
  HandPalmIcon,
  HandPointingIcon,
  InfoIcon,
  PaperPlaneRightIcon,
  PlayIcon,
  PopcornIcon,
  QueueIcon,
  RepeatIcon,
  SignInIcon,
  SignOutIcon,
  SmileyIcon,
  SquaresFourIcon,
  StopCircleIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { playMessage, playSend } from "../../ui/sound";
import { Avatar, cx, IconButton } from "../../ui/ui";
import { serverNow, useRoomPeople, type RoomData } from "./shared";
import { buildTimeline, timeLabel, type Activity, type ActivityKind, type TimelineItem } from "./timeline";
import { ReactionPicker } from "./soundboard";
import { markSeen, seenAt } from "./unread";

// ---------------------------------------------------------------------------------------------
// Small shared pieces

/**
 * Chat from other people since the panel was last open. Only one caller per screen passes `sound`,
 * so a message blips once however many places show the count.
 */
export function useUnread(roomId: Id<"rooms"> | undefined, open: boolean, sound = false) {
  const { token, me } = useAuthed();
  const messages = useQuery(api.messages.list, roomId ? { token, roomId } : "skip");
  // On the server's clock, as createdAt is: on a slow device clock the dot would stay on.
  const [since, setSince] = useState(() => (roomId ? seenAt(roomId, serverNow()) : 0));
  useEffect(() => {
    if (!roomId) return;
    if (open) markSeen(roomId, serverNow());
    setSince(seenAt(roomId, serverNow()));
  }, [roomId, open, messages]);
  const heard = useRef<number | null>(null);
  useEffect(() => {
    if (!messages || !sound) return;
    const latest = messages.filter((m) => m.kind === "chat" && m.profileId !== me._id).at(-1)?.createdAt ?? 0;
    if (heard.current !== null && latest > heard.current && !open) playMessage();
    heard.current = latest;
  }, [messages, me._id, open, sound]);
  return (messages ?? []).filter((m) => m.kind === "chat" && m.profileId !== me._id && m.createdAt > since).length;
}

/** Chat over the picture is a preference: some people want the picture alone. */
const OVERLAY_KEY = "krida.chatOverlay";

export function useChatOverlayPref() {
  const [on, setOn] = useState(() => localStorage.getItem(OVERLAY_KEY) !== "off");
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === OVERLAY_KEY && setOn(e.newValue !== "off");
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const set = (value: boolean) => {
    localStorage.setItem(OVERLAY_KEY, value ? "on" : "off");
    setOn(value);
  };
  return [on, set] as const;
}

// ---------------------------------------------------------------------------------------------
// Chat

const ACTIVITY_ICONS: Record<ActivityKind, typeof PlayIcon> = {
  start: PopcornIcon,
  join: SignInIcon,
  back: SignInIcon,
  leave: SignOutIcon,
  play: PlayIcon,
  picking: SquaresFourIcon,
  queue: QueueIcon,
  suggest: HandPointingIcon,
  in: CheckIcon,
  holdoff: HandPalmIcon,
  stop: StopCircleIcon,
  autoplay: RepeatIcon,
  keep: EyeIcon,
  other: InfoIcon,
};

/** Long runs of activity show their latest lines; the rest is one tap away. */
const ACTIVITY_SHOWN = 3;

/** One to a few emoji on their own read as a reaction, so they skip the bubble. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|‍|️|\s){1,12}$/u;

/**
 * The conversation, top to bottom: messages grouped by person (yours on the right), and what
 * happened in the party as quiet lines with icons between them.
 */
export function ChatBody({ room }: { room: RoomData }) {
  const { token, me } = useAuthed();
  const messages = useQuery(api.messages.list, { token, roomId: room._id });
  const send = useMutation(api.messages.send);
  const profiles = useRoomPeople(room._id);
  const [text, setText] = useState("");
  const [reacting, setReacting] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const byId = useMemo(() => new Map((profiles ?? []).map((p) => [p._id as string, p])), [profiles]);
  const nameOf = (id: string) => (id === me._id ? "You" : (byId.get(id)?.name ?? "Someone"));

  const items = useMemo(
    () => buildTimeline(messages ?? [], me._id, (id) => byId.get(id)?.name ?? "Someone"),
    [messages, me._id, byId],
  );
  const last = items.at(-1);

  // Follow new messages while you're at the bottom; reading back up stays put until you send.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && (stick.current || (last?.type === "chat" && last.mine))) el.scrollTop = el.scrollHeight;
  }, [items.length, last]);

  const submit = () => {
    if (!text.trim()) return;
    void send({ token, roomId: room._id, kind: "chat", body: text });
    playSend();
    setText("");
  };

  return (
    <>
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className={cx(
          "flex flex-1 flex-col gap-3 overflow-y-auto overscroll-contain border-t border-line px-4 pt-3 pb-4 scroll-fade-y",
          // The board is tall; on a phone sheet the conversation gives it room while it's open. A short panel in
          // the player (a phone held sideways) keeps room for the box to type in.
          reacting ? "min-h-16" : "min-h-40 group-data-short/panel:min-h-16",
        )}
      >
        {messages && items.length === 0 && (
          <div className="flex flex-col gap-1 py-6 text-center">
            <p className="text-body font-medium text-fg-muted">No messages yet</p>
            <p className="mx-auto max-w-[30ch] text-body text-pretty text-fg-faint">
              Say something, or react with the smiley. Messages stay with this party.
            </p>
          </div>
        )}
        {items.map((item) => (
          <TimelineRow key={item.id} item={item} nameOf={nameOf} hueOf={(id) => byId.get(id)?.hue ?? 60} />
        ))}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3 pt-3 pb-[max(12px,var(--safe-bottom))]">
        <AnimatePresence initial={false}>
          {reacting && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto", transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.12, ease: "easeIn" } }}
              className="overflow-hidden"
            >
              <ReactionPicker onReact={(emoji) => void send({ token, roomId: room._id, kind: "reaction", body: emoji })} />
            </motion.div>
          )}
        </AnimatePresence>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <IconButton
            type="button"
            label={reacting ? "Hide reactions" : "Reactions"}
            aria-pressed={reacting}
            onClick={() => setReacting((r) => !r)}
            className={cx("size-11", reacting ? "lens text-fg" : "text-fg-muted")}
          >
            <SmileyIcon weight={reacting ? "fill" : "regular"} />
          </IconButton>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Message"
            aria-label="Message"
            maxLength={500}
            autoComplete="off"
            enterKeyHint="send"
            className="h-11 min-w-0 flex-1 rounded-full fill-quiet bg-white/8 px-4 text-subhead text-fg outline-none placeholder:text-fg-faint focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-solid"
          />
          {/* Lit only once there's something to send. */}
          <IconButton
            type="submit"
            label="Send"
            className={cx(
              "size-11",
              text.trim() ? "fill-primary bg-accent text-on-accent hover:bg-accent-hover" : "fill-quiet bg-white/8 text-fg-faint hover:bg-white/10",
            )}
          >
            <PaperPlaneRightIcon weight="fill" />
          </IconButton>
        </form>
      </div>
    </>
  );
}

function TimelineRow({
  item,
  nameOf,
  hueOf,
}: {
  item: TimelineItem;
  nameOf: (id: string) => string;
  hueOf: (id: string) => number;
}) {
  if (item.type === "time")
    return <p className="pt-1 text-center text-caption text-fg-faint tabular-nums">{timeLabel(item.at)}</p>;
  if (item.type === "activity") return <ActivityBlock lines={item.lines} nameOf={nameOf} />;

  const name = nameOf(item.profileId);
  const bubbles = item.bubbles.map((b, i) => {
    const emoji = EMOJI_ONLY.test(b.body);
    return (
      <p
        key={b.id}
        title={timeLabel(b.at)}
        className={cx(
          "max-w-full text-body break-words whitespace-pre-wrap text-fg",
          emoji ? "px-1 text-[28px] leading-9" : "rounded-[16px] px-3 py-1.5",
          !emoji && (item.mine ? "bg-white/16 shadow-[inset_0_1px_0_oklch(1_0_0/0.14)]" : "bg-white/8 shadow-[inset_0_1px_0_oklch(1_0_0/0.06)]"),
          !emoji && i === 0 && (item.mine ? "rounded-tr-[6px]" : "rounded-tl-[6px]"),
        )}
      >
        {b.body}
      </p>
    );
  });
  if (item.mine)
    return (
      <div className="flex flex-col items-end gap-0.5 pl-10">
        {bubbles}
      </div>
    );
  return (
    <div className="flex gap-2 pr-10">
      <Avatar name={name} hue={hueOf(item.profileId)} size={24} />
      <div className="flex min-w-0 flex-col items-start gap-0.5">
        <p className="truncate pl-1 text-caption font-medium text-fg-faint">{name}</p>
        {bubbles}
      </div>
    </div>
  );
}

/** What happened, in the margin of the conversation: an icon where the avatars go, then the line. */
function ActivityBlock({ lines, nameOf }: { lines: Activity[]; nameOf: (id: string) => string }) {
  const [all, setAll] = useState(false);
  // Folding away a single line would cost as much room as showing it.
  const hidden = all || lines.length <= ACTIVITY_SHOWN + 1 ? 0 : lines.length - ACTIVITY_SHOWN;
  return (
    <ul className="flex flex-col gap-1 text-caption text-fg-faint">
      {hidden > 0 && (
        <li>
          <button
            onClick={() => setAll(true)}
            className="-my-1 flex items-center gap-2 rounded-[6px] py-1 pr-2 hover:text-fg-muted"
          >
            <span className="grid w-6 shrink-0 place-items-center">
              <DotsThreeIcon weight="bold" className="text-[14px]" />
            </span>
            {hidden === 1 ? "1 earlier update" : `${hidden} earlier updates`}
          </button>
        </li>
      )}
      {lines.slice(hidden).map((line) => {
        const Icon = ACTIVITY_ICONS[line.kind];
        return (
          <li key={line.id} className="flex gap-2">
            <span className="grid h-4 w-6 shrink-0 place-items-center text-[14px]">
              <Icon weight={line.kind === "play" ? "fill" : "regular"} />
            </span>
            <span className="min-w-0 text-pretty">
              <span className="font-medium text-fg-muted">{nameOf(line.profileId)}</span> {line.before}
              {line.title && <span className="text-fg-muted">{line.title}</span>}
              {line.after}
              {line.alsoIn.map((s) => ` · ${s}`).join("")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
