import { useMutation } from "convex/react";
import { Pane } from "../../ui/bubbles";
import { toast } from "../../ui/toast";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { art } from "../../data/cinemeta";
import { Art } from "../../ui/artwork";
import { Avatar, Button, cx } from "../../ui/ui";
import { mediaLabel, ONLINE_MS, useRoomPeople, useServerNow, type RoomData } from "./shared";
import { names } from "./presence";

/** Matches SWITCH_TTL_MS on the server. */
const SWITCH_TTL_MS = 30_000;

/**
 * Switching titles while someone is watching asks them first. They see the request with a 30 s
 * ring on Switch now; the asker sees it waiting, and what came of it.
 */
export function SwitchPrompt({ room, panelOpen }: { room: RoomData; panelOpen: boolean }) {
  const { token, me } = useAuthed();
  const profiles = useRoomPeople(room._id);
  const answer = useMutation(api.rooms.answerSwitch);
  const cancel = useMutation(api.rooms.cancelSwitch);
  const playNow = useMutation(api.rooms.playNow);
  const request = room.switchRequest;
  // The ring counts down only while there's a request; ticking without one redrew this 4 times a second all film.
  const now = useServerNow(request ? 250 : null);
  const name = (id?: string) => profiles?.find((p) => p._id === id)?.name ?? "Someone";

  const mine = request?.by === me._id;
  // At most the whole time: the clock catches up a moment after a request arrives.
  const left = request ? Math.min(SWITCH_TTL_MS, Math.max(0, SWITCH_TTL_MS - (now - request.createdAt))) : 0;
  const expired = !!request && left === 0;
  // Someone else's request that timed out or was turned down is no longer theirs to answer.
  const show = !!request && (mine || (!expired && !request.declinedBy));
  // Only who's here and watching is asked; a friend who stepped away isn't waited on.
  const others = names(
    room.members.filter((m) => !m.isMe && m.watching && now - m.lastSeenAt < ONLINE_MS).map((m) => m.name),
  );
  const asker = room.members.find((m) => m._id === request?.by);

  return (
    <AnimatePresence>
      {show && request && (
        <motion.div
          key={request.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
          // The fade is on the glass itself: under a fading wrapper it couldn't blur until the fade ended.
          className={cx(
            "absolute bottom-44 left-1/2 z-30 flex w-[min(400px,calc(100%-32px))] -translate-x-1/2",
            panelOpen && "md:left-[calc(50%-192px)]",
          )}
          role={mine ? "status" : "alertdialog"}
          aria-label={mine ? undefined : `${name(request.by)} wants to switch`}
        >
          <Pane family="toast" radius={24} className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div className="flex items-center gap-3">
            <Art
              src={request.media.background ?? art.background(request.media.imdbId)}
              alt=""
              fallbackTitle={request.media.name}
              className="aspect-video w-24 shrink-0 rounded-[8px] img-outline"
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-caption text-fg-muted">
                {!mine && asker && <Avatar name={asker.name} hue={asker.hue} size={18} />}
                {mine
                  ? request.declinedBy
                    ? `${name(request.declinedBy)} said no to switching to`
                    : expired
                      ? others
                        ? `${others} didn’t answer`
                        : "No answer"
                      : `Asking ${others || "them"} to switch to`
                  : `${name(request.by)} wants to switch to`}
              </p>
              <p className="truncate text-body font-medium" title={mediaLabel(request.media)}>
                {mediaLabel(request.media)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mine ? (
              request.declinedBy || expired ? (
                <>
                  <Button
                    className="h-9 px-3.5"
                    onClick={() =>
                      void playNow({ token, roomId: room._id, media: request.media, startAt: request.startAt })
                    }
                  >
                    Switch anyway
                  </Button>
                  <Button variant="ghost" className="h-9 px-3.5" onClick={() => void cancel({ token, roomId: room._id })}>
                    {request.declinedBy ? "Keep watching" : "Never mind"}
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-caption text-fg-faint tabular-nums">Waiting · {Math.ceil(left / 1000)} s</span>
                  <Button variant="ghost" className="h-9 px-3.5" onClick={() => void cancel({ token, roomId: room._id })}>
                    Never mind
                  </Button>
                </>
              )
            ) : (
              <>
                <Button
                  variant="primary"
                  className="relative h-9 overflow-hidden px-3.5"
                  onClick={async () => {
                    const result = await answer({ token, roomId: room._id, requestId: request.id, accept: true });
                    if (result === "expired") toast("That request ran out of time");
                  }}
                >
                  Switch now
                  {/* The time left to answer, draining across the button. */}
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-on-accent/40"
                    style={{ transform: `scaleX(${left / SWITCH_TTL_MS})` }}
                  />
                </Button>
                <Button
                  className="h-9 px-3.5"
                  onClick={() => void answer({ token, roomId: room._id, requestId: request.id, accept: false })}
                >
                  Keep watching
                </Button>
              </>
            )}
          </div>
          </Pane>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
