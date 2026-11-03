import { useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { SignIn } from "@clerk/react";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, LockSimpleIcon, PencilSimpleIcon, PlusIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { useSession } from "../../data/session";
import { useAccount } from "../../data/account";
import { Avatar, Button, cx, IconButton, Spinner, Toggle } from "../../ui/ui";
import { Wordmark } from "../../ui/wordmark";
import { isPreviewBuild, onProduction, switchBackend } from "../../data/backend";
import { errorMessage } from "../play";

type Listed = { _id: Id<"profiles">; name: string; hue: number; hasPin: boolean };

/** The colours a profile can take: its avatar's gradient, from one hue. */
const HUES = [20, 60, 145, 175, 205, 250, 290, 330];
const MAX_PROFILES = 8;

/**
 * Signed out: sign in with Google or a code by email. Signed in to the account: who's watching, Netflix style, where
 * profiles are also made, renamed, recoloured and deleted. Choosing one (its PIN, when it has one) opens Krida.
 */
export function ProfileGate() {
  const account = useAccount();
  const [hue, setHue] = useState<number | undefined>();
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-6 py-16">
      <Glow hue={hue} />
      <div className="relative flex w-full max-w-xl flex-col items-center gap-12">
        <Wordmark className="text-display" />
        {!account.loaded ? (
          <Spinner className="text-fg-faint" />
        ) : account.signedIn ? (
          <Picker onHue={setHue} />
        ) : (
          <SignInStep />
        )}
        {isPreviewBuild && <BackendSwitch />}
      </div>
    </main>
  );
}

function SignInStep() {
  const { enabled } = useAccount();
  if (!enabled)
    return (
      <p className="max-w-[44ch] text-center text-body text-fg-muted">
        This build has no sign-in set up (VITE_CLERK_PUBLISHABLE_KEY). QA profiles sign in at <code>/qa</code>.
      </p>
    );
  return (
    <div className="rise-in flex flex-col items-center gap-6">
      <p className="max-w-[36ch] text-center text-subhead text-fg-muted">Sign in or make an account to start watching.</p>
      <SignIn
        routing="hash"
        withSignUp
        fallbackRedirectUrl={location.pathname === "/sign-in" ? "/" : location.pathname + location.search}
        appearance={{
          variables: {
            colorBackground: "var(--color-surface)",
            colorForeground: "var(--color-fg)",
            colorMutedForeground: "var(--color-fg-muted)",
            colorPrimary: "var(--color-accent)",
            colorPrimaryForeground: "var(--color-on-accent)",
            colorInput: "var(--color-raised)",
            colorInputForeground: "var(--color-fg)",
            colorNeutral: "var(--color-fg)",
            colorDanger: "var(--color-danger)",
            borderRadius: "14px",
            fontFamily: "inherit",
          },
        }}
      />
      <a href="/" className="press rounded-full px-3 py-2 text-body text-fg-muted hover:text-fg">
        What’s Krida?
      </a>
    </div>
  );
}

type Step = { kind: "pick" } | { kind: "manage" } | { kind: "add" } | { kind: "pin"; profile: Listed; then: "choose" | "edit" } | { kind: "edit"; profile: Listed; pin?: string };

function Picker({ onHue }: { onHue: (hue: number | undefined) => void }) {
  const { isAuthenticated } = useConvexAuth();
  const ensure = useMutation(api.profiles.ensureAccount);
  const [ready, setReady] = useState(false);
  // The account is made on the first sign-in, before anything reads it.
  useEffect(() => {
    if (!isAuthenticated) return;
    let live = true;
    void ensure({}).then(() => live && setReady(true), () => live && setReady(true));
    return () => {
      live = false;
    };
  }, [isAuthenticated, ensure]);
  const profiles = useQuery(api.profiles.list, ready ? {} : "skip") as Listed[] | undefined;
  const { setToken } = useSession();
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const focused = step.kind === "pin" || step.kind === "edit" ? step.profile.hue : undefined;
  useEffect(() => onHue(focused), [focused, onHue]);

  if (profiles === undefined) return <Spinner className="text-fg-faint" />;
  const back = () => setStep({ kind: "pick" });
  if (profiles.length === 0 || step.kind === "add")
    return (
      <ProfileForm
        key="add"
        first={profiles.length === 0}
        taken={profiles.map((p) => p.hue)}
        onDone={back}
        onCancel={profiles.length ? back : undefined}
        onFirst={(token) => setToken(token)}
      />
    );
  if (step.kind === "pin") return <PinStep key={step.profile._id} profile={step.profile} then={step.then} onBack={back} onEdit={(pin) => setStep({ kind: "edit", profile: step.profile, pin })} />;
  if (step.kind === "edit") {
    const profile = profiles.find((p) => p._id === step.profile._id);
    if (!profile) return <Spinner className="text-fg-faint" />;
    return <ProfileForm key={profile._id} profile={profile} pin={step.pin} taken={[]} onDone={() => setStep({ kind: "manage" })} onCancel={() => setStep({ kind: "manage" })} />;
  }
  return <Profiles profiles={profiles} managing={step.kind === "manage"} onStep={setStep} />;
}

function Profiles({ profiles, managing, onStep }: { profiles: Listed[]; managing: boolean; onStep: (step: Step) => void }) {
  const { setToken, signOutAccount } = useSession();
  const choose = useMutation(api.profiles.choose);
  const [busy, setBusy] = useState<Id<"profiles"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (p: Listed) => {
    if (managing) return onStep(p.hasPin ? { kind: "pin", profile: p, then: "edit" } : { kind: "edit", profile: p });
    if (p.hasPin) return onStep({ kind: "pin", profile: p, then: "choose" });
    setBusy(p._id);
    setError(null);
    try {
      const result = await choose({ profileId: p._id });
      if (result.ok) setToken(result.token);
      else setError(result.message);
    } catch (err) {
      setError(errorMessage(err, "Couldn't open that profile. Try again."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col items-center gap-8">
      <h1 className="text-title font-medium text-fg-muted">{managing ? "Manage profiles" : "Who’s watching?"}</h1>
      <ul className="flex flex-wrap justify-center gap-6 sm:gap-8">
        {profiles.map((p, i) => (
          <li key={p._id} className="rise-in" style={{ ["--i" as string]: i }}>
            <button
              onClick={() => void pick(p)}
              aria-label={managing ? `Edit ${p.name}` : p.hasPin ? `${p.name}, locked with a PIN` : p.name}
              className="group press flex w-28 flex-col items-center gap-3 rounded-sheet p-2"
            >
              <span className="relative">
                <Avatar
                  name={p.name}
                  hue={p.hue}
                  size={104}
                  className={cx("ring-0 ring-fg/80 ring-offset-4 ring-offset-page group-hover:ring-2", managing && "opacity-60")}
                />
                {managing && (
                  <span className="absolute inset-0 grid place-items-center text-[28px] text-fg">
                    <PencilSimpleIcon weight="bold" />
                  </span>
                )}
                {busy === p._id && (
                  <span className="absolute inset-0 grid place-items-center rounded-full bg-black/40">
                    <Spinner className="text-fg" />
                  </span>
                )}
              </span>
              <span className="flex max-w-full items-center gap-1.5 text-subhead text-fg-muted group-hover:text-fg">
                <span className="truncate">{p.name}</span>
                {p.hasPin && <LockSimpleIcon aria-hidden className="shrink-0 text-fg-faint" />}
              </span>
            </button>
          </li>
        ))}
        {!managing && profiles.length < MAX_PROFILES && (
          <li className="rise-in" style={{ ["--i" as string]: profiles.length }}>
            <button onClick={() => onStep({ kind: "add" })} className="group press flex w-28 flex-col items-center gap-3 rounded-sheet p-2">
              <span className="grid size-[104px] place-items-center rounded-full bg-white/6 text-[32px] text-fg-muted ring-1 ring-line ring-inset group-hover:bg-white/10 group-hover:text-fg">
                <PlusIcon />
              </span>
              <span className="text-subhead text-fg-muted group-hover:text-fg">Add profile</span>
            </button>
          </li>
        )}
      </ul>
      <p role="alert" className="min-h-5 text-body text-danger">
        {error}
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        {managing ? (
          <Button variant="primary" icon={<CheckIcon weight="bold" />} onClick={() => onStep({ kind: "pick" })}>
            Done
          </Button>
        ) : (
          <Button icon={<PencilSimpleIcon />} onClick={() => onStep({ kind: "manage" })}>
            Manage profiles
          </Button>
        )}
        <Button variant="ghost" onClick={() => void signOutAccount()}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

/** A profile's PIN: four digits, sent as soon as the fourth is typed. */
function PinStep({
  profile,
  then,
  onBack,
  onEdit,
}: {
  profile: Listed;
  then: "choose" | "edit";
  onBack: () => void;
  onEdit: (pin: string) => void;
}) {
  const { setToken } = useSession();
  const choose = useMutation(api.profiles.choose);
  const edit = useMutation(api.profiles.edit);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (value: string) => {
    if (busy || value.length !== 4) return;
    setBusy(true);
    setError(null);
    try {
      // Editing checks the PIN with an edit that changes nothing, so a wrong one counts like any other try.
      const wrong = (message: string) => {
        setError(message);
        setPin("");
        input.current?.focus();
      };
      if (then === "choose") {
        const result = await choose({ profileId: profile._id, pin: value });
        if (result.ok) setToken(result.token);
        else wrong(result.message);
      } else {
        const result = await edit({ profileId: profile._id, pin: value });
        if (result.ok) onEdit(value);
        else wrong(result.message);
      }
    } catch (err) {
      setError(errorMessage(err, "Couldn't check the PIN. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit(pin);
      }}
      className="rise-in flex w-full flex-col items-center gap-6"
    >
      <div className="flex flex-col items-center gap-3">
        <Avatar name={profile.name} hue={profile.hue} size={96} />
        <h1 className="text-title font-semibold">{profile.name}</h1>
        <p className="text-body text-fg-muted">{then === "choose" ? "Enter the PIN for this profile." : "Enter the PIN to edit this profile."}</p>
      </div>
      <div className="flex w-full max-w-60 flex-col gap-2">
        <label htmlFor="pin" className="sr-only">
          PIN
        </label>
        <div className="flex items-center gap-2">
          <input
            ref={input}
            id="pin"
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={pin}
            onChange={(e) => {
              const next = e.target.value.replace(/\D/g, "").slice(0, 4);
              setPin(next);
              if (error) setError(null);
              if (next.length === 4) void submit(next);
            }}
            placeholder="••••"
            aria-invalid={!!error}
            aria-describedby="pin-error"
            className={cx(
              "h-12 min-w-0 flex-1 rounded-full fill-quiet bg-white/6 px-5 text-center text-title tracking-[0.5em] text-fg ring-1 ring-inset placeholder:text-fg-faint",
              "outline-2 outline-transparent hover:bg-white/8 focus:bg-white/8",
              error ? "ring-danger/70" : "ring-line focus:ring-white/25",
            )}
          />
          <IconButton type="submit" label="Continue" size="lg" className="bg-accent text-on-accent hover:bg-accent-hover" aria-busy={busy || undefined}>
            {busy ? <Spinner /> : <ArrowRightIcon weight="bold" />}
          </IconButton>
        </div>
        <p id="pin-error" role="alert" className="h-5 px-2 text-center text-body text-danger">
          {error}
        </p>
      </div>
      <Button type="button" variant="ghost" icon={<ArrowLeftIcon />} onClick={onBack}>
        Switch profile
      </Button>
    </form>
  );
}

/** Making a profile (with an optional PIN), or editing one: its name and colour, or deleting it. */
function ProfileForm({
  profile,
  pin,
  first,
  taken,
  onDone,
  onCancel,
  onFirst,
}: {
  profile?: Listed;
  pin?: string;
  first?: boolean;
  taken: number[];
  onDone: () => void;
  onCancel?: () => void;
  /** The account's first profile opens as soon as it's made, with the session token choosing it gave. */
  onFirst?: (token: string) => void;
}) {
  const { firstName } = useAccount();
  const create = useMutation(api.profiles.create);
  const choose = useMutation(api.profiles.choose);
  const edit = useMutation(api.profiles.edit);
  const remove = useMutation(api.profiles.deleteProfile);
  const [name, setName] = useState(profile?.name ?? (first ? (firstName ?? "") : ""));
  const [hue, setHue] = useState(profile?.hue ?? HUES.find((h) => !taken.includes(h)) ?? HUES[0]);
  const [lock, setLock] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [confirming, setConfirming] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name");
    if (lock && !/^\d{4}$/.test(newPin)) return setError("A PIN is 4 digits");
    setBusy("save");
    setError(null);
    try {
      if (profile) {
        const result = await edit({ profileId: profile._id, name, hue, pin });
        if (!result.ok) return setError(result.message);
      } else {
        const profileId = await create({ name, hue, pin: lock ? newPin : undefined });
        // The first one goes straight on to setting up (docs/models/Onboarding.tla, MakeProfile).
        if (first && onFirst) {
          const chosen = await choose({ profileId, pin: lock ? newPin : undefined });
          if (chosen.ok) return onFirst(chosen.token);
        }
      }
      onDone();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the profile. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const destroy = async () => {
    if (!profile) return;
    setBusy("delete");
    try {
      const result = await remove({ profileId: profile._id, pin });
      if (result.ok) onDone();
      else setError(result.message);
    } catch (err) {
      setError(errorMessage(err, "Couldn't delete the profile. Try again."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={save} className="rise-in flex w-full max-w-sm flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Avatar name={name.trim() || "?"} hue={hue} size={96} />
        <h1 className="text-title font-semibold">{profile ? "Edit profile" : first ? "Make your profile" : "Add a profile"}</h1>
        {first && <p className="max-w-[34ch] text-body text-fg-muted">Everyone who watches gets a profile: their own Home, history and picks. You can add up to 8.</p>}
      </div>
      <div className="flex w-full flex-col gap-2">
        <label htmlFor="profile-name" className="px-1 text-body font-medium text-fg-muted">
          Name
        </label>
        <input
          id="profile-name"
          value={name}
          maxLength={24}
          autoComplete="nickname"
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          className="h-12 w-full rounded-full fill-quiet bg-white/6 px-5 text-subhead text-fg ring-1 ring-line ring-inset placeholder:text-fg-faint hover:bg-white/8 focus:bg-white/8 focus:ring-white/25 focus-visible:outline-transparent"
        />
      </div>
      <fieldset className="flex w-full flex-col gap-2">
        <legend className="mb-2 px-1 text-body font-medium text-fg-muted">Colour</legend>
        <div role="radiogroup" aria-label="Colour" className="flex justify-center gap-1.5">
          {HUES.map((h, i) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={hue === h}
              aria-label={`Colour ${i + 1}`}
              onClick={() => setHue(h)}
              className={cx("press grid size-11 place-items-center rounded-full", hue === h && "ring-2 ring-fg ring-inset")}
            >
              <span
                aria-hidden
                className="size-8 rounded-full"
                style={{ background: `linear-gradient(140deg in oklch, oklch(0.72 0.13 ${h}), oklch(0.5 0.14 ${h + 30}))` }}
              />
            </button>
          ))}
        </div>
      </fieldset>
      {!profile && (
        <div className="flex w-full flex-col gap-3">
          <div className="flex min-h-11 items-center justify-between gap-3 px-1">
            <span className="text-body">Lock with a 4-digit PIN</span>
            <Toggle checked={lock} onChange={setLock} label="Lock with a 4-digit PIN" />
          </div>
          {lock && (
            <input
              aria-label="PIN"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="••••"
              className="h-12 w-40 self-center rounded-full fill-quiet bg-white/6 px-5 text-center text-title tracking-[0.5em] text-fg ring-1 ring-line ring-inset placeholder:text-fg-faint focus:ring-white/25"
            />
          )}
        </div>
      )}
      <p role="alert" className="min-h-5 text-center text-body text-danger">
        {error}
      </p>
      <div className="flex w-full flex-col items-center gap-3">
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy === "save"}>
          {profile ? "Save" : first ? "Continue" : "Add profile"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {profile &&
          (confirming ? (
            <div className="flex flex-col items-center gap-3 rounded-sheet bg-surface p-4 text-center shadow-raised">
              <p className="max-w-[34ch] text-body text-fg-muted">
                Delete {profile.name}? Their history, ratings and Plan to watch go with it, and any party they host ends.
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="danger" loading={busy === "delete"} onClick={() => void destroy()}>
                  Delete {profile.name}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="ghost" className="text-danger" onClick={() => setConfirming(true)}>
              Delete profile
            </Button>
          ))}
      </div>
    </form>
  );
}

/** Branch previews only: try the branch with throwaway preview profiles, or with your real account. */
function BackendSwitch() {
  return (
    <div className="flex w-full flex-col items-center gap-3 text-center">
      <div role="radiogroup" aria-label="Which account to use in this preview" className="flex rounded-full bg-surface p-1 shadow-raised">
        {(
          [
            ["preview", "Preview profiles"],
            ["production", "My real account"],
          ] as const
        ).map(([value, label]) => {
          const on = (value === "production") === onProduction;
          return (
            <button
              key={value}
              role="radio"
              aria-checked={on}
              onClick={() => !on && switchBackend(value)}
              className={cx("press h-10 rounded-full px-4 text-body font-medium", on ? "lens text-fg" : "text-fg-muted hover:text-fg")}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p className="max-w-[44ch] text-caption text-fg-faint">
        {onProduction
          ? "This branch, on your real Krida: ratings, Plan to watch and what you watch are saved for real. If the branch changes the backend, use preview profiles."
          : "This branch, with its own throwaway profiles and data. Switch to try it on your real account."}
      </p>
    </div>
  );
}

/** A soft wash of light behind the gate: neutral until a profile is chosen, then that profile's color. */
function Glow({ hue }: { hue?: number }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 transition-[background] duration-500"
      style={{
        background: `radial-gradient(60% 50% at 50% 0%, ${hue === undefined ? "oklch(0.4 0.01 60 / 0.3)" : `oklch(0.4 0.08 ${hue} / 0.35)`}, transparent 70%)`,
      }}
    />
  );
}
