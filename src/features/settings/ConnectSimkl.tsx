import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAction } from "convex/react";
import { toast } from "../../ui/toast";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { errorMessage } from "../play";
import { ButtonLink, EmptyState, Spinner } from "../../ui/ui";

/** Where to send people back to after Simkl's consent page: exactly a URL registered on the Simkl app. */
export const simklRedirectUri = () =>
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost/connect/simkl"
    : "https://krida-open.vercel.app/connect/simkl";

// A code works once. StrictMode (and a refresh) must not spend it twice.
const spent = new Set<string>();

/** Simkl sends the browser here with ?code&state&iss (or ?error). */
export function ConnectSimkl() {
  const { token } = useAuthed();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const finish = useAction(api.simkl.finish);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const code = params.get("code");
  const state = params.get("state");
  const denied = params.get("error");

  useEffect(() => {
    if (started.current || denied || !code || !state || spent.has(code)) return;
    started.current = true;
    spent.add(code);
    finish({ token, code, state, iss: params.get("iss") ?? undefined }).then(
      ({ name }) => {
        toast(`Simkl connected as ${name}. Bringing in your history…`);
        navigate("/settings/taste", { replace: true });
      },
      (err) => setError(errorMessage(err, "Couldn’t finish connecting Simkl. Try again.")),
    );
  }, [code, state, denied, finish, token, navigate, params]);

  if (denied || (!code && !error))
    return (
      <EmptyState
        className="min-h-[70dvh] pt-24"
        title={denied === "access_denied" ? "Simkl wasn’t connected" : "That Simkl link is incomplete"}
        description={
          denied === "access_denied"
            ? "You chose not to allow Krida on Simkl. You can connect it any time from Settings."
            : "Start again from Settings to connect Simkl."
        }
        action={<ButtonLink to="/settings/taste">Back to Settings</ButtonLink>}
      />
    );
  if (error)
    return (
      <EmptyState
        className="min-h-[70dvh] pt-24"
        title="Simkl wasn’t connected"
        description={error}
        action={<ButtonLink to="/settings/taste">Back to Settings</ButtonLink>}
      />
    );
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 pt-24 text-center">
      <Spinner className="text-fg-faint" />
      <p className="text-body text-fg-muted">Connecting Simkl…</p>
    </div>
  );
}
