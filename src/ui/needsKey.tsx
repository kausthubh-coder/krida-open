import { KeyIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import { ButtonLink, cx, EmptyState } from "./ui";

/** What Home and Search show while the account has no TMDB key: why they're empty, and where to add it. */
export function NeedsTmdbKey({ className }: { className?: string }) {
  return (
    <EmptyState
      className={className}
      icon={<KeyIcon />}
      title="Add your TMDB key to see titles"
      description="Krida finds films and shows with your own TMDB key. It’s free: make a TMDB account, copy the API key from its settings, and paste it in Connections."
      action={
        <ButtonLink to="/settings/connections" variant="primary">
          Add your TMDB key
        </ButtonLink>
      }
    />
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
        <Link to="/settings/connections" className="font-medium text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg">
          Add a debrid key
        </Link>
      </span>
    </p>
  );
}
