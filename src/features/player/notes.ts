// What the others are doing, shown over the picture: their pause, play or seek, and their chat while the panel is shut.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../../convex/_generated/api";
import type { Me } from "../../data/session";
import { formatTime } from "../../ui/format";
import { serverNow, useChatOverlayPref, type Member, type RoomData } from "../party";

export type Note = { key: number; who: Member | undefined; text: string };

/** Someone else's pause, play, seek, "stop after this" or "watch credits", as a short note with their name. */
export function useRoomNotes(room: RoomData, me: Me) {
  const m = room.media!;
  const [note, setNote] = useState<Note | null>(null);
  const lastSeq = useRef(room.playback.seq);
  useEffect(() => {
    const p = room.playback;
    if (p.seq === lastSeq.current) return;
    lastSeq.current = p.seq;
    if (!p.by || p.by === me._id) return;
    const text =
      p.action === "pause" ? "paused" : p.action === "play" ? "pressed play" : p.action === "seek" ? `skipped to ${formatTime(p.position)}` : null;
    if (text) setNote({ key: p.seq, who: room.members.find((x) => x._id === p.by), text });
  }, [room.playback.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastStop = useRef(room.stopAfter?.by ?? null);
  useEffect(() => {
    const by = room.stopAfter?.by ?? null;
    const was = lastStop.current;
    lastStop.current = by;
    if (!by || by === was || by === me._id) return;
    setNote({
      key: Date.now(),
      who: room.members.find((x) => x._id === by),
      text: `stopped autoplay after this${m.type === "series" ? " episode" : ""}`,
    });
  }, [room.stopAfter?.by]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastCredits = useRef(room.credits?.by ?? null);
  useEffect(() => {
    const by = room.credits?.by ?? null;
    const was = lastCredits.current;
    lastCredits.current = by;
    if (!by || by === was || by === me._id || room.credits?.videoId !== m.videoId) return;
    setNote({ key: Date.now(), who: room.members.find((x) => x._id === by), text: "is watching the credits" });
  }, [room.credits?.by, room.credits?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(t);
  }, [note]);
  return note;
}

/** The others' latest chat messages since the player opened, for a few seconds each. */
export function useFloatingChat(room: RoomData, me: Me, token: string) {
  const [overlayOn] = useChatOverlayPref();
  const messages = useQuery(api.messages.list, { token, roomId: room._id });
  // createdAt is the server's time. The clock ticks only while a message is up: ticking all the time redrew the whole
  // player twice a second under the film.
  const mountedAt = useRef(serverNow());
  const [now, setNow] = useState(serverNow);
  const floating = (messages ?? [])
    .filter((x) => x.kind === "chat" && x.profileId !== me._id && x.createdAt > mountedAt.current && now - x.createdAt < 6000)
    .slice(-3);
  useEffect(() => {
    if (floating.length === 0) return;
    const id = setInterval(() => setNow(serverNow()), 500);
    return () => clearInterval(id);
  }, [floating.length]);
  useEffect(() => {
    setNow(serverNow());
  }, [messages]);
  return { overlayOn, floating };
}
