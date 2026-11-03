import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { currentScreen } from "../../ui/screen";
import { useAuthed } from "../../data/session";

export type MyParty = NonNullable<FunctionReturnType<typeof api.rooms.mine>>;

const PartyContext = createContext<MyParty | null | undefined>(undefined);

/**
 * The party you're in follows you around the app. While it's picking, browsing is how you pick, so
 * the heartbeat counts you as here (that's who "everyone's in" waits for). While something plays,
 * browsing keeps you in the party without counting you as watching.
 */
export function PartyProvider({ children }: { children: ReactNode }) {
  const { token } = useAuthed();
  const party = useQuery(api.rooms.mine, { token });
  const heartbeat = useMutation(api.rooms.heartbeat);
  const { pathname } = useLocation();
  const onPartyPage = !!party && pathname === `/watch/${party._id}`;
  const picking = party?.status === "idle";

  useEffect(() => {
    if (!party || onPartyPage) return;
    const beat = () => void heartbeat({ token, roomId: party._id, watching: picking, screen: currentScreen() }).catch(() => {});
    beat();
    // Picking beats as often as the player did, so presence never flickers mid-vote.
    const id = setInterval(beat, picking ? 5000 : 10_000);
    return () => clearInterval(id);
  }, [party?._id, onPartyPage, picking, heartbeat, token]); // eslint-disable-line react-hooks/exhaustive-deps

  return <PartyContext.Provider value={party}>{children}</PartyContext.Provider>;
}

/** The party you're in: undefined while loading, null when you're not in one. */
export function useParty() {
  return useContext(PartyContext);
}
