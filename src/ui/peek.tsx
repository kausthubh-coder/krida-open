import { useState, type ReactNode } from "react";
import { InfoIcon, PlayIcon } from "@phosphor-icons/react";
import { Art } from "./artwork";
import { cardScores, type ScoreSource } from "./scores";
import { Sheet } from "./sheet";
import { CardPlace } from "./longPress";
import { Button, ButtonLink } from "./ui";

/**
 * A title at a glance, risen from the bottom like Netflix's: its poster, what it is, Play, and the card's own
 * actions with their names. Details opens the title page.
 */
export function Peek({
  open,
  onClose,
  to,
  title,
  poster,
  titleId,
  facts,
  description,
  score,
  actions,
  onPlay,
}: {
  open: boolean;
  onClose: () => void;
  to: string;
  title: string;
  poster?: string;
  titleId?: string;
  facts?: ReactNode;
  description?: string;
  score?: ScoreSource;
  actions?: ReactNode;
  onPlay?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const scores = score ? cardScores(score).slice(0, 3) : [];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      description={facts}
      leading={<Art src={poster} titleId={titleId} alt="" fallbackTitle={title} className="aspect-2/3 w-16 rounded-control img-outline" />}
    >
      <div className="flex flex-col gap-4">
        {scores.length > 0 && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-body text-fg-muted">
            {scores.map((s) => (
              <span key={s.key} title={s.label}>
                <span className="font-medium text-fg tabular-nums">{s.value}</span> {s.short}
              </span>
            ))}
          </p>
        )}
        {description && <p className="line-clamp-4 text-body text-pretty text-fg-muted">{description}</p>}
        <div className="flex gap-2">
          {onPlay ? (
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              icon={<PlayIcon weight="fill" />}
              className="flex-1"
              // Home stays mounted under the player, and so would this sheet: it closes once playing has started.
              onClick={async () => {
                setBusy(true);
                await onPlay();
                setBusy(false);
                onClose();
              }}
            >
              Play
            </Button>
          ) : null}
          <ButtonLink to={to} onClick={onClose} variant={onPlay ? "secondary" : "primary"} size="lg" icon={<InfoIcon />} className="flex-1">
            Details
          </ButtonLink>
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">
            <CardPlace.Provider value="peek">{actions}</CardPlace.Provider>
          </div>
        )}
      </div>
    </Sheet>
  );
}
