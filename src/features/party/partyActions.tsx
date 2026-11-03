import { useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "../../ui/toast";
import { CheckIcon, HandPointingIcon, QueueIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { useParty } from "./party";
import { getMeta, type MediaType } from "../../data/cinemeta";
import { mediaFor, playTarget, useSuggest } from "../play";
import { cx, IconButton } from "../../ui/ui";

/** The party you're in, in full (what's on the table, who's in), or undefined outside one. */
export function usePartyRoom() {
  const { token } = useAuthed();
  const party = useParty();
  return useQuery(api.rooms.get, party ? { token, roomId: party._id } : "skip") ?? undefined;
}

/** An icon that swaps to a check once the thing is done. */
function DoneIcon({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <span className="relative grid size-[1em] place-items-center">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={done ? "done" : "add"}
          initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
          transition={{ type: "spring", duration: 0.3, bounce: 0 }}
          className="grid place-items-center"
        >
          {done ? <CheckIcon weight="bold" /> : children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function SuggestIcon({ done }: { done: boolean }) {
  return (
    <DoneIcon done={done}>
      <HandPointingIcon weight="fill" />
    </DoneIcon>
  );
}

/** "Watch after this": line a title up to play once the current one ends. Small on a row, `md` in a toolbar. */
export function AfterThisButton({
  lined,
  onLineUp,
  size = "sm",
  className,
}: {
  lined: boolean;
  onLineUp: () => void;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <IconButton
      size={size}
      label={lined ? "Lined up for after this" : "Watch after this"}
      aria-pressed={lined}
      onClick={lined ? undefined : onLineUp}
      className={cx(lined && "text-accent", className)}
    >
      <DoneIcon done={lined}>
        <QueueIcon />
      </DoneIcon>
    </IconButton>
  );
}

/**
 * Suggest from a poster while the party is picking. A show goes on the table at the episode you'd
 * play next, the same one its page would suggest.
 */
export function CardSuggest({ item }: { item: { id: string; type: MediaType } }) {
  const { token } = useAuthed();
  const convex = useConvex();
  const party = useParty();
  const room = usePartyRoom();
  const suggest = useSuggest();
  const [busy, setBusy] = useState(false);
  if (!party || party.status !== "idle") return null;
  const suggested = !!room?.suggestions.some((s) => s.media.imdbId === item.id);
  return (
    <IconButton
      size="sm"
      label={suggested ? "On the table" : "Suggest to the party"}
      aria-pressed={suggested}
      disabled={busy}
      // On a card: the scrim once it's on the table, the white pill while it's the thing to do. No blur per card.
      tone={suggested ? "scrim" : "plain"}
      className={cx("min-h-11 min-w-11", !suggested && "fill-primary bg-accent text-on-accent hover:bg-accent-hover!")}
      onClick={
        suggested
          ? undefined
          : async () => {
              setBusy(true);
              try {
                const meta = await getMeta(item.type, item.id);
                const [progress, simkl] =
                  item.type === "series"
                    ? await Promise.all([
                        convex.query(api.progress.forTitle, { token, imdbId: item.id }),
                        convex.query(api.simkl.forTitle, { token, id: item.id }),
                      ])
                    : [undefined, undefined];
                await suggest(mediaFor(meta, playTarget(meta, progress, simkl?.next).video));
              } catch {
                toast.error("Couldn't load that title. Try again.");
              } finally {
                setBusy(false);
              }
            }
      }
    >
      <SuggestIcon done={suggested} />
    </IconButton>
  );
}
