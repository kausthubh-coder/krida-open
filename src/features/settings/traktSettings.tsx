// Settings → Connections: this profile's Trakt account. Connecting shows a code to enter at trakt.tv/activate, on this
// device or any other, so it works the same in the browser, the installed app and on a TV (docs/trakt.md).
import { useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { toast } from "../../ui/toast";
import { Button, Spinner } from "../../ui/ui";
import { errorMessage } from "../play";
import { Switch } from "./settingsParts";

const link = "font-medium text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg";

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function ago(at: number, now: number) {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The name, what it does, and its action beside it: the same shape as Simkl's row. */
function Intro({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4 sm:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-medium">Trakt</p>
        {children}
      </div>
      {action}
    </div>
  );
}

/** This profile's Trakt account: connect with a code, see what came in, keep it in sync, or let it go. */
export function TraktConnection() {
  const { token } = useAuthed();
  const enabled = useQuery(api.trakt.enabled, {});
  const status = useQuery(api.trakt.status, enabled ? { token } : "skip");
  const login = useQuery(api.trakt.login, enabled ? { token } : "skip");
  const start = useAction(api.trakt.start);
  const cancel = useMutation(api.trakt.cancel);
  const syncNow = useMutation(api.trakt.syncNow);
  const setWriteBack = useMutation(api.trakt.setWriteBack);
  const disconnect = useMutation(api.trakt.disconnect);
  const [starting, setStarting] = useState(false);
  // A code running out, a stuck sync lease or a pause can end without the queries changing.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), login && !login.over ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [login]);
  // Approved at Trakt while the code was showing (the code goes as the connection comes): say so once.
  const waited = useRef(false);
  useEffect(() => {
    if (login) {
      waited.current = !login.over;
      return;
    }
    if (waited.current && status && !status.needsReconnect)
      toast(`Trakt connected${status.account ? ` as ${status.account.name}` : ""}. Bringing in your history…`);
    waited.current = false;
  }, [login, status]);

  const connect = async () => {
    setStarting(true);
    try {
      await start({ token });
    } catch (err) {
      toast.error(errorMessage(err, "Couldn’t start connecting Trakt. Try again."));
    } finally {
      setStarting(false);
    }
  };

  if (enabled === false)
    return (
      <Intro>
        <p className="max-w-[56ch] text-body text-fg-muted">
          Not set up on this server. Whoever runs this Krida adds a Trakt app to turn it on.
        </p>
      </Intro>
    );

  if (enabled === undefined || status === undefined || login === undefined)
    return (
      <div className="grid h-24 place-items-center">
        <Spinner className="text-fg-faint" />
      </div>
    );

  if (status === null) {
    const waiting = login && !login.over && login.expiresAt > now;
    if (waiting) {
      const left = Math.max(0, Math.ceil((login.expiresAt - now) / 60000));
      const site = login.verificationUrl.replace(/^https?:\/\//, "");
      return (
        <Intro
          action={
            <Button variant="ghost" onClick={() => void cancel({ token })}>
              Cancel
            </Button>
          }
        >
          <p className="max-w-[56ch] text-body text-fg-muted">
            Go to{" "}
            <a href={login.verificationUrl} target="_blank" rel="noreferrer" className={link}>
              {site}
            </a>{" "}
            on this or any device, sign in and enter this code:
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="select-all font-mono text-title tracking-[0.2em] tabular-nums" aria-label={`Code ${login.userCode.split("").join(" ")}`}>
              {login.userCode}
            </span>
            <Button
              onClick={() =>
                void navigator.clipboard.writeText(login.userCode).then(
                  () => toast("Code copied."),
                  () => toast.error("Couldn’t copy. Type the code instead."),
                )
              }
            >
              Copy code
            </Button>
          </div>
          <p className="mt-1 flex items-center gap-2 text-body text-fg-faint" aria-live="polite">
            <Spinner className="size-4 text-fg-faint" />
            Waiting for Trakt · the code works for {count(left, "more minute", "more minutes")}
          </p>
        </Intro>
      );
    }
    const ended = login?.over ?? (login ? "expired" : null);
    return (
      <Intro
        action={
          <Button variant="primary" loading={starting} onClick={() => void connect()}>
            {ended ? "Try again" : "Connect Trakt"}
          </Button>
        }
      >
        <p className="max-w-[56ch] text-body text-fg-muted">
          {ended === "denied"
            ? "Trakt wasn’t connected: you chose not to allow Krida."
            : ended === "expired"
              ? "That code ran out before Trakt heard back. Get a new one to connect."
              : "Brings in what you’ve watched (and where you stopped), your watchlist and your ratings, for this profile. What you finish here is marked watched on Trakt."}
        </p>
      </Intro>
    );
  }

  const waiting = status.waiting > 0 ? ` · ${count(status.waiting, "change", "changes")} to send` : "";
  // The query hands over raw times: only this page knows what time it is now.
  const syncing = status.syncingSince !== null && status.syncingSince > now - status.syncLease;
  const state = syncing
    ? status.imported
      ? "Syncing…"
      : "Importing your history…"
    : status.pausedUntil && status.pausedUntil > now
      ? `Trakt asked for a pause until ${new Date(status.pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${waiting}`
      : status.lastSyncAt
        ? `In sync, checked ${ago(status.lastSyncAt, now)}${waiting}`
        : "Waiting to import";
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-body font-medium">
            Trakt{status.account ? <span className="font-normal text-fg-muted"> · {status.account.name}</span> : null}
          </p>
          <p className="flex items-center gap-2 text-body text-fg-muted" aria-live="polite">
            {syncing && <Spinner className="size-4 text-fg-faint" />}
            {state}
          </p>
          {status.imported && (
            <p className="text-body text-fg-faint tabular-nums">
              Brought in{" "}
              {[
                count(status.imported.plays, "play", "plays"),
                count(status.imported.planned, "on your watchlist", "on your watchlist"),
                count(status.imported.rated, "rating", "ratings"),
              ].join(" · ")}
            </p>
          )}
          {status.lastError && <p className="text-body text-danger">{status.lastError}</p>}
        </div>
        {status.needsReconnect ? (
          <Button variant="primary" loading={starting} onClick={() => void connect()}>
            Connect again
          </Button>
        ) : (
          <Button loading={syncing} onClick={() => void syncNow({ token })}>
            Sync now
          </Button>
        )}
      </div>
      {status.needsReconnect && login && !login.over && login.expiresAt > now && (
        <p className="text-body text-fg-muted">
          Enter <span className="select-all font-mono tracking-[0.2em]">{login.userCode}</span> at{" "}
          <a href={login.verificationUrl} target="_blank" rel="noreferrer" className={link}>
            {login.verificationUrl.replace(/^https?:\/\//, "")}
          </a>
          .
        </p>
      )}
      <Switch
        label="Keep Trakt up to date"
        hint="What you finish or mark here is added to your Trakt history, and Plan to watch, your Trakt watchlist and your ratings stay the same. Changes from Trakt come in whenever you open Krida."
        checked={status.writeBack}
        onChange={(writeBack) => void setWriteBack({ token, writeBack })}
      />
      <div>
        <Button
          variant="ghost"
          className="-ml-3"
          onClick={async () => {
            await disconnect({ token });
            toast("Trakt disconnected. What came in stays here, and your Trakt account still has everything.");
          }}
        >
          Disconnect Trakt
        </Button>
      </div>
    </div>
  );
}
