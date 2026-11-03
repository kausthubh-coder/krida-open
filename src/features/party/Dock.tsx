import { useEffect, useRef, useState } from "react";
import { Pane } from "../../ui/bubbles";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { XIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { useParty } from "./party";
import { usePartyPanel } from "./partyEntry";
import { Avatar, Button, cx, IconButton } from "../../ui/ui";
import { BrowsePanel } from "./lobby";
import { useUnread } from "./chat";
import { HEADER_ICON } from "./panels";
import { ArrivalBanner, useEventToasts, useJoinMoments } from "./moments";
import { useReactionSounds } from "./soundboard";
import { ONLINE_MS, useServerNow, type RoomData } from "./shared";
import { useStartParty } from "../play";
import { useNeedsTorBox } from "../../data/keys";
import { NeedsTorBox } from "./needsTorBox";
import { useMedia } from "../../ui/media";

/**
 * The Party panel while you browse: a pane floating at the corner, over the page rather than beside it, so opening it
 * moves nothing. On phones it's a sheet above the tab bar. Opening it starts nothing: until you invite someone it only
 * offers to, and from then on it's the party. Picking happens out here: when the party starts something, everyone who
 * was picking goes to the player together.
 */
export function PartyDock() {
  const { token } = useAuthed();
  const party = useParty();
  const queried = useQuery(api.rooms.get, party ? { token, roomId: party._id } : "skip");
  const room = party && queried && !queried.closedAt ? queried : null;
  const { pathname } = useLocation();
  const [open, setOpen] = usePartyPanel();
  const wide = useMedia("(min-width: 48rem)");

  // Following a title or navigation link should reveal that page on a phone.
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current !== pathname && !wide) setOpen(false);
    previousPath.current = pathname;
  }, [pathname, wide, setOpen]);
  // A party that ended doesn't turn into the offer to start one.
  const hadParty = useRef(false);
  useEffect(() => {
    if (party === undefined) return;
    if (hadParty.current && !party) setOpen(false);
    hadParty.current = !!party;
  }, [party, setOpen]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  // The toasts step out from under it.
  useEffect(() => {
    if (!open || !wide) return;
    document.documentElement.dataset.partyOpen = "";
    return () => {
      delete document.documentElement.dataset.partyOpen;
    };
  }, [open, wide]);

  const close = () => setOpen(false);
  const from = wide ? { x: 16, y: 0 } : { x: 0, y: 24 };
  return (
    <>
      <AnimatePresence>
        {open && !wide && (
          <motion.button
            key="scrim"
            aria-label="Close party"
            tabIndex={-1}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.2 } }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            onClick={close}
            className="fixed inset-0 z-30 cursor-default bg-black/40"
          />
        )}
        {open && party !== undefined && (
          <motion.aside
            key="panel"
            id="party-panel"
            aria-label="Party"
            initial={{ opacity: 0, ...from }}
            animate={{ opacity: 1, x: 0, y: 0, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, x: from.x / 2, y: from.y / 2, transition: { duration: 0.12, ease: "easeIn" } }}
            className={cx(
              // Phones: a sheet above the tab bar. Wider: a corner of the window, clear of the dock once there's room beside it.
              "fixed z-30 flex flex-col",
              "inset-x-3 bottom-[calc(84px+var(--dock-bottom))] max-h-[calc(100dvh-176px)]",
              "md:inset-x-auto md:right-4 md:bottom-24 md:z-40 md:max-h-[calc(100dvh-112px)] md:w-[360px] xl:bottom-4 xl:max-h-[calc(100dvh-32px)]",
              // The conversation fills what the party is given; the offer is only as tall as what it says.
              party && "h-[min(560px,calc(100dvh-176px))]",
            )}
          >
            <Pane thin>
              {party ? room && <PartyBody room={room} onClose={close} /> : <PartyOffer onClose={close} />}
            </Pane>
          </motion.aside>
        )}
      </AnimatePresence>
      {room && <PartyDuties key={room._id} room={room} />}
    </>
  );
}

function PartyBody({ room, onClose }: { room: RoomData; onClose: () => void }) {
  const online = useOnline(room);
  return <BrowsePanel room={room} online={online} onClose={onClose} />;
}

/** lastSeenAt is the server's time; a device clock 20 s off would show everyone as away. */
function useOnline(room: RoomData) {
  const now = useServerNow(5000);
  return room.members.filter((m) => m.isMe || now - m.lastSeenAt < ONLINE_MS);
}

/** Who you could watch with. A party begins when you invite one of them, and they join from the invite. */
function PartyOffer({ onClose }: { onClose: () => void }) {
  const { token, me } = useAuthed();
  const profiles = useQuery(api.profiles.list, { token });
  const others = (profiles ?? []).filter((p) => !p.temporary && p._id !== me._id);
  const start = useStartParty();
  const noTorBox = useNeedsTorBox();
  const [busy, setBusy] = useState<string | null>(null);
  const begin = async (id: string, inviteIds: Id<"profiles">[]) => {
    setBusy(id);
    await start(inviteIds);
    setBusy(null);
  };
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="-mr-2 flex h-10 items-center gap-1">
        <h2 className="min-w-0 flex-1 text-title font-semibold">Party</h2>
        <IconButton label="Close" size="sm" className={cx(HEADER_ICON, "bg-white/8")} onClick={onClose}>
          <XIcon />
        </IconButton>
      </div>
      {noTorBox ? (
        <NeedsTorBox />
      ) : (
        <p className="text-body text-pretty text-fg-muted">
          {others.length
            ? "Invite someone. They can join from wherever they are, and you pick something together."
            : "Start a party and send its link. Anyone signed in to Krida who opens it joins."}
        </p>
      )}
      {others.length > 0 && (
        <ul className="-mx-2 flex flex-col">
          {others.map((p) => (
            <li key={p._id} className="flex items-center gap-3 rounded-card p-2">
              <Avatar name={p.name} hue={p.hue} size={32} />
              <span className="min-w-0 flex-1 truncate text-body font-medium" title={p.name}>
                {p.name}
              </span>
              <Button
                variant="primary"
                className="h-9 px-4"
                aria-label={`Invite ${p.name}`}
                loading={busy === p._id}
                disabled={!!busy || noTorBox}
                onClick={() => void begin(p._id, [p._id])}
              >
                Invite
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" className="-ml-4 h-9 self-start" loading={busy === "alone"} disabled={!!busy || noTorBox} onClick={() => void begin("alone", [])}>
        {others.length ? "Start without inviting anyone" : "Start a party"}
      </Button>
    </div>
  );
}

/** What a party does whether or not its panel is open. */
function PartyDuties({ room }: { room: RoomData }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = usePartyPanel();
  const arrival = useJoinMoments(room.members);
  useEventToasts(room, open);
  // The header pill and the Party tab show the count; the blip plays from here, once.
  useUnread(room._id, open, true);
  useReactionSounds(room._id);

  // The party picked something: everyone who was picking with it goes to the player. Switching
  // titles mid-watch doesn't pull back someone who stepped out. Back to picking opens the panel.
  const was = useRef(room.status);
  useEffect(() => {
    const before = was.current;
    was.current = room.status;
    const target = `/watch/${room._id}`;
    if (before === "idle" && room.status !== "idle" && room.media && pathname !== target) navigate(target);
    if (before !== "idle" && room.status === "idle") setOpen(true);
  }, [room.status, room.media, room._id, pathname, navigate, setOpen]);

  // "Starting in 3" is a chance to say no, so it shouldn't happen behind a closed panel.
  useEffect(() => {
    if (room.starting) setOpen(true);
  }, [room.starting?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  return <ArrivalBanner name={arrival} className="fixed top-20" />;
}
