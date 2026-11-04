import { LockSimpleIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import { cx } from "./ui";

const keyLink = "font-medium text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg";

/**
 * Where something only TMDB has would be (trending rows, picks, people, genre browsing), while the account has no TMDB
 * key that works: one quiet line to Settings → Connections, never an error. The rest runs on the addons and Cinemeta.
 */
export function TmdbForMore({ className }: { className?: string }) {
  return (
    <p className={cx("text-body text-pretty text-fg-faint", className)}>
      <Link to="/settings/connections" className={keyLink}>
        Add a TMDB key for more
      </Link>
      : trending rows, picks for you, people and browsing by genre.
    </p>
  );
}

/**
 * Under a Play that can't start: why (no debrid service), and where to fix it. Play itself stays, dimmed, and says the same
 * when pressed (features/play `usePlay`), so nothing fails half way (docs/models/Onboarding.tla).
 */
export function PlayNeedsDebrid({ id, className }: { id?: string; className?: string }) {
  return (
    <p id={id} className={cx("flex items-start gap-2 text-body text-pretty text-fg-muted", className)}>
      <LockSimpleIcon aria-hidden className="mt-0.5 shrink-0 text-fg-faint" />
      <span>
        Playing needs a debrid service.{" "}
        <Link to="/settings/connections" className={keyLink}>
          Add a debrid key
        </Link>
      </span>
    </p>
  );
}
