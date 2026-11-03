import { useEffect, useRef } from "react";
import { Pane } from "../../ui/bubbles";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { toast } from "../../ui/toast";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { playInvite } from "../../ui/sound";
import { episodeLabel } from "../../ui/format";
import { Avatar, Button, cx } from "../../ui/ui";
import { PopcornIcon } from "@phosphor-icons/react";
import { Art } from "../../ui/artwork";
import { useEnterParty } from "./partyEntry";

/**
 * Invites come from somewhere else, so they are one of the few things that earn a toast. It stays
 * until answered or expired (10 minutes), and a quiet chime plays if sounds are on. A knock (someone asking to join
 * what you're watching alone) arrives the same way, with Let in.
 */
export function InviteListener() {
  const { token } = useAuthed();
  const invites = useQuery(api.invites.mine, { token });
  const respond = useMutation(api.invites.respond);
  const enter = useEnterParty();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (!invites) return;
    const live = new Set(invites.map((i) => i._id as string));
    // Dismiss toasts for invites that were answered elsewhere or expired.
    for (const id of shown.current) {
      if (!live.has(id)) {
        toast.dismiss(id);
        shown.current.delete(id);
      }
    }
    for (const invite of invites) {
      if (shown.current.has(invite._id)) continue;
      shown.current.add(invite._id);
      playInvite();
      const media = invite.media;
      const what = !media
        ? undefined
        : media.episodeTitle
          ? `${media.name} · ${episodeLabel(media.season, media.episode)}`
          : media.name;
      // A knock: they're asking to join what I'm watching. Saying yes is all it takes; their screen joins.
      const knock = invite.kind === "knock";
      const letIn = (inviteId: Id<"invites">) => {
        toast.dismiss(inviteId);
        void respond({ token, inviteId, accept: true }).catch(() => {});
      };
      const join = async (inviteId: Id<"invites">, roomId: Id<"rooms">) => {
        toast.dismiss(inviteId);
        await respond({ token, inviteId, accept: true }).catch(() => {});
        await enter(roomId);
      };
      toast.custom(
        () => (
          <Pane family="toast" radius={24} className="flex w-full gap-3 p-3 sm:w-[356px]">
            {media ? (
              <Art
                src={media.poster}
                titleId={media.imdbId}
                alt=""
                fallbackTitle={media.name}
                className="aspect-2/3 w-14 shrink-0 rounded-[8px] img-outline"
              />
            ) : (
              <span className="grid aspect-2/3 w-14 shrink-0 place-items-center rounded-[8px] bg-white/6 text-[24px] text-fg-muted">
                <PopcornIcon weight="fill" />
              </span>
            )}
            {/* Who, then what: the title is what decides it, so it reads strongest and may take two lines. */}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="flex min-w-0 items-center gap-1.5 text-caption text-fg-muted">
                <Avatar name={invite.from.name} hue={invite.from.hue} size={18} />
                <span className="truncate">
                  <span className="font-medium text-fg">{invite.from.name}</span>{" "}
                  {knock ? "wants to join you" : media ? "invited you to watch" : "invited you to a party"}
                </span>
              </p>
              <p className={cx("line-clamp-2 text-body", what ? "font-medium text-fg" : "text-fg-muted")} title={what}>
                {what ?? "Nothing picked yet. You’ll choose together."}
              </p>
              <div className="mt-2.5 flex gap-2">
                {/* Compact in the toast; the hit area still reaches 44px. */}
                <Button
                  variant="primary"
                  className="h-9! after:absolute after:-inset-1"
                  onClick={() => (knock ? letIn(invite._id) : join(invite._id, invite.roomId))}
                >
                  {knock ? "Let in" : "Join"}
                </Button>
                <Button
                  variant="ghost"
                  className="h-9! after:absolute after:-inset-1"
                  onClick={() => {
                    toast.dismiss(invite._id);
                    void respond({ token, inviteId: invite._id, accept: false });
                  }}
                >
                  Not now
                </Button>
              </div>
            </div>
          </Pane>
        ),
        // Stays until answered, or until the invite expires (it can't be accepted after that).
        { id: invite._id, duration: Math.max(1000, invite.expiresAt - Date.now()) },
      );
    }
  }, [invites, enter, respond, token]);

  return null;
}
