import { useEffect, useState } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { CheckIcon, UsersThreeIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { art } from "../../data/cinemeta";
import { episodeLabel } from "../../ui/format";
import type { Media } from "../play";
import { Sheet } from "../../ui/sheet";
import { Art } from "../../ui/artwork";
import { Avatar, Button, cx } from "../../ui/ui";
import { useNeedsTorBox } from "../../data/keys";
import { NeedsTorBox } from "./needsTorBox";

/**
 * Start a watch party. With a title it starts playing right away; without one everybody picks
 * together from the app, with the Party panel open.
 */
export function StartPartySheet({
  open,
  media,
  onClose,
  onStart,
}: {
  open: boolean;
  media?: Media | null;
  onClose: () => void;
  /** Whether the party started; a failed start has already said why. */
  onStart: (inviteIds: Id<"profiles">[]) => Promise<boolean>;
}) {
  const { token, me } = useAuthed();
  const profiles = useQuery(api.profiles.list, { token });
  const others = (profiles ?? []).filter((p) => !p.temporary && p._id !== me._id);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const noTorBox = useNeedsTorBox();

  useEffect(() => {
    if (open) setPicked(new Set(others.map((o) => o._id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profiles?.length]);

  const names = others.filter((o) => picked.has(o._id)).map((o) => o.name);
  // Two names fit on the button; more become a count.
  const label = names.length > 2 ? `Start and invite ${names.length} people`
    : names.length ? `Start and invite ${names.join(" and ")}` : "Start the party";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      variant="center"
      title="Start a watch party"
      description={
        media
          ? "Everyone gets the same stream, in sync. You can switch titles once you’re in."
          : "Pick something together with the Party panel open. It starts when you’re all in."
      }
      footer={
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          loading={busy}
          disabled={noTorBox}
          icon={<UsersThreeIcon weight="bold" />}
          onClick={async () => {
            setBusy(true);
            // A start that fails keeps the sheet open, with the button ready to try again.
            try {
              if (await onStart(others.filter((o) => picked.has(o._id)).map((o) => o._id))) onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="truncate">{label}</span>
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        {noTorBox && <NeedsTorBox />}
        {media && (
          <div className="flex items-center gap-3 rounded-card bg-white/4 p-2">
            <Art
              src={media.background ?? art.background(media.imdbId)}
              alt=""
              fallbackTitle={media.name}
              className="aspect-video w-24 shrink-0 rounded-[8px] img-outline"
            />
            <div className="min-w-0">
              <p className="truncate text-body font-medium">{media.name}</p>
              <p className="truncate text-caption text-fg-faint">
                {media.episodeTitle ? `${episodeLabel(media.season, media.episode)} · ${media.episodeTitle}` : media.year}
              </p>
            </div>
          </div>
        )}
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-medium text-fg-muted">Invite</legend>
          {others.length === 0 && <p className="text-body text-fg-faint">Nobody else in your account yet. Once it starts, send the party’s link to anyone.</p>}
          {others.map((o) => {
            const on = picked.has(o._id);
            return (
              <label
                key={o._id}
                className="flex h-14 cursor-pointer items-center gap-3 rounded-control px-2 hover:bg-white/6 has-focus-visible:outline-2 has-focus-visible:outline-accent"
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  onChange={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(o._id)) n.delete(o._id);
                      else n.add(o._id);
                      return n;
                    })
                  }
                />
                <Avatar name={o.name} hue={o.hue} size={36} />
                <span className="flex-1 text-subhead">{o.name}</span>
                <span
                  className={cx(
                    "grid size-6 place-items-center rounded-full text-[14px]",
                    on ? "bg-accent text-on-accent" : "ring-1 ring-fg-faint ring-inset",
                  )}
                >
                  {on && <CheckIcon weight="bold" />}
                </span>
              </label>
            );
          })}
        </fieldset>
      </div>
    </Sheet>
  );
}
