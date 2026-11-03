// Inviting the others from inside the party panel.
import { useState } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "../../ui/toast";
import {
  CaretDownIcon,
  UserPlusIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { errorMessage } from "../play";
import { Avatar, Button, cx } from "../../ui/ui";
import { useServerNow, type RoomData } from "./shared";
import { TemporaryProfile } from "./TemporaryProfile";

// ---------------------------------------------------------------------------------------------
// Invites

/**
 * Everyone who isn't in the party, with an Invite and its countdown, and for the host a guest link. A lone
 * person gets their row; anything more folds behind one "Invite someone" row, so the top of the panel stays
 * about the party and a long profile list never pushes the chat away.
 */
export function Invites({ room }: { room: RoomData }) {
  const { token, me } = useAuthed();
  const profiles = useQuery(api.profiles.list, { token });
  const invites = useQuery(api.invites.forRoom, { token, roomId: room._id });
  const send = useMutation(api.invites.send);
  const now = useServerNow(1000);
  const [open, setOpen] = useState(false);
  const members = new Set(room.members.map((m) => m._id as string));

  const rows = (profiles ?? [])
    .filter((p) => !p.temporary && p._id !== me._id && !members.has(p._id))
    .map((p) => {
      const invite = invites?.filter((i) => i.toId === p._id).sort((a, b) => b.createdAt - a.createdAt)[0];
      const pending = invite?.status === "pending" && now < invite.expiresAt ? invite : undefined;
      const left = pending ? Math.max(0, Math.ceil((pending.expiresAt - now) / 1000)) : 0;
      const status = pending
        ? `Invited · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
        : invite?.status === "declined"
          ? "Said not now"
          : invite
            ? "Didn’t answer"
            : "Not in the party";
      return { p, pending, status };
    });
  const temporary = room.hostId === me._id && !me.temporary ? <TemporaryProfile roomId={room._id} /> : null;
  if (rows.length === 0 && !temporary) return null;

  const list = (
    <ul className="flex flex-col">
      {rows.map(({ p, pending, status }) => (
        <li key={p._id} className="flex items-center gap-3 rounded-card p-2">
          <Avatar name={p.name} hue={p.hue} size={28} className="opacity-60" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium" title={p.name}>
              {p.name}
            </span>
            <span className="block truncate text-caption text-fg-faint tabular-nums">{status}</span>
          </span>
          <Button
            variant={pending ? "ghost" : "secondary"}
            className="h-8 px-3"
            onClick={() =>
              void send({ token, roomId: room._id, toId: p._id as Id<"profiles"> }).catch((e) =>
                toast.error(errorMessage(e, "Couldn't send the invite")),
              )
            }
          >
            {pending ? "Invite again" : "Invite"}
          </Button>
        </li>
      ))}
    </ul>
  );
  if (rows.length === 1 && !temporary) return list;

  const invited = rows.filter((r) => r.pending).length;
  return (
    <section className="flex flex-col">
      <button
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-3 rounded-card p-2 text-left text-fg-muted hover:bg-white/5 hover:text-fg"
      >
        {rows.length > 0 ? (
          <span className="flex shrink-0 -space-x-2">
            {rows.slice(0, 3).map(({ p }) => (
              <Avatar key={p._id} name={p.name} hue={p.hue} size={24} className="opacity-80 ring-2 ring-surface" />
            ))}
          </span>
        ) : (
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/8 text-[14px]">
            <UserPlusIcon />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-body">
          {rows.length > 0 ? "Invite someone" : "Invite a guest"}
          {invited > 0 && <span className="text-fg-faint tabular-nums"> · {invited} invited</span>}
        </span>
        <CaretDownIcon className={cx("shrink-0 text-fg-faint transition-transform duration-150 ease-out", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto", transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.12, ease: "easeIn" } }}
            // Clipped while it folds; the margin keeps focus rings inside the clip.
            className="-m-1 flex flex-col overflow-hidden p-1"
          >
            {list}
            {temporary}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
