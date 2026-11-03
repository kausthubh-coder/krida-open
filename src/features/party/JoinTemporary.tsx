import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../../convex/_generated/api";
import { useSession } from "../../data/session";
import { errorMessage } from "../play";
import { Avatar, Button, ButtonLink, Spinner } from "../../ui/ui";
import { Wordmark } from "../../ui/wordmark";

/** "Sat 9:41 PM": a guest profile lasts a day, so the weekday and time say when without the seconds. */
function until(at: number) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
}

export function JoinTemporary() {
  // Keep the secret out of request URLs and referrers.
  const [code] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("code") ?? "");
  const invite = useQuery(api.profiles.temporaryInvite, code ? { code } : "skip");
  const join = useMutation(api.profiles.joinTemporary);
  const { me, setToken } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await join({ code });
      setToken(result.token);
      navigate(`/watch/${result.roomId}`, { replace: true });
    } catch (e) {
      setError(errorMessage(e, "Couldn't join. Try again."));
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <Wordmark className="text-display" />
        {code && invite === undefined ? <Spinner /> : invite ? (
          <>
            <Avatar name={invite.name} hue={invite.hue} size={80} />
            <div className="flex max-w-full flex-col gap-2">
              <h1 className="break-words text-title font-semibold">Join {invite.host}’s party</h1>
              <p className="text-body text-pretty text-fg-muted">
                You’ll join as <span className="font-medium break-words text-fg">{invite.name}</span>, a guest profile that
                lasts until {until(invite.expiresAt)}.
                {me && ` This switches this device from ${me.name} to ${invite.name}.`}
              </p>
            </div>
            <Button variant="primary" size="lg" className="w-full" onClick={() => void accept()} loading={busy}>
              Join the party
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-title font-semibold">This join link doesn’t work anymore</h1>
              <p className="text-body text-pretty text-fg-muted">
                It may have expired or been used, or the party may have ended. Ask the host for a new link.
              </p>
            </div>
            <ButtonLink to="/">Go to Krida</ButtonLink>
          </>
        )}
        <p role="alert" className="text-body text-danger">{error}</p>
      </div>
    </main>
  );
}
