import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { ArrowLeftIcon, ArrowRightIcon, ArrowSquareOutIcon, CheckCircleIcon, CheckIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed, useSession } from "../../data/session";
import { DEBRID_SERVICES, debridName, TORBOX_SIGNUP, type DebridService } from "../../data/keys";
import { Avatar, Button, cx, Spinner } from "../../ui/ui";
import { inputClass } from "../../ui/select";
import { Wordmark } from "../../ui/wordmark";
import { errorMessage } from "../play";
import { InstallByLink, InstalledAddons, SimklConnection, StremioImport, Suggestions } from "../settings";
import { route, stepBefore, STEPS, type Status, type Step } from "./route";

/*
 * The steps between making a profile and Home (docs/models/Onboarding.tla): the TMDB key, a debrid service, this
 * profile's addons, then the optional keys. Each can be skipped. The server says which step is next (onboarding.status, `route`); Back and
 * an addons step someone is still filling in are held here. Each step is saved as it's done, so leaving and coming
 * back, on any device, resumes where it stopped.
 */

const link = "font-medium text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg";
const NAMES: Record<Step, string> = { tmdbKey: "TMDB", debrid: "Debrid", addons: "Addons", extras: "Extras" };

export function Onboarding({ status, onDone }: { status: Status; onDone: () => void }) {
  const server = route({ signedIn: true, profile: true, status });
  // A step someone went back to, and a step they're still filling in: an installed addon or a saved MDBList key
  // finishes its step on the server, but they may want another addon, or Simkl too. Each stays until its own button.
  const [back, setBack] = useState<Step | null>(null);
  const [held, setHeld] = useState<Step | null>(null);
  const step = back ?? held ?? server;
  if ((step === "addons" || step === "extras") && held !== step && !back) setHeld(step);
  useEffect(() => {
    if (step === "home") onDone();
  }, [step, onDone]);
  const top = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    top.current?.focus({ preventScroll: true });
  }, [step]);
  if (step === "home" || step === "landing" || step === "picker") return <Frame />;

  const forward = () => {
    setBack(null);
    setHeld(null);
  };
  const goBack = () => {
    setHeld(null);
    setBack(stepBefore(step));
  };

  return (
    <Frame step={step}>
      {step === "tmdbKey" && <TmdbStep status={status} headingRef={top} onNext={forward} />}
      {step === "debrid" && <DebridStep status={status} headingRef={top} onNext={forward} onBack={goBack} />}
      {step === "addons" && <AddonsStep status={status} headingRef={top} onNext={forward} onBack={goBack} />}
      {step === "extras" && <ExtrasStep status={status} headingRef={top} onNext={forward} onBack={goBack} />}
    </Frame>
  );
}

/** The page every step sits on: the wordmark, where you are in the steps, and who's setting up. */
function Frame({ step, children }: { step?: Step; children?: ReactNode }) {
  const { me } = useAuthed();
  const { signOut } = useSession();
  const at = step ? STEPS.indexOf(step) : -1;
  return (
    <main className="relative min-h-dvh overflow-x-clip px-4 pt-[calc(var(--inset-top)+20px)] pb-16 sm:px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[60dvh]"
        style={{ background: `radial-gradient(60% 60% at 50% 0%, oklch(0.4 0.08 ${me.hue} / 0.28), transparent 70%)` }}
      />
      <div className="relative mx-auto flex w-full max-w-xl flex-col gap-10">
        <header className="flex items-center justify-between gap-4">
          <Wordmark className="text-title" />
          <button onClick={() => void signOut()} className="press flex min-h-11 items-center gap-2 rounded-full pr-1 pl-3 text-body text-fg-muted hover:text-fg">
            <span className="max-sm:sr-only">Switch profile</span>
            <Avatar name={me.name} hue={me.hue} size={32} />
          </button>
        </header>
        {step ? (
          <>
            <ol aria-label="Setting up" className="flex gap-1.5">
              {STEPS.map((s, i) => (
                <li key={s} className="flex flex-1 flex-col gap-2" aria-current={i === at ? "step" : undefined}>
                  <span className={cx("h-1 rounded-full transition-colors duration-300", i <= at ? "bg-fg" : "bg-white/12")} />
                  <span className={cx("text-caption", i === at ? "font-medium text-fg" : "text-fg-faint")}>
                    <span className="sr-only">{i < at ? "Done: " : ""}</span>
                    {NAMES[s]}
                  </span>
                </li>
              ))}
            </ol>
            <div key={step} className="rise-in flex flex-col gap-8">
              {children}
            </div>
          </>
        ) : (
          <div className="grid h-60 place-items-center">
            <Spinner className="text-fg-faint" />
          </div>
        )}
      </div>
    </main>
  );
}

function Heading({ headingRef, title, children }: { headingRef: React.Ref<HTMLHeadingElement>; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 ref={headingRef} tabIndex={-1} className="text-display font-semibold text-balance outline-none">
        {title}
      </h1>
      <div className="flex flex-col gap-3 text-subhead text-pretty text-fg-muted">{children}</div>
    </div>
  );
}

function Actions({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
      {onBack && (
        <Button variant="ghost" icon={<ArrowLeftIcon />} onClick={onBack} className="sm:mr-auto">
          Back
        </Button>
      )}
      <div className="flex flex-col-reverse gap-3 sm:ml-auto sm:flex-row">{children}</div>
    </div>
  );
}

/** A key field that checks the key with its provider as soon as it's pasted, or on Enter. */
function KeyField({
  id,
  label,
  kind,
  service,
  onSaved,
}: {
  id: string;
  label: string;
  kind: "tmdb" | "mdblist" | "debrid";
  service?: DebridService;
  onSaved: () => void;
}) {
  const { token } = useAuthed();
  const save = useAction(api.accounts.save);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);

  const check = async (value: string) => {
    if (!value.trim()) return setError("Paste the key first.");
    setChecking(true);
    setError(null);
    try {
      const result = await save({ token, kind, key: value, service });
      if (!result.ok) return setError(result.message);
      setKey("");
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn’t check the key. Try again."));
    } finally {
      setChecking(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void check(key);
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={id} className="px-1 text-body font-medium text-fg-muted">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
            setSaved(false);
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").trim();
            if (!pasted) return;
            e.preventDefault();
            setKey(pasted);
            void check(pasted);
          }}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Paste the key"
          aria-invalid={!!error || undefined}
          aria-describedby={`${id}-status`}
          className={cx(inputClass, error && "ring-danger/70")}
        />
        <Button type="submit" className="h-11 shrink-0" loading={checking}>
          Check key
        </Button>
      </div>
      <p id={`${id}-status`} role="status" className={cx("min-h-5 px-1 text-body", error ? "text-danger" : "text-fg-muted")}>
        {error ?? (checking ? "Checking with the service…" : saved ? "Checked and saved." : "")}
      </p>
    </form>
  );
}

function Saved({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-card bg-surface px-4 py-3 text-body text-fg-muted shadow-raised">
      <CheckCircleIcon weight="fill" className="shrink-0 text-[18px] text-success" />
      <span>{children}</span>
    </p>
  );
}

function Ending({ hint }: { hint: string }) {
  return (
    <span data-key-hint className="font-mono tabular-nums">
      {hint.replace("…", "")}
    </span>
  );
}

type StepProps = { status: Status; headingRef: React.Ref<HTMLHeadingElement>; onNext: () => void; onBack?: () => void };

function TmdbStep({ status, headingRef, onNext }: StepProps) {
  const { token } = useAuthed();
  const connections = useQuery(api.accounts.connections, { token });
  const skipTmdb = useMutation(api.onboarding.skipTmdb);
  const [replacing, setReplacing] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const stopped = status.tmdb === "invalid";
  const keep = status.tmdb === "valid" && !replacing;
  const skip = async () => {
    setSkipping(true);
    try {
      await skipTmdb({ token });
      onNext();
    } finally {
      setSkipping(false);
    }
  };
  return (
    <>
      <Heading headingRef={headingRef} title={stopped ? "Your TMDB key stopped working" : "Connect TMDB"}>
        {stopped ? (
          <p>TMDB no longer accepts the key saved for this account. Paste a new one and you’re back where you were.</p>
        ) : (
          <p>
            A free TMDB key adds trending rows, picks for you, people’s pages and browsing by genre. It takes about two
            minutes. Without one, Krida finds titles through your addons and Cinemeta.
          </p>
        )}
      </Heading>
      {keep ? (
        <>
          <Saved>
            TMDB key saved, ending <Ending hint={connections?.tmdb ?? "…"} />
          </Saved>
          <Actions>
            <Button variant="ghost" onClick={() => setReplacing(true)}>
              Use another key
            </Button>
            <Button variant="primary" size="lg" icon={<ArrowRightIcon weight="bold" />} onClick={onNext}>
              Continue
            </Button>
          </Actions>
        </>
      ) : (
        <>
          <ol className="flex flex-col gap-4 text-subhead">
            <Instruction n={1}>
              <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer" className={link}>
                Make a free account on themoviedb.org
              </a>{" "}
              and confirm your email.
            </Instruction>
            <Instruction n={2}>
              Open{" "}
              <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className={link}>
                Settings → API
              </a>
              , choose Create, then Developer, accept the terms and fill in the short form. “Personal streaming app” is a fine description.
            </Instruction>
            <Instruction n={3}>
              Copy the <span className="font-medium text-fg">API Key</span>, the short one. Not the long API Read Access Token.
            </Instruction>
          </ol>
          <TmdbApiPage />
          <KeyField id="tmdb-key" label="TMDB API key" kind="tmdb" onSaved={onNext} />
          <Actions>
            {replacing ? (
              <Button variant="ghost" onClick={() => setReplacing(false)}>
                Keep the saved key
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => void skip()} loading={skipping}>
                Skip for now
              </Button>
            )}
          </Actions>
        </>
      )}
    </>
  );
}

function Instruction({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-white/8 text-body font-semibold text-fg tabular-nums">
        {n}
      </span>
      <span className="pt-0.5 text-fg-muted">{children}</span>
    </li>
  );
}

/**
 * The part of TMDB's Settings → API page that matters, drawn rather than captured (it shows only when signed in to
 * TMDB): two keys, and the short one is the one to copy.
 */
function TmdbApiPage() {
  return (
    <figure className="flex flex-col gap-3">
      <div aria-hidden className="flex flex-col gap-4 rounded-card bg-surface p-5 text-body text-fg-muted shadow-raised">
        <p className="font-semibold text-fg">API</p>
        <div className="flex flex-col gap-1.5 rounded-control bg-white/5 p-3 ring-2 ring-fg">
          <p className="font-semibold text-fg">API Key</p>
          <p className="truncate font-mono text-fg">3f2a••••••••••••••••••••••c81e</p>
        </div>
        <div className="flex flex-col gap-1.5 px-3 opacity-60">
          <p className="font-semibold">API Read Access Token</p>
          <p className="truncate font-mono">eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIzZjJh••••••••••••••••••••</p>
        </div>
      </div>
      <figcaption className="text-body text-fg-faint">What TMDB’s API page shows. Copy the short API Key; Krida tells you if you pasted the token.</figcaption>
    </figure>
  );
}

function DebridStep({ status, headingRef, onNext, onBack }: StepProps) {
  const { token } = useAuthed();
  const pass = useMutation(api.onboarding.pass);
  const connections = useQuery(api.accounts.connections, { token });
  const [service, setService] = useState<DebridService>(status.debrid?.service ?? "torbox");
  const [replacing, setReplacing] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const saved = connections?.debrid && !replacing ? connections.debrid : null;
  const chosen = DEBRID_SERVICES.find((s) => s.value === service)!;
  const skip = async () => {
    setSkipping(true);
    try {
      await pass({ token, step: "debrid" });
      onNext();
    } finally {
      setSkipping(false);
    }
  };
  return (
    <>
      <Heading headingRef={headingRef} title="Pick your debrid service">
        <p>Krida hosts nothing. A debrid service fetches what your addons find and turns it into something you can play, with your own account.</p>
      </Heading>
      {saved ? (
        <>
          <Saved>
            {debridName(saved.service)} key saved, ending <Ending hint={saved.hint} />
          </Saved>
          {saved.service !== "torbox" && <NeedsTorBoxNote />}
          <Actions onBack={onBack}>
            <Button variant="ghost" onClick={() => setReplacing(true)}>
              Use another service
            </Button>
            <Button variant="primary" size="lg" icon={<ArrowRightIcon weight="bold" />} onClick={() => void skip()} loading={skipping}>
              Continue
            </Button>
          </Actions>
        </>
      ) : (
        <>
          <div role="radiogroup" aria-label="Debrid service" className="flex flex-col gap-2">
            <ServiceOption value="torbox" chosen={service} onChoose={setService} badge="Recommended">
              Plays everywhere: the browser, the installed web app, parties and the timeline’s preview pictures.
            </ServiceOption>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {DEBRID_SERVICES.filter((s) => s.value !== "torbox").map((s) => (
                <ServiceOption key={s.value} value={s.value} chosen={service} onChoose={setService} compact />
              ))}
            </div>
          </div>
          {service === "torbox" ? (
            <p className="text-body text-pretty text-fg-muted">
              No account yet?{" "}
              <a href={TORBOX_SIGNUP} target="_blank" rel="noreferrer" className={link}>
                Sign up for TorBox
              </a>
              , then copy your API key from{" "}
              <a href={chosen.keys} target="_blank" rel="noreferrer" className={link}>
                TorBox’s settings
              </a>
              .
            </p>
          ) : (
            <>
              <NeedsTorBoxNote />
              <p className="text-body text-fg-muted">
                <a href={chosen.keys} target="_blank" rel="noreferrer" className={cx(link, "inline-flex items-center gap-1")}>
                  Find your {chosen.name} key <ArrowSquareOutIcon aria-hidden />
                </a>
              </p>
            </>
          )}
          <KeyField key={service} id="debrid-key" label={`${chosen.name} API key`} kind="debrid" service={service} onSaved={onNext} />
          <Actions onBack={onBack}>
            {replacing ? (
              <Button variant="ghost" onClick={() => setReplacing(false)}>
                Keep the saved key
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => void skip()} loading={skipping}>
                Skip for now
              </Button>
            )}
          </Actions>
        </>
      )}
    </>
  );
}

/** What a service other than TorBox can't do, said before the key is pasted rather than when Play fails. */
function NeedsTorBoxNote() {
  return (
    <p className="rounded-card bg-white/5 p-4 text-body text-pretty text-fg-muted">
      Parties and timeline previews need TorBox, which turns any file into a stream a browser can play. With another
      service, the browser plays MP4 and WebM files itself; the rest play in Krida for Mac and Windows, or in an external
      player like VLC or Infuse.
    </p>
  );
}

function ServiceOption({
  value,
  chosen,
  onChoose,
  badge,
  compact,
  children,
}: {
  value: DebridService;
  chosen: DebridService;
  onChoose: (s: DebridService) => void;
  badge?: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  const on = value === chosen;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={() => onChoose(value)}
      className={cx(
        "press flex items-start gap-3 rounded-card text-left ring-1 ring-inset",
        compact ? "min-h-12 items-center px-4 py-2" : "p-4",
        on ? "bg-white/10 ring-fg/60" : "bg-surface ring-line hover:bg-raised",
      )}
    >
      <span aria-hidden className={cx("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ring-2 ring-inset", on ? "bg-fg ring-fg text-on-accent" : "ring-fg-faint", compact && "mt-0")}>
        {on && <CheckIcon weight="bold" className="text-[12px]" />}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 text-body font-medium text-fg">
          {debridName(value)}
          {badge && <span className="rounded-full bg-white/10 px-2 py-0.5 text-caption font-medium text-fg-muted">{badge}</span>}
        </span>
        {children && <span className="text-body text-pretty text-fg-muted">{children}</span>}
      </span>
    </button>
  );
}

function AddonsStep({ status, headingRef, onNext, onBack }: StepProps) {
  const { token } = useAuthed();
  const pass = useMutation(api.onboarding.pass);
  const addons = useQuery(api.addons.list, { token });
  const [busy, setBusy] = useState(false);
  const any = !!addons?.length;
  const finish = async () => {
    setBusy(true);
    try {
      await pass({ token, step: "addons" });
      onNext();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading headingRef={headingRef} title="Add where streams come from">
        <p>
          Krida plays what your Stremio addons find, and their catalogs become rows on Home.{" "}
          {status.debrid ? `Start with one already set up with your ${debridName(status.debrid.service)} key.` : "Paste an addon’s link, or bring your addons over from Stremio."}
        </p>
      </Heading>
      <Card>
        <Suggestions />
      </Card>
      {any && (
        <Card>
          <p className="text-body font-medium">Installed for this profile</p>
          <InstalledAddons />
        </Card>
      )}
      <Card>
        <InstallByLink quiet />
      </Card>
      <Card>
        <StremioImport />
      </Card>
      <Actions onBack={onBack}>
        {any ? (
          <Button variant="primary" size="lg" icon={<ArrowRightIcon weight="bold" />} loading={busy} onClick={() => void finish()}>
            Continue
          </Button>
        ) : (
          <Button variant="ghost" loading={busy} onClick={() => void finish()}>
            Skip for now
          </Button>
        )}
      </Actions>
    </>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4 rounded-sheet bg-surface p-5 shadow-raised">{children}</div>;
}

function ExtrasStep({ status, headingRef, onNext, onBack }: StepProps) {
  const { token } = useAuthed();
  const pass = useMutation(api.onboarding.pass);
  const connections = useQuery(api.accounts.connections, { token });
  const simkl = useQuery(api.simkl.enabled, {});
  const [busy, setBusy] = useState(false);
  const finish = async () => {
    setBusy(true);
    try {
      await pass({ token, step: "extras" });
      onNext();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Heading headingRef={headingRef} title="A few extras">
        <p>{simkl ? "Both are optional" : "It’s optional"}, and you can add {simkl ? "them" : "it"} later in Settings.</p>
      </Heading>
      <Card>
        <div className="flex flex-col gap-1">
          <p className="text-body font-medium">MDBList</p>
          <p className="text-body text-pretty text-fg-muted">
            Adds IMDb, Rotten Tomatoes, Metacritic and Letterboxd scores, age ratings and trailers to title pages.{" "}
            <a href="https://mdblist.com/preferences/" target="_blank" rel="noreferrer" className={link}>
              Get a free key on MDBList
            </a>
            .
          </p>
        </div>
        {status.mdblist ? (
          <Saved>
            MDBList key saved, ending <Ending hint={connections?.mdblist ?? "…"} />
          </Saved>
        ) : (
          <KeyField id="mdblist-key" label="MDBList API key" kind="mdblist" onSaved={() => {}} />
        )}
      </Card>
      {simkl && (
        <Card>
          <SimklConnection />
        </Card>
      )}
      <Actions onBack={onBack}>
        <Button variant="primary" size="lg" icon={<ArrowRightIcon weight="bold" />} loading={busy} onClick={() => void finish()}>
          Go to Home
        </Button>
      </Actions>
    </>
  );
}
