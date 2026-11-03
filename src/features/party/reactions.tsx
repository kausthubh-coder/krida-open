// Reactions that float up over the picture for a moment.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { cx } from "../../ui/ui";
import { serverNow, type RoomData } from "./shared";

/** Reactions float up over the picture for a moment, then leave. `className` places and sizes the column. */
export function ReactionLayer({ room, className }: { room: RoomData; className: string }) {
  const { token } = useAuthed();
  const messages = useQuery(api.messages.list, { token, roomId: room._id });
  // createdAt is the server's time: on a device clock a few seconds fast, none would rise.
  const mountedAt = useRef(serverNow());
  const [now, setNow] = useState(serverNow);
  const recent = (messages ?? []).filter(
    (m) => m.kind === "reaction" && m.createdAt > mountedAt.current - 1000 && now - m.createdAt < 2600,
  );
  useEffect(() => {
    if (recent.length === 0) return;
    const id = setInterval(() => setNow(serverNow()), 500);
    return () => clearInterval(id);
  }, [recent.length]);
  useEffect(() => {
    setNow(serverNow());
  }, [messages]);
  return (
    <div className={cx("pointer-events-none absolute", className)}>
      <AnimatePresence>
        {recent.map((r, i) => (
          <motion.span
            key={r._id}
            initial={{ opacity: 0, y: 0, scale: 0.8 }}
            animate={{ opacity: [0, 1, 1, 0], y: -200, scale: 1, transition: { duration: 2.4, ease: "easeOut" } }}
            className="absolute bottom-0 text-[32px]"
            style={{ left: `${(i * 37) % 60}%` }}
          >
            {r.body}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}
