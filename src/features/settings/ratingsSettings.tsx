// Settings → Ratings: how many titles you've rated here and on Simkl, and a way to rate more.
import { useMemo } from "react";
import { ButtonLink } from "../../ui/ui";
import { scoreOf } from "../../../convex/lib/ratings";
import { useTables } from "../../data/sync";

/** Your own ratings: how many, and a way to rate more. */
export function Ratings() {
  const t = useTables();
  const [feedback, tracked] = [t?.feedback, t?.tracked];
  const summary = useMemo(() => feedback && tracked
    ? { rated: feedback.filter((f) => scoreOf(f) !== null).length, onSimkl: tracked.filter((r) => r.rating !== undefined).length }
    : undefined, [feedback, tracked]);
  const total = summary?.rated ?? 0;
  const parts = summary
    ? [
        total && `${total} rated in Krida`,
        summary.onSimkl && `${summary.onSimkl} rated on Simkl`,
      ].filter(Boolean)
    : [];
  return (
    // Laid out like the Simkl row above it: the name, what it does and where you stand, then the action.
    <div className="flex flex-col items-start gap-4 sm:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-medium">Your ratings</p>
        <p className="max-w-[56ch] text-body text-fg-muted">
          Rate what you’ve watched to find more of what you love. Give movies, shows, seasons and episodes a score from 1 to 10.
        </p>
        <p className="min-h-5 text-body text-fg-faint tabular-nums">
          {summary === undefined ? "Loading your ratings…" : parts.length ? parts.join(" · ") : "Nothing rated yet."}
        </p>
      </div>
      <ButtonLink to="/library?tab=rate">Rate watched titles</ButtonLink>
    </div>
  );
}
