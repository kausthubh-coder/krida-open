// Up next: what someone lined up, then the next episode. One decision for the whole room.
import { useCallback, useEffect, useRef, useState } from "react";
import type { useMutation } from "convex/react";
import type { api } from "../../../convex/_generated/api";
import type { Media } from "../play";
import type { RoomData, UpNext } from "../party";

/** Titles in a row that may start on their own before asking whether anyone's still there. */
const STILL_WATCHING_AFTER = 3;
/** Up next's countdown, from the credits (or the end, after watching them). */
export const AUTO_NEXT_SECONDS = 5;

type Mutations = {
  requestSwitch: ReturnType<typeof useMutation<typeof api.rooms.requestSwitch>>;
  advance: ReturnType<typeof useMutation<typeof api.rooms.advance>>;
  warmNext: ReturnType<typeof useMutation<typeof api.rooms.warm>>;
  watchCreditsFor: ReturnType<typeof useMutation<typeof api.rooms.watchCredits>>;
};

export function useUpNextFlow({ room, upNext, time, duration, ended, autoNextOn, save, token, mutations }: {
  room: RoomData;
  upNext: UpNext;
  time: number;
  duration: number;
  ended: boolean;
  autoNextOn: boolean;
  save: (final?: boolean) => void;
  token: string;
  mutations: Mutations;
}) {
  const { requestSwitch, advance, warmNext, watchCreditsFor } = mutations;
  const m = room.media!;
  const stream = room.stream!;
  const nextUp = upNext.kind === "next" || upNext.kind === "episode" ? upNext : undefined;

  // Skipping ahead mid-title is a switch, so it asks anyone else watching first.
  const playNext = useCallback(() => {
    if (!nextUp) return;
    save();
    void requestSwitch({ token, roomId: room._id, media: nextUp.media });
  }, [nextUp, save, requestSwitch, token, room._id]);
  // Warm the next episode a minute in, so moving on later starts at once. (Lined-up titles warm when chosen.)
  // Picking another source changes which copy of it plays, so it's warmed again.
  const warmed = useRef<string | null>(null);
  useEffect(() => {
    const target = upNext.kind === "episode" ? `${upNext.media.videoId}~${room.binge ?? ""}` : null;
    if (upNext.kind !== "episode" || time < 60 || warmed.current === target) return;
    warmed.current = target;
    void warmNext({ token, media: upNext.media, roomId: room._id }).catch(() => {});
  }, [upNext, time, token, warmNext, room._id, room.binge]);

  const remaining = duration - time;
  // Once credits are reached, their last second must not restart the countdown.
  const atCredits = ended || (!!stream.outro && time >= stream.outro.start);
  // After a few titles started on their own, ask before starting another.
  const stillWatching =
    atCredits && !!nextUp && autoNextOn && room.autoStreak >= STILL_WATCHING_AFTER;
  // Watch credits puts Up next away until the end, for everyone. Here at once, before the room says so.
  const [creditsFor, setCreditsFor] = useState<string | null>(null);
  const watchingCredits = (room.credits?.videoId === m.videoId || creditsFor === m.videoId) && !ended;
  const watchCredits = () => {
    setCreditsFor(m.videoId);
    void watchCreditsFor({ token, roomId: room._id, videoId: m.videoId }).catch(() => {});
  };
  const showUpNext =
    !!nextUp && duration > 0 && !stillWatching && !watchingCredits && (atCredits || (!stream.outro && remaining < 40));
  const counting = atCredits && !!nextUp && autoNextOn && !stillWatching && !watchingCredits;

  // Count down and move on together. Every client counts; the server takes the first request. Watch credits
  // waits for the end, and "Stop here" turns autoplay off for the room; either ends everyone's countdown.
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (!counting) {
      setCountdown(null);
      return;
    }
    let left = AUTO_NEXT_SECONDS;
    setCountdown(left);
    // Stops at 0, where moving on takes over.
    const id = setInterval(() => {
      setCountdown(--left);
      if (left === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [counting, nextUp?.media.videoId]); // eslint-disable-line react-hooks/exhaustive-deps
  const moveOn = useCallback(
    (media: Media, auto = false) => {
      save();
      void advance({ token, roomId: room._id, fromVideoId: m.videoId, media, auto });
    },
    [save, advance, token, room._id, m.videoId],
  );
  useEffect(() => {
    if (countdown === 0 && nextUp && counting) moveOn(nextUp.media, true);
  }, [countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  return { playNext, atCredits, stillWatching, watchCredits, showUpNext, counting, countdown, moveOn };
}
