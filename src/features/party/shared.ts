import { useEffect } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { CONVEX_SITE_URL } from "../../data/backend";
import { useNow } from "../../ui/clock";
import { createServerClock } from "./serverClock";

export const SITE = CONVEX_SITE_URL;
export const ONLINE_MS = 20_000;

export type RoomData = NonNullable<FunctionReturnType<typeof api.rooms.get>>;
export type Member = RoomData["members"][number];
export type Suggestion = RoomData["suggestions"][number];

const server = createServerClock();

/**
 * Everyone who has been in the room, of any account, for the names beside chat, suggestions and who asked for what:
 * the account's own profile list doesn't have the others.
 */
export function useRoomPeople(roomId: Id<"rooms">) {
  const { token } = useAuthed();
  return useQuery(api.rooms.people, { token, roomId });
}

/** Date.now() on the server's clock, for refs and event handlers. A screen using `useServerNow` keeps it measured. */
export function serverNow() {
  return server.now();
}

/** Date.now() on the server's clock, ticking every `every` ms (with `null` it stands still). */
export function useServerNow(every: number | null = 1000) {
  const clock = useMutation(api.rooms.clock);
  const now = useNow(every);
  useEffect(() => {
    const ask = () => clock({});
    void server.measure(ask);
    // Back from sleep or a background tab, the clocks may have drifted apart.
    const onVisible = () => {
      if (document.visibilityState === "visible") void server.measure(ask, true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [clock]);
  return now + server.offset();
}

/** "Lost" and "Severance S1 E3" read the same way everywhere. */
export function mediaLabel(media: { name: string; season?: number; episode?: number }) {
  return media.season !== undefined && media.episode !== undefined
    ? `${media.name} · S${media.season} E${media.episode}`
    : media.name;
}
