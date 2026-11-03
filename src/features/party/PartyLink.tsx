import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { errorMessage } from "../play";
import { Avatar, Button, ButtonLink, Spinner } from "../../ui/ui";
import { useEnterParty } from "./partyEntry";
import { forgetPartyLink as forget, pendingPartyLink as pendingCode } from "./partyLinkCode";

/*
 * A party's invite link, `/party#<code>`: anyone signed in who opens it joins, whatever their account. The code stays
 * in the hash, out of request URLs, and is kept for the tab until a profile is chosen: signing in comes first.
 */
export function PartyLink() {
  const { token } = useAuthed();
  const [code] = useState(pendingCode);
  const party = useQuery(api.rooms.byLink, code ? { token, code } : "skip");
  const join = useMutation(api.rooms.join);
  const enter = useEnterParty();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already in it (a reload): straight back in.
  useEffect(() => {
    if (party?.inIt) {
      forget();
      void enter(party.roomId);
    }
  }, [party?.inIt, party?.roomId, enter]);

  if (!code) return <Navigate to="/" replace />;

  const accept = async () => {
    if (!party || busy) return;
    setBusy(true);
    setError(null);
    try {
      await join({ token, roomId: party.roomId, code });
      forget();
      await enter(party.roomId);
    } catch (e) {
      setError(errorMessage(e, "Couldn't join. Try again."));
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-[80dvh] place-items-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        {party === undefined ? (
          <Spinner className="text-fg-faint" />
        ) : party && !party.removed ? (
          <>
            {party.host && <Avatar name={party.host.name} hue={party.host.hue} size={80} />}
            <div className="flex max-w-full flex-col gap-2">
              <h1 className="break-words text-title font-semibold">Join {party.host?.name ?? "this"}’s party</h1>
              <p className="text-body text-pretty text-fg-muted">
                {party.media ? `They’re watching ${party.media.name}.` : "They’re picking something to watch."} Everyone sees the same
                picture, in sync, with chat beside it.
              </p>
            </div>
            <Button variant="primary" size="lg" className="w-full" onClick={() => void accept()} loading={busy}>
              Join the party
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                forget();
                navigate("/", { replace: true });
              }}
            >
              Not now
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-title font-semibold">{party?.removed ? "The host removed you from this party" : "This party has ended"}</h1>
              <p className="text-body text-pretty text-fg-muted">
                {party?.removed ? "Ask them if you think that was a mistake." : "The link stops working once a party ends. Ask the host for a new one."}
              </p>
            </div>
            <ButtonLink to="/" onClick={forget}>
              Go to Krida
            </ButtonLink>
          </>
        )}
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      </div>
    </main>
  );
}
