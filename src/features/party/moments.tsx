import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "../../ui/toast";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { playJoin } from "../../ui/sound";
import { cx } from "../../ui/ui";
import { serverNow, useRoomPeople, type Member, type RoomData } from "./shared";
import { arrivals } from "./presence";

/**
 * Someone landing in your party is the rare moment that earns a sound and a little ceremony. It reads the
 * room's members, not who's online: a friend whose phone was locked for a minute hasn't just arrived.
 */
export function useJoinMoments(members: Member[]) {
  const seen = useRef<Set<string> | null>(null);
  const [arrival, setArrival] = useState<string | null>(null);
  useEffect(() => {
    for (const name of arrivals(seen.current, members)) {
      setArrival(name);
      playJoin();
    }
    seen.current = new Set(members.map((m) => m._id as string));
  }, [members]);
  useEffect(() => {
    if (!arrival) return;
    const t = setTimeout(() => setArrival(null), 4000);
    return () => clearTimeout(t);
  }, [arrival]);
  return arrival;
}

/** "Friend joined · you're watching together", for a few seconds at the top of the screen. */
export function ArrivalBanner({ name, className }: { name: string | null; className?: string }) {
  return (
    <AnimatePresence>
      {name && (
        <motion.div
          key={name}
          initial={{ opacity: 0, y: -8, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.3, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.15, ease: "easeIn" } }}
          // A long name gives way before the moment does.
          className={cx(
            "pointer-events-none left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-full glass px-4 py-2 text-body whitespace-nowrap",
            className,
          )}
        >
          <span className="min-w-0 truncate font-medium">{name}</span>
          <span className="shrink-0 font-medium">&nbsp;joined</span>
          <span className="shrink-0 text-fg-muted">&nbsp;· you’re watching together</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Things other people do that you might not be looking at (suggesting, lining something up,
 * leaving) get a short toast, unless the Party panel is open and already shows them. Switching
 * titles needs none: the whole screen changes.
 */
export function useEventToasts(room: RoomData, panelOpen: boolean) {
  const { token, me } = useAuthed();
  const messages = useQuery(api.messages.list, { token, roomId: room._id });
  const profiles = useRoomPeople(room._id);
  // On the server's clock, as createdAt is: on a slow device clock, what happened before would replay.
  const since = useRef(serverNow());
  const shown = useRef(new Set<string>());
  useEffect(() => {
    for (const m of messages ?? []) {
      if (m.kind !== "event" || m.profileId === me._id || m.createdAt < since.current || shown.current.has(m._id)) continue;
      shown.current.add(m._id);
      if (panelOpen || !/^(suggested|is in for|lined up|left|went back)/.test(m.body)) continue;
      const name = profiles?.find((p) => p._id === m.profileId)?.name ?? "Someone";
      toast(`${name} ${m.body}`);
    }
  }, [messages, profiles, me._id, panelOpen]);
}
