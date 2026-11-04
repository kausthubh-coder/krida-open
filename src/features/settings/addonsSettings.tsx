// Settings → Addons: this profile's Stremio addons, installing more (a link, a suggestion, a Stremio account, another
// profile), and each one's switch, order, reload, setup page and removal.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAction, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { ArrowClockwiseIcon, ArrowDownIcon, ArrowUpIcon, CaretDownIcon, CheckCircleIcon, GearSixIcon, PuzzlePieceIcon, TrashIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { AIOSTREAMS_SETUP, COMMUNITY_ADDONS, addonBase, hasResource, isRow, stremioPage } from "../../../shared/stremio";
import { useAddons, type InstalledAddon } from "../../data/addons";
import { useAuthed } from "../../data/session";
import { toast } from "../../ui/toast";
import { Button, cx, IconButton, Spinner, Toggle } from "../../ui/ui";
import { errorMessage } from "../play";
import { Field, Group } from "./settingsParts";
import { inputClass, Select } from "../../ui/select";
import { StremioError, stremioAddonUrls } from "./stremioImport";

const link = "font-medium text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg";

/** What an addon gives, in a few words: "Streams · 12 catalogs · Subtitles". */
export function addonSummary(manifest: InstalledAddon["manifest"]) {
  const rows = manifest.catalogs.filter(isRow).length;
  const parts = [
    hasResource(manifest, "stream") && "Streams",
    rows > 0 && `${rows} ${rows === 1 ? "catalog" : "catalogs"}`,
    hasResource(manifest, "subtitles") && "Subtitles",
    !hasResource(manifest, "stream") && rows === 0 && hasResource(manifest, "meta") && "Details",
  ].filter(Boolean);
  return parts.join(" · ") || "Nothing Krida uses yet";
}

function AddonLogo({ src }: { src?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-white/6 text-[20px] text-fg-muted">
        <PuzzlePieceIcon />
      </span>
    );
  return <img src={src} alt="" onError={() => setBroken(true)} className="size-10 shrink-0 rounded-[12px] bg-white/6 object-contain outline-1 -outline-offset-1 outline-white/10" />;
}

function AddonRow({ addon, index, all }: { addon: InstalledAddon; index: number; all: InstalledAddon[] }) {
  const { token } = useAuthed();
  const setEnabled = useMutation(api.addons.setEnabled);
  const reorder = useMutation(api.addons.reorder);
  const remove = useMutation(api.addons.remove);
  const install = useAction(api.addons.install);
  const reload = useAction(api.addons.reload);
  const [open, setOpen] = useState(false);
  const [reloading, setReloading] = useState(false);
  const { manifest } = addon;
  const failed = (fallback: string) => (err: unknown) => toast.error(errorMessage(err, fallback));

  const move = (by: number) => {
    const ids = all.map((a) => a._id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id);
    void reorder({ token, ids }).catch(failed("Couldn’t move it. Try again."));
  };

  const onReload = async () => {
    setReloading(true);
    try {
      const result = await reload({ token, addonId: addon._id });
      if (result.ok) toast(`${result.name} reloaded.`);
      else toast.error(result.message);
    } catch (err) {
      failed("Couldn’t reload it. Try again.")(err);
    } finally {
      setReloading(false);
    }
  };

  const onRemove = () =>
    void remove({ token, addonId: addon._id }).then(
      () =>
        toast(`Removed ${manifest.name}.`, {
          duration: 6000,
          action: { label: "Undo", onClick: () => void install({ token, url: addon.url }).catch(failed("Couldn’t put it back. Install it again.")) },
        }),
      failed("Couldn’t remove it. Try again."),
    );

  return (
    <li className="flex flex-col gap-3">
      <div className="flex min-h-12 items-center gap-3">
        <AddonLogo src={manifest.logo} />
        <span className="min-w-0 flex-1">
          <span className={cx("block truncate text-body font-medium", !addon.enabled && "text-fg-muted")}>{manifest.name}</span>
          <span className="block truncate text-body text-fg-faint">{addon.enabled ? addonSummary(manifest) : "Off"}</span>
        </span>
        <Toggle
          label={`Use ${manifest.name}`}
          checked={addon.enabled}
          onChange={(enabled) => void setEnabled({ token, addonId: addon._id, enabled }).catch(failed("Couldn’t change it. Try again."))}
        />
        <IconButton size="sm" label={`${open ? "Hide" : "Show"} what you can do with ${manifest.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          <CaretDownIcon className={cx("transition-transform duration-150", open && "rotate-180")} />
        </IconButton>
      </div>
      {open && (
        <div className="flex flex-col gap-3 sm:pl-13">
          {manifest.description && <p className="max-w-[60ch] text-body text-fg-faint">{manifest.description}</p>}
          <div className="flex flex-wrap gap-2">
            <Button icon={<ArrowUpIcon />} disabled={index === 0} onClick={() => move(-1)}>
              Move up
            </Button>
            <Button icon={<ArrowDownIcon />} disabled={index === all.length - 1} onClick={() => move(1)}>
              Move down
            </Button>
            <Button icon={<ArrowClockwiseIcon />} loading={reloading} onClick={() => void onReload()}>
              Reload
            </Button>
            {manifest.configurable && (
              <Button icon={<GearSixIcon />} onClick={() => window.open(`${addon.url}/configure`, "_blank", "noopener")}>
                Set up on its page
              </Button>
            )}
            <Button variant="ghost" icon={<TrashIcon />} className="text-danger" onClick={onRemove}>
              Remove
            </Button>
          </div>
          <p className="text-caption text-fg-faint">Version {manifest.version}</p>
        </div>
      )}
    </li>
  );
}

/** This profile's addons, each with its switch, order and menu. Settings → Addons, and onboarding's addons step. */
export function InstalledAddons() {
  const addons = useAddons();
  if (addons === undefined)
    return (
      <div className="grid h-24 place-items-center">
        <Spinner className="text-fg-faint" />
      </div>
    );
  if (addons.length === 0)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium">No addons yet</p>
        <p className="max-w-[60ch] text-body text-fg-faint">
          A stream addon finds what Play plays; a catalog addon adds rows to Home. Start with a suggestion below, or paste any Stremio addon’s link.
        </p>
      </div>
    );
  return (
    <ul className="flex flex-col gap-2">
      {addons.map((a, i) => (
        <AddonRow key={a._id} addon={a} index={i} all={addons} />
      ))}
    </ul>
  );
}

/** `quiet` where another button is the screen's main action (onboarding's Continue). */
export function InstallByLink({ quiet = false }: { quiet?: boolean }) {
  const { token } = useAuthed();
  const install = useAction(api.addons.install);
  const [params, setParams] = useSearchParams();
  const incoming = params.get("addon");
  const [url, setUrl] = useState(() => {
    const page = incoming && stremioPage(incoming.replace(/^https:\/\//, "stremio://"));
    return page?.startsWith("/settings/addons?") ? incoming! : "";
  });
  useEffect(() => {
    if (!incoming) return;
    // The input keeps the link in memory; it needn't stay in browser history.
    const clean = new URLSearchParams(params);
    clean.delete("addon");
    setParams(clean, { replace: true });
  }, [incoming, params, setParams]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; configure?: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return setError({ message: "Paste the addon’s link first." });
    setBusy(true);
    try {
      const result = await install({ token, url });
      if (!result.ok) return setError(result);
      setUrl("");
      setError(null);
      toast(result.updated ? `Updated ${result.name}.` : `${result.name} installed.`);
    } catch (err) {
      setError({ message: errorMessage(err, "Couldn’t install it. Try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-1">
      <Field label="Install from a link" htmlFor="addon-url" hint="The addon’s manifest link, ending in manifest.json. stremio:// links work too." error={error?.message ?? null}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="addon-url"
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://…/manifest.json"
            aria-invalid={!!error || undefined}
            className={inputClass}
          />
          <Button type="submit" variant={quiet ? undefined : "primary"} className="h-11 shrink-0" loading={busy}>
            Install
          </Button>
        </div>
      </Field>
      <p className="text-caption text-fg-faint">On an addon’s page, use Copy link instead of Install.</p>
      {error?.configure && (
        <a href={error.configure} target="_blank" rel="noreferrer" className={cx(link, "text-body")}>
          Open its setup page
        </a>
      )}
      {busy && (
        <p className="sr-only" role="status">
          Checking the addon…
        </p>
      )}
    </form>
  );
}

export function Suggestions() {
  const { token } = useAuthed();
  const suggestions = useQuery(api.addons.suggestions, { token });
  const install = useAction(api.addons.installSuggestion);
  const [busy, setBusy] = useState<string | null>(null);
  if (!suggestions) return null;
  if (!suggestions.service)
    return (
      <p className="max-w-[60ch] text-body text-fg-faint">
        <Link to="/settings/connections" className={link}>
          Add your debrid key
        </Link>{" "}
        and Krida suggests stream addons already set up with it.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body font-medium">Suggested for your debrid service</p>
      {suggestions.items.map((s) => (
        <div key={s.id} className="flex min-h-12 items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-body font-medium">{s.name}</span>
            <span className="block text-body text-fg-faint">{s.description}</span>
          </span>
          {s.installed ? (
            <span className="flex shrink-0 items-center gap-1.5 text-body text-fg-muted">
              <CheckCircleIcon weight="fill" className="text-success" aria-hidden />
              Installed
            </span>
          ) : (
            <Button
              className="shrink-0"
              loading={busy === s.id}
              onClick={async () => {
                setBusy(s.id);
                try {
                  const result = await install({ token, suggestion: s.id });
                  if (result.ok) toast(`${result.name} installed.`);
                  else toast.error(result.message);
                } catch (err) {
                  toast.error(errorMessage(err, "Couldn’t install it. Try again."));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Install {s.name}
            </Button>
          )}
        </div>
      ))}
      <div className="flex min-h-12 items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium">AIOStreams</span>
          <span className="block text-body text-fg-faint">Many addons behind one link, sorted and filtered your way. Set it up on its page, then paste the link it gives you.</span>
        </span>
        <a href={AIOSTREAMS_SETUP} target="_blank" rel="noreferrer" className={`${link} shrink-0 text-body`}>
          Set up AIOStreams
        </a>
      </div>
    </div>
  );
}

type ImportResult = { added: string[]; already: number; failed: { host: string; message: string }[] };

function importSummary({ added, already, failed }: ImportResult) {
  const parts = [
    added.length ? `Added ${added.length === 1 ? added[0] : `${added.length} addons`}.` : "No new addons to add.",
    already ? `${already} ${already === 1 ? "was" : "were"} already installed.` : "",
    failed.length ? `${failed.length} couldn’t be added: ${failed.map((f) => f.host).join(", ")}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export function StremioImport() {
  const { token } = useAuthed();
  const importUrls = useAction(api.addons.importUrls);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return setError("Enter your Stremio email and password.");
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const urls = await stremioAddonUrls(email, password);
      if (urls.length === 0) return setError("That Stremio account has no addons Krida can install.");
      const done = await importUrls({ token, urls });
      setResult(done);
      setPassword("");
    } catch (err) {
      setError(err instanceof StremioError ? err.message : errorMessage(err, "Couldn’t import your addons. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <span>
        <span className="block text-body font-medium">Import from Stremio</span>
        <span className="block max-w-[60ch] text-body text-fg-faint">
          This browser signs in to Stremio, reads your addon list and signs out. Krida never keeps your Stremio email or password.
        </span>
      </span>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="stremio-email" className="sr-only">
          Stremio email
        </label>
        <input id="stremio-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Stremio email" className={inputClass} />
        <label htmlFor="stremio-password" className="sr-only">
          Stremio password
        </label>
        <input id="stremio-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder="Password" className={inputClass} />
        <Button type="submit" className="h-11 shrink-0" loading={busy}>
          Import addons
        </Button>
      </div>
      <p role="status" className={cx("min-h-5 text-body", error ? "text-danger" : "text-fg-muted")}>
        {error ?? (result ? importSummary(result) : busy ? "Reading your Stremio addons…" : "")}
      </p>
      {result && result.failed.length > 0 && (
        <ul className="flex flex-col gap-1 text-body text-fg-faint">
          {result.failed.map((f) => (
            <li key={f.host} className="truncate">
              {f.host}: {f.message}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function CopyFromProfile() {
  const { token, me } = useAuthed();
  const copy = useMutation(api.addons.copyFrom);
  const others = (useQuery(api.profiles.list, { token }) ?? []).filter((p) => !p.temporary && p._id !== me._id);
  const [from, setFrom] = useState<string>("");
  const [busy, setBusy] = useState(false);
  if (others.length === 0) return null;
  const chosen = from || others[0]._id;
  const name = others.find((p) => p._id === chosen)?.name ?? "";
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <span className="min-w-0 flex-1">
        <label htmlFor="copy-from" className="block text-body font-medium">
          Copy from another profile
        </label>
        <span className="block text-body text-fg-faint">Adds their addons after yours. Ones you have already are skipped.</span>
      </span>
      <span className="flex gap-2">
        <span className="sm:w-40">
          <Select id="copy-from" value={chosen} onChange={setFrom} options={others.map((p) => ({ value: p._id, label: p.name }))} />
        </span>
        <Button
          className="h-11 shrink-0"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { added } = await copy({ token, fromProfileId: chosen as Id<"profiles"> });
              toast(added ? `Copied ${added} ${added === 1 ? "addon" : "addons"} from ${name}.` : `You already have all of ${name}’s addons.`);
            } catch (err) {
              toast.error(errorMessage(err, "Couldn’t copy them. Try again."));
            } finally {
              setBusy(false);
            }
          }}
        >
          Copy addons
        </Button>
      </span>
    </div>
  );
}

export function AddonsSection() {
  return (
    <div className="flex flex-col gap-8">
      <Group>
        <InstalledAddons />
      </Group>
      <div>
        <h2 className="mb-3 text-subhead font-semibold">Add addons</h2>
        <Group>
          <Suggestions />
          <InstallByLink />
          <BrowseAddons />
          <StremioImport />
          <CopyFromProfile />
        </Group>
      </div>
    </div>
  );
}

function BrowseAddons() {
  const { token } = useAuthed();
  const install = useAction(api.addons.install);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-body font-medium">Browse addons</h3>
      {COMMUNITY_ADDONS.map((addon) => (
        <div key={addon.url} className="flex min-h-12 items-center gap-3">
          <span className="min-w-0 flex-1 text-body">{addon.name}</span>
          {addon.configurationRequired ? (
            <a href={`${addonBase(addon.url)}/configure`} target="_blank" rel="noreferrer" className={link}>Set up</a>
          ) : (
            <Button loading={busy === addon.url} disabled={busy !== null} onClick={async () => {
              setBusy(addon.url);
              try {
                const result = await install({ token, url: addon.url });
                if (result.ok) toast(result.updated ? `Updated ${result.name}.` : `${result.name} installed.`);
                else toast.error(result.message);
              } catch (err) {
                toast.error(errorMessage(err, "Couldn’t install it. Try again."));
              } finally {
                setBusy(null);
              }
            }}>Install</Button>
          )}
        </div>
      ))}
    </div>
  );
}
