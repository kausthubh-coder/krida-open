// Settings → Connections: this profile's Simkl account, connecting, what came in, keeping it in sync, letting it go.
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { toast } from "../../ui/toast";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { errorMessage } from "../play";
import { Button, Spinner } from "../../ui/ui";
import { simklRedirectUri } from "./ConnectSimkl";
import { useTables } from "../../data/sync";
import { Switch } from "./settingsParts";

const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function ago(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** This profile's Simkl account: connect, see what came in, keep it in sync, or let it go. */
export function SimklConnection() {
  const { token } = useAuthed();
  const connection = useQuery(api.simkl.syncState, { token });
  const tracked = useTables()?.tracked;
  // What the imported library holds, counted from this profile's synced copy.
  const status = useMemo(() => connection && tracked ? {
    ...connection,
    titles: tracked.length,
    watched: tracked.filter((r) => r.status === "completed" || r.status === "watching").length,
    rated: tracked.filter((r) => r.rating !== undefined).length,
    planned: tracked.filter((r) => r.status === "plantowatch").length,
  } : connection === null ? null : undefined, [connection, tracked]);
  const start = useMutation(api.simkl.start);
  const syncNow = useMutation(api.simkl.syncNow);
  const setWriteBack = useMutation(api.simkl.setWriteBack);
  const disconnect = useMutation(api.simkl.disconnect);
  const [connecting, setConnecting] = useState(false);
  // A stuck sync lease, a pause or a new day can end without the query changing.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const connect = async () => {
    setConnecting(true);
    try {
      window.location.assign(await start({ token, redirectUri: simklRedirectUri() }));
    } catch (err) {
      setConnecting(false);
      toast.error(errorMessage(err, "Couldn’t start connecting Simkl. Try again."));
    }
  };

  if (status === undefined)
    return (
      <div className="grid h-24 place-items-center">
        <Spinner className="text-fg-faint" />
      </div>
    );

  if (status === null)
    return (
      // The name and what it does, then the action beside it: the same shape as Your ratings below.
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-body font-medium">Simkl</p>
          <p className="max-w-[56ch] text-body text-fg-muted">
            Brings in what you’ve watched, rated and plan to watch. Your picks start from your real taste, and your Simkl
            watchlist shows up in Plan to watch.
          </p>
        </div>
        <Button variant="primary" loading={connecting} onClick={() => void connect()}>
          Connect Simkl
        </Button>
      </div>
    );

  const waiting = status.waiting > 0 ? ` · ${count(status.waiting, "change", "changes")} to send` : "";
  // The query hands over raw times: only this page knows what time it is now.
  const syncing = status.syncingSince !== null && status.syncingSince > now - status.syncLease;
  const overBudget = status.usage?.day === new Date(now).toISOString().slice(0, 10) && status.usage.count >= status.budget;
  const state = syncing
    ? status.imported
      ? "Syncing…"
      : "Importing your library…"
    : status.pausedUntil && status.pausedUntil > now
      ? `Simkl asked for a pause until ${new Date(status.pausedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${waiting}`
      : overBudget
        ? `Synced enough for today; picks up again tomorrow${waiting}`
        : status.lastSyncAt
          ? `In sync, checked ${ago(status.lastSyncAt)}${waiting}`
          : "Waiting to import";
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-body font-medium">
            Simkl{status.account ? <span className="font-normal text-fg-muted"> · {status.account.name}</span> : null}
          </p>
          <p className="flex items-center gap-2 text-body text-fg-muted" aria-live="polite">
            {status.syncing && <Spinner className="size-4 text-fg-faint" />}
            {state}
          </p>
          {status.titles > 0 && (
            <p className="text-body text-fg-faint tabular-nums">
              {[
                count(status.watched, "watched", "watched"),
                count(status.rated, "rated", "rated"),
                count(status.planned, "on your watchlist", "on your watchlist"),
              ].join(" · ")}
            </p>
          )}
          {status.lastError && <p className="text-body text-danger">{status.lastError}</p>}
        </div>
        {status.needsReconnect ? (
          <Button variant="primary" loading={connecting} onClick={() => void connect()}>
            Connect again
          </Button>
        ) : (
          <Button loading={status.syncing} onClick={() => void syncNow({ token })}>
            Sync now
          </Button>
        )}
      </div>
      <Switch
        label="Keep Simkl up to date"
        hint={
          status.canWrite
            ? "What you finish here is marked watched, and Plan to watch and your Simkl watchlist stay the same. Changes from Simkl come in whenever you open Krida."
            : "Simkl only allowed reading. Connect again to let Krida update it."
        }
        checked={status.writeBack && status.canWrite}
        onChange={(writeBack) => void setWriteBack({ token, writeBack })}
      />
      <div>
        <Button
          variant="ghost"
          className="-ml-3"
          onClick={async () => {
            await disconnect({ token });
            toast("Simkl disconnected. Your Simkl account still has everything.");
          }}
        >
          Disconnect Simkl
        </Button>
      </div>
    </div>
  );
}
