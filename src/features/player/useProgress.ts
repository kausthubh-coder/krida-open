// Presence in the room, and saving where you are.
import { useCallback, useEffect, useRef } from "react";
import type { useMutation } from "convex/react";
import type { api } from "../../../convex/_generated/api";
import { currentScreen } from "../../ui/screen";
import type { RoomData } from "../party";

/** A heartbeat every 5 seconds with the position and whether this viewer is buffering. */
export function usePresence(
  heartbeat: ReturnType<typeof useMutation<typeof api.rooms.heartbeat>>,
  video: HTMLVideoElement | null,
  buffering: boolean,
  token: string,
  roomId: RoomData["_id"],
) {
  useEffect(() => {
    const beat = () => {
      if (!video) return;
      void heartbeat({
        token,
        roomId,
        position: video.currentTime,
        buffering,
        watching: true,
        screen: currentScreen(),
      }).catch(() => {});
    };
    beat();
    const id = setInterval(beat, 5000);
    return () => clearInterval(id);
  }, [video, buffering, heartbeat, token, roomId]);
}

/**
 * Saves the position: a tick every 30 seconds while playing, and the exact spot on pause, when the tab is hidden and
 * on leaving. Returns the save, for moving on.
 */
export function useSaveProgress(
  saveProgress: ReturnType<typeof useMutation<typeof api.progress.save>>,
  video: HTMLVideoElement | null,
  media: NonNullable<RoomData["media"]>,
  streamDuration: number | undefined,
  paused: boolean,
  token: string,
) {
  const mediaRef = useRef(media);
  mediaRef.current = media;
  // The server keeps a tick a minute; pausing, hiding the tab and leaving keep the exact spot.
  const save = useCallback((final = false) => {
    if (!video) return;
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : streamDuration ?? 0;
    if (d > 0 && video.currentTime > 5) {
      void saveProgress({ token, media: mediaRef.current, position: video.currentTime, duration: d, final }).catch(() => {});
    }
  }, [video, streamDuration, saveProgress, token]);
  useEffect(() => {
    const id = setInterval(() => !paused && save(), 30_000);
    return () => clearInterval(id);
  }, [paused, save]);
  useEffect(() => {
    if (paused) save(true);
  }, [paused, save]);
  useEffect(() => {
    const onHide = () => document.hidden && save(true);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [save]);
  useEffect(() => () => save(true), [save]);
  return save;
}
