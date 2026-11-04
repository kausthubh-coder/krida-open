// Settings → Connections: the account's TMDB, MDBList and debrid keys, checked with each service as they're pasted.
import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { DEBRID_SERVICES, debridName, TORBOX_SIGNUP, useConnections, type DebridService } from "../../data/keys";
import { toast } from "../../ui/toast";
import { Button, Spinner } from "../../ui/ui";
import { errorMessage } from "../play";
import { Field, Group } from "./settingsParts";
import { inputClass, Select } from "../../ui/select";

type Kind = "tmdb" | "mdblist" | "debrid";
type Service = DebridService;

const SERVICES = DEBRID_SERVICES.map((s) => ({ value: s.value, label: s.value === "torbox" ? "TorBox (recommended)" : s.name, keys: s.keys }));
const serviceName = debridName;

const link = "font-medium text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg";

/** A key's name, what it unlocks, and either the saved key (by its last four characters) or a field to paste one. */
function KeyRow({
  kind,
  title,
  badge,
  label,
  saved,
  service,
  children,
}: {
  kind: Kind;
  title: string;
  badge?: string;
  /** The field's label, which names the kind of key the service calls it. */
  label: string;
  saved: string | null;
  /** The debrid service the key is for; its picker comes in as `children`. */
  service?: Service;
  children: React.ReactNode;
}) {
  const { token } = useAuthed();
  const save = useAction(api.accounts.save);
  const clear = useMutation(api.accounts.clear);
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const editing = !saved || replacing;
  const id = `key-${kind}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return setError("Paste the key first.");
    setChecking(true);
    try {
      const result = await save({ token, kind, key, service });
      if (!result.ok) return setError(result.message);
      setKey("");
      setError(null);
      setReplacing(false);
      toast(`${kind === "debrid" && service ? serviceName(service) : title} key checked and saved.`);
    } catch (err) {
      setError(errorMessage(err, "Couldn’t save the key. Try again."));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-body font-medium">
          {title}
          {badge && (
            <span className="fill-quiet ml-2 inline-flex h-5 items-center rounded-full bg-white/8 px-2 align-[1px] text-caption font-medium text-fg-muted">
              {badge}
            </span>
          )}
        </p>
        {children}
      </div>
      {editing ? (
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1">
          <Field label={label} htmlFor={id} error={error}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id={id}
                type="password"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setError(null);
                }}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Paste the key"
                aria-invalid={!!error || undefined}
                className={inputClass}
              />
              <span className="flex shrink-0 gap-2">
                <Button type="submit" variant="primary" className="h-11" loading={checking}>
                  Check and save
                </Button>
                {replacing && (
                  <Button
                    variant="ghost"
                    className="h-11"
                    onClick={() => {
                      setReplacing(false);
                      setKey("");
                      setError(null);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </span>
            </div>
          </Field>
          {checking && <p className="sr-only" role="status">Checking the key…</p>}
        </form>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="flex flex-1 items-center gap-2 text-body text-fg-muted">
            <CheckCircleIcon weight="fill" className="shrink-0 text-[18px] text-success" />
            <span>
              {service ? `${serviceName(service)} · ` : ""}Saved, ending <span className="font-mono tabular-nums">{saved!.replace("…", "")}</span>
            </span>
          </p>
          <span className="flex gap-2">
            <Button onClick={() => setReplacing(true)}>Replace key</Button>
            <Button
              variant="ghost"
              className="text-danger"
              onClick={() =>
                void clear({ token, kind }).then(
                  () => toast(`${title} key removed.`),
                  (err) => toast.error(errorMessage(err, "Couldn’t remove the key. Try again.")),
                )
              }
            >
              Remove
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}

/** The debrid key, with its service: TorBox does the most in Krida, so it says what the others can't. */
function DebridRow({ saved }: { saved: { service: Service; hint: string } | null }) {
  const [service, setService] = useState<Service>(saved?.service ?? "torbox");
  const keys = SERVICES.find((s) => s.value === service)!.keys;
  return (
    <KeyRow kind="debrid" title="Debrid service" badge="Recommended" label={`${serviceName(service)} API key`} saved={saved?.hint ?? null} service={saved?.service ?? service}>
      <p className="max-w-[60ch] text-body text-fg-faint">
        Plays torrents, which most stream addons find; an addon’s plain web videos play without one.{" "}
        <span className="text-fg-muted">TorBox</span> plays in the browser and the
        installed app, in parties, and gives the timeline its preview pictures. The others play in Krida for Windows and Mac,
        or in an external player.{" "}
        {service === "torbox" ? (
          <>
            No account yet?{" "}
            <a href={TORBOX_SIGNUP} target="_blank" rel="noreferrer" className={link}>
              Sign up for TorBox
            </a>
            , then copy the key from{" "}
            <a href={keys} target="_blank" rel="noreferrer" className={link}>
              its settings
            </a>
            .
          </>
        ) : (
          <a href={keys} target="_blank" rel="noreferrer" className={link}>
            Find your {serviceName(service)} key
          </a>
        )}
      </p>
      {!saved && (
        <div className="mt-3 sm:w-64">
          <label htmlFor="debrid-service" className="sr-only">
            Debrid service
          </label>
          <Select id="debrid-service" value={service} onChange={(v) => setService(v as Service)} options={SERVICES} />
        </div>
      )}
    </KeyRow>
  );
}

export function ConnectionsSection() {
  const connections = useConnections();
  if (connections === undefined)
    return (
      <div className="grid h-40 place-items-center">
        <Spinner className="text-fg-faint" />
      </div>
    );
  if (connections === null) return <p className="text-body text-fg-muted">A temporary profile uses the host’s keys.</p>;
  return (
    <div className="flex flex-col gap-8">
      <Group>
        <KeyRow kind="tmdb" title="TMDB" badge="Recommended" label="TMDB API key" saved={connections.tmdb}>
          <p className="max-w-[60ch] text-body text-fg-faint">
            Adds trending rows, picks for you, people’s pages and browsing by genre. Without it, your addons and
            Cinemeta find titles.{" "}
            <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className={link}>
              Get a free key on TMDB
            </a>
            , and paste the API key, not the read access token.
          </p>
        </KeyRow>
        <KeyRow kind="mdblist" title="MDBList" badge="Optional" label="MDBList API key" saved={connections.mdblist}>
          <p className="max-w-[60ch] text-body text-fg-faint">
            Adds IMDb, Rotten Tomatoes, Metacritic and Letterboxd scores, age ratings and trailers.{" "}
            <a href="https://mdblist.com/preferences/" target="_blank" rel="noreferrer" className={link}>
              Get a free key on MDBList
            </a>
            .
          </p>
        </KeyRow>
      </Group>
      <Group>
        <DebridRow saved={connections.debrid} />
      </Group>
    </div>
  );
}
