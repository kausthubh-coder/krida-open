import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useConvex, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { toast } from "../../ui/toast";
import { PopcornIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { useParty, type MyParty } from "./party";
import { errorMessage, useStartParty, type Media } from "../play";
import { useServerNow } from "./shared";
import { names } from "./presence";
import { useUnread } from "./chat";
import { StartPartySheet } from "./together";
import { cx } from "../../ui/ui";
import { DockTip } from "../../ui/dockTip";

type Ctx = {
  openStartParty: (media?: Media, startAt?: number) => void;
  panelOpen: boolean;
  setPanelOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  askToJoin: (roomId: Id<"rooms">, who: string) => Promise<void>;
};

/** A knock of mine waiting for an answer: whose room, and the knock itself. */
type Knock = { roomId: Id<"rooms">; inviteId: Id<"invites">; who: string };
const KNOCK_TOAST = "knock";
const PartyUIContext = createContext<Ctx | null>(null);

// The panel stays as you left it across a refresh.
const PANEL_KEY = "krida.partyPanel";

/** Owns the "Start a watch party" sheet and the Party panel, so any part of the app can open them. */
export function PartyUIProvider({ children }: { children: ReactNode }) {
  const { token } = useAuthed();
  const start = useStartParty();
  const knockOn = useMutation(api.invites.knock);
  const withdraw = useMutation(api.invites.withdraw);
  const [knock, setKnock] = useState<Knock | null>(null);
  // Someone watching alone is asked first; the answer comes back through KnockWatcher.
  const askToJoin = useCallback(
    async (roomId: Id<"rooms">, who: string) => {
      try {
        const inviteId = await knockOn({ token, roomId });
        setKnock({ roomId, inviteId, who });
        toast(`Asking ${who} to let you in`, {
          id: KNOCK_TOAST,
          duration: Infinity,
          action: {
            label: "Never mind",
            onClick: () => {
              setKnock(null);
              void withdraw({ token, inviteId });
            },
          },
        });
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't ask to join"));
      }
    },
    [token, knockOn, withdraw],
  );
  const [state, setState] = useState<{ open: boolean; media?: Media; startAt?: number }>({ open: false });
  const [panelOpen, setPanelOpen] = useState(() => sessionStorage.getItem(PANEL_KEY) === "open");
  useEffect(() => {
    sessionStorage.setItem(PANEL_KEY, panelOpen ? "open" : "closed");
  }, [panelOpen]);
  const openStartParty = useCallback((media?: Media, startAt?: number) => setState({ open: true, media, startAt }), []);
  return (
    <PartyUIContext.Provider value={{ openStartParty, panelOpen, setPanelOpen, askToJoin }}>
      {children}
      {knock && <KnockWatcher knock={knock} onDone={() => setKnock(null)} />}
      <StartPartySheet
        open={state.open}
        media={state.media}
        onClose={() => setState((s) => ({ ...s, open: false }))}
        onStart={async (inviteIds) => {
          const roomId = await start(inviteIds, state.media, state.startAt);
          if (roomId && !state.media) setPanelOpen(true);
          return !!roomId;
        }}
      />
    </PartyUIContext.Provider>
  );
}

/** Waits for the answer to a knock: let in joins at once; a no, no answer or a film that ended says so. */
function KnockWatcher({ knock, onDone }: { knock: Knock; onDone: () => void }) {
  const { token } = useAuthed();
  const state = useQuery(api.invites.knockState, { token, roomId: knock.roomId });
  const enter = useEnterParty();
  useEffect(() => {
    if (!state || state._id !== knock.inviteId || state.status === "pending") return;
    onDone();
    toast.dismiss(KNOCK_TOAST);
    if (state.status === "accepted") void enter(knock.roomId);
    else
      toast(
        state.status === "declined"
          ? `${knock.who} said not now`
          : state.status === "expired"
            ? `${knock.who} didn’t answer`
            : `${knock.who} stopped watching`,
      );
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function usePartyUI() {
  const ctx = useContext(PartyUIContext);
  if (!ctx) throw new Error("Party UI used outside PartyUIProvider");
  return ctx;
}

export function useOpenStartParty() {
  return usePartyUI().openStartParty;
}

/** Whether the Party panel is showing beside the page (or over it, on smaller screens). */
export function usePartyPanel() {
  const { panelOpen, setPanelOpen } = usePartyUI();
  return [panelOpen, setPanelOpen] as const;
}

/**
 * Into a party from an invite or the header: a party that's still picking is picked from right
 * here, with the panel open; one that's already watching opens the player.
 */
export function useEnterParty() {
  const { token } = useAuthed();
  const convex = useConvex();
  const navigate = useNavigate();
  const join = useMutation(api.rooms.join);
  const { setPanelOpen } = usePartyUI();
  return useCallback(
    async (roomId: Id<"rooms">) => {
      try {
        await join({ token, roomId });
        const room = await convex.query(api.rooms.get, { token, roomId });
        if (room && room.kind === "party" && room.status === "idle") setPanelOpen(true);
        else navigate(`/watch/${roomId}`);
      } catch (error) {
        toast.error(errorMessage(error, "Couldn't join this party"));
      }
    },
    [token, convex, join, navigate, setPanelOpen],
  );
}

type Profile = { _id: string; name: string; hue: number };
type LiveRoom = NonNullable<ReturnType<typeof useLiveRooms>>[number];

export type PartyEntry =
  | { kind: "mine"; party: MyParty }
  | { kind: "theirs"; room: LiveRoom }
  | { kind: "none"; others: Profile[] };

function useLiveRooms() {
  const { token } = useAuthed();
  const live = useQuery(api.rooms.live, { token });
  // Presence is a heartbeat, so "here" is judged here rather than by the server, on the server's clock.
  const now = useServerNow(10_000);
  return live
    ?.map((r) => ({ ...r, members: r.members.filter((m) => now - m.lastSeenAt < 60_000) }))
    .filter((r) => r.members.length > 0);
}

/**
 * The party, from anywhere: back to yours, into your friend's, or a new one with them. The header
 * button and the Party tab both read this, so they always agree.
 */
export function usePartyEntry() {
  const { token, me } = useAuthed();
  const party = useParty();
  const live = useLiveRooms();
  const profiles = useQuery(api.profiles.list, { token });
  const enter = useEnterParty();
  const { panelOpen, setPanelOpen, askToJoin } = usePartyUI();
  const others = (profiles ?? []).filter((p) => !p.temporary && p._id !== me._id);

  const entry: PartyEntry = party
    ? { kind: "mine", party }
    : live?.[0]
      ? { kind: "theirs", room: live[0] }
      : { kind: "none", others };

  const go = () => {
    // A party is meant to be joined; someone watching alone is asked first.
    if (entry.kind === "theirs")
      void (entry.room.kind === "party"
        ? enter(entry.room._id)
        : askToJoin(entry.room._id, names(entry.room.members.map((m) => m.name))));
    // Your party lives in the panel, wherever you are. With none, the panel offers to invite someone: opening it starts nothing.
    else setPanelOpen((o) => !o);
  };
  const unread = useUnread(party?._id, panelOpen);
  return { entry, go, panelOpen, unread, loading: party === undefined };
}

function whatLabel(media?: { name: string } | null) {
  return media ? media.name : "picking";
}

/**
 * The dock's party button: the panel (your party, or the offer to start one), or your friend's party. It's one
 * icon whatever the state, like the dock's other places; faces stay in the party panel, since beside your own
 * avatar a friend's reads as a second you. A dot on the icon says a party is live (green) or has news (white),
 * and the tooltip says the rest. The dock's lens stays on the page you're on: the open panel says where it came
 * from, and a second lit pill would read as a second place you're on.
 */
export function PartyNavButton() {
  // Shown while the party loads too (as "Watch together"), so the dock never changes width under the pointer.
  const { entry, go, panelOpen, unread } = usePartyEntry();
  const base = "dock-item press relative grid size-13 place-items-center rounded-full";
  const icon = (live: boolean, dot?: "live" | "news") => (
    <span className="relative">
      <PopcornIcon aria-hidden size={24} weight={live ? "fill" : "regular"} className="block" />
      {dot && (
        <span
          aria-hidden
          className={cx("absolute -top-0.5 -right-1 size-2.5 rounded-full ring-2 ring-black/40", dot === "news" ? "bg-accent" : "bg-success")}
        />
      )}
    </span>
  );

  if (entry.kind === "mine") {
    const { party } = entry;
    const news = unread > 0 && !panelOpen;
    const label = `Party, ${whatLabel(party.media)}${news ? `, ${unread} new message${unread === 1 ? "" : "s"}` : ""}`;
    return (
      <button
        onClick={go}
        className={cx(base, "text-fg", panelOpen ? "fill-raised bg-white/10" : "fill-hover hover:bg-white/8")}
        aria-expanded={panelOpen}
        aria-controls="party-panel"
        aria-label={label}
      >
        {icon(true, news ? "news" : "live")}
        {!panelOpen && <DockTip>{label}</DockTip>}
      </button>
    );
  }
  if (entry.kind === "theirs") {
    const { room } = entry;
    const doing = room.media ? `is watching ${room.media.name}` : "is in a party";
    // Watching alone, they're asked first (askToJoin).
    const label = `${names(room.members.map((m) => m.name))} ${doing}. ${room.kind === "party" ? "Join" : "Ask to join"}`;
    return (
      <button onClick={go} aria-label={label} className={cx(base, "fill-hover text-fg hover:bg-white/8")}>
        {icon(false, "live")}
        <DockTip>{label}</DockTip>
      </button>
    );
  }
  const friend = entry.others.length === 1 ? entry.others[0] : undefined;
  const label = friend ? `Watch with ${friend.name}` : "Watch together";
  return (
    <button
      onClick={go}
      aria-expanded={panelOpen}
      aria-controls="party-panel"
      aria-label={label}
      className={cx(base, panelOpen ? "fill-raised bg-white/10 text-fg" : "fill-hover text-fg-muted hover:bg-white/8 hover:text-fg")}
    >
      {icon(panelOpen)}
      {!panelOpen && <DockTip>{label}</DockTip>}
    </button>
  );
}
