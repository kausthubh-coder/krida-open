import { Link, Navigate, useParams } from "react-router";
import { useQuery } from "convex-helpers/react/cache/hooks";
import {
  CaretLeftIcon,
  CaretRightIcon,
  DesktopIcon,
  DeviceMobileIcon,
  ExportIcon,
  EyeSlashIcon,
  FilmStripIcon,
  HeartIcon,
  HouseIcon,
  LockIcon,
  MonitorIcon,
  PlugsConnectedIcon,
  PuzzlePieceIcon,
  SignOutIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed, useSession } from "../../data/session";
import { useUpdateProfile } from "../../data/profile";
import { LANGUAGE_CHOICES } from "../../ui/format";
import { Avatar, Button, cx } from "../../ui/ui";
import { useMedia } from "../../ui/media";
import { useBubbleGlass } from "../../ui/surfaces";
import { canFullscreen, toggleFullscreen, useFullscreen } from "../../ui/fullscreen";
import { useInstall } from "../../ui/install";
import { useAppUpdate } from "../../ui/appUpdate";
import { useOpenFullscreen } from "../../data/desktop";
import { Field, Group, SelectRow, Switch } from "./settingsParts";
import { SourceFilterField, SubtitleLook } from "./playbackSettings";
import { NameField, PinForm } from "./profileFields";
import { useAccount } from "../../data/account";
import { SimklConnection } from "./simklSettings";
import { Ratings } from "./ratingsSettings";
import { HomeDisplay, HomeRows } from "./homeRowsSettings";
import { AppSettings } from "./appSettings";
import { ConnectionsSection } from "./connectionsSettings";
import { AddonsSection } from "./addonsSettings";
import { useAddons } from "../../data/addons";
import { useConnections } from "../../data/keys";

const HUES: { hue: number; name: string }[] = [
  { hue: 28, name: "Orange" },
  { hue: 60, name: "Amber" },
  { hue: 145, name: "Green" },
  { hue: 205, name: "Teal" },
  { hue: 255, name: "Blue" },
  { hue: 300, name: "Violet" },
  { hue: 340, name: "Pink" },
];

/** Krida on the home screen, opening full screen like an app. Gone once it's installed, or where it can't be. */
function InstallApp() {
  const { state, install } = useInstall();
  if (state === "installed" || state === "unavailable") return null;
  return (
    <div className="flex min-h-12 items-center justify-between gap-4">
      <span>
        <span className="block text-body font-medium">Install Krida</span>
        <span className="block text-body text-fg-faint">
          {state === "ios" ? (
            <>
              In Safari, tap Share <ExportIcon aria-label="(the square with an arrow)" className="inline -translate-y-px" />, then
              Add to Home Screen. Krida opens full screen, like an app.
            </>
          ) : (
            "On your home screen, opening full screen like an app."
          )}
        </span>
      </span>
      {state === "prompt" && (
        <Button variant="primary" onClick={() => void install()}>
          Install
        </Button>
      )}
    </div>
  );
}

const AUTO_SETTINGS = [
  { key: "skipIntro", label: "Skip intros", hint: "Jumps past opening titles, with a moment to undo." },
  { key: "skipRecap", label: "Skip recaps", hint: "Jumps past “Previously on…”." },
  { key: "autoNext", label: "Play next episode", hint: "Starts the next one 10 seconds into the credits." },
] as const;

function ProfileSection() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  return (
    <Group>
      <NameField key={me.name} />
      <Field label="Colour">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Profile colour">
          {HUES.map(({ hue: h, name }) => (
            <button
              key={h}
              role="radio"
              aria-checked={me.hue === h}
              aria-label={name}
              onClick={() => void update({ token, hue: h })}
              className={cx(
                "press size-9 rounded-full ring-offset-2 ring-offset-surface",
                me.hue === h ? "ring-2 ring-fg" : "hover:ring-2 hover:ring-fg-faint",
              )}
              style={{ background: `linear-gradient(140deg in oklch, oklch(0.72 0.13 ${h}), oklch(0.5 0.14 ${h + 30}))` }}
            />
          ))}
        </div>
      </Field>
    </Group>
  );
}

function PlaybackSection() {
  return (
    <>
      <PlaybackGroup />
      <h2 className="mt-10 mb-3 text-subhead font-semibold">Sources</h2>
      <SourcesSection />
      <h2 className="mt-10 mb-3 text-subhead font-semibold">How subtitles look</h2>
      <Group>
        <SubtitleLook />
      </Group>
    </>
  );
}

function PlaybackGroup() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  return (
    <Group>
      <SelectRow
        id="audioLang"
        label="Audio language"
        hint="Picked automatically when a file has it."
        value={me.prefs.audioLang}
        onChange={(v) => void update({ token, prefsPatch: { audioLang: v } })}
        options={LANGUAGE_CHOICES.map((l) => ({ value: l.code, label: l.name }))}
      />
      <SelectRow
        id="subLang"
        label="Subtitles"
        hint="Turned on automatically in this language."
        value={me.prefs.subLang ?? ""}
        onChange={(v) => void update({ token, prefsPatch: { subLang: v || null } })}
        options={[{ value: "", label: "Off" }, ...LANGUAGE_CHOICES.map((l) => ({ value: l.code, label: l.name }))]}
      />
      {me.prefs.subLang && (
        <SelectRow
          id="subLang2"
          label="If there are none, use"
          hint="A second subtitle language, for when the first has none."
          value={me.prefs.subLang2 ?? ""}
          onChange={(v) => void update({ token, prefsPatch: { subLang2: v || null } })}
          options={[
            { value: "", label: "No subtitles" },
            ...LANGUAGE_CHOICES.filter((l) => l.code !== me.prefs.subLang).map((l) => ({ value: l.code, label: l.name })),
          ]}
        />
      )}
      {AUTO_SETTINGS.map(({ key, label, hint }) => (
        <Switch
          key={key}
          label={label}
          hint={hint}
          checked={me.prefs[key] !== false}
          onChange={(on) => void update({ token, prefsPatch: { [key]: on } })}
        />
      ))}
    </Group>
  );
}

/** Which sources Play starts, and which the list shows. */
function SourcesSection() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  return (
    <Group>
      <Switch
        label="Reuse the last source"
        hint="A show’s next episode plays the same kind of file as the last one you watched (its release group and quality) when it’s listed."
        checked={!!me.prefs.reuseSource}
        onChange={(on) => void update({ token, prefsPatch: { reuseSource: on } })}
      />
      <SourceFilterField />
    </Group>
  );
}

function TasteSection() {
  // Simkl is offered only where this Krida has its own Simkl app (SIMKL_CLIENT_ID on Convex).
  const simkl = useQuery(api.simkl.enabled, {});
  return (
    <Group>
      {simkl && <SimklConnection />}
      <Ratings />
    </Group>
  );
}

function HomeSection() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  return (
    <>
      <Group>
        <Switch
          label="Play trailers on Home"
          hint="Muted, behind the banner and on a poster you rest on."
          checked={me.prefs.trailers !== false}
          onChange={(trailers) => void update({ token, prefsPatch: { trailers } })}
        />
        <HomeDisplay />
      </Group>
      <h2 className="mt-10 mb-3 text-subhead font-semibold">Continue watching</h2>
      <Group>
        <SelectRow
          id="nextUpFrom"
          label="After an episode, go on from"
          hint="Which episode a show’s next one follows, if you watched an earlier one again."
          value={me.prefs.nextUpFrom ?? "last"}
          onChange={(v) => void update({ token, prefsPatch: { nextUpFrom: v === "furthest" ? "furthest" : null } })}
          options={[
            { value: "last", label: "The last one watched" },
            { value: "furthest", label: "The furthest one" },
          ]}
        />
        <SelectRow
          id="upcoming"
          label="Episodes not out yet"
          hint="When a show’s next episode hasn’t come out."
          value={me.prefs.upcoming ?? "keep"}
          onChange={(v) => void update({ token, prefsPatch: { upcoming: v === "row" || v === "hide" ? v : null } })}
          options={[
            { value: "keep", label: "Keep in Continue watching" },
            { value: "row", label: "Show in Coming up" },
            { value: "hide", label: "Leave out" },
          ]}
        />
        <Switch
          label="Blur unwatched episodes"
          hint="Stills and descriptions of episodes you haven’t seen: on title pages, and in the player’s episodes and Up next."
          checked={!!me.prefs.blurUnwatched}
          onChange={(on) => void update({ token, prefsPatch: { blurUnwatched: on } })}
        />
      </Group>
      <h2 className="mt-10 mb-3 text-subhead font-semibold">Rows</h2>
      <Group>
        <HomeRows />
      </Group>
    </>
  );
}

function DisplaySection() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  const [bubbles, setBubbles] = useBubbleGlass();
  const fullscreen = useFullscreen();
  const openFullscreen = useOpenFullscreen();
  return (
    <Group>
      <InstallApp />
      <Switch
        label="Sounds"
        hint="Quiet cues for invites, people joining, messages and Up next. Never during playback controls."
        checked={me.prefs.sounds}
        onChange={(sounds) => void update({ token, prefsPatch: { sounds } })}
      />
      {/* Kept on this device, not the profile: it's about the screen and the machine. */}
      <Switch
        label="Bubble glass"
        badge="Beta"
        hint="Buttons, bars and menus become soap bubbles that wobble and bend the picture behind them. Off, they're solid. Just on this device."
        checked={bubbles}
        onChange={setBubbles}
      />
      {canFullscreen() && (
        <Switch
          label="Full screen"
          hint="Krida fills the screen, without the browser's bars, on every page. Press F to switch it, Esc to leave."
          checked={fullscreen}
          onChange={() => toggleFullscreen()}
        />
      )}
      {openFullscreen && (
        <Switch
          label="Open in full screen"
          hint="Krida fills the screen as soon as it opens. Esc still leaves full screen."
          checked={openFullscreen[0]}
          onChange={openFullscreen[1]}
        />
      )}
    </Group>
  );
}

function PrivacySection() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  const others = (useQuery(api.profiles.list, { token }) ?? []).filter((p) => !p.temporary && p._id !== me._id);
  const friend = others.length === 1 ? others[0].name : "Others";
  return (
    <Group>
      <Switch
        label="Private mode"
        hint={`${friend} won’t see what you watch while it’s on: not on their Home, not under the party button. Parties you start still reach them.`}
        checked={!!me.prefs.private}
        onChange={(on) => void update({ token, prefsPatch: { private: on } })}
      />
    </Group>
  );
}

function AccountSection() {
  const { me, signOutAccount } = useSession();
  const { email } = useAccount();
  return (
    <Group>
      {me && !me.temporary && <PinForm />}
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-4">
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium">Your account</span>
          <span className="block text-body text-fg-faint">{email ? `Signed in as ${email}.` : "Signed in."} Signing out ends every profile on this device.</span>
        </span>
        <Button variant="ghost" className="text-danger" onClick={() => void signOutAccount()}>
          Sign out
        </Button>
      </div>
    </Group>
  );
}

type SectionDef = { id: string; title: string; lede: string; icon: React.ReactNode; body: React.ReactNode; value?: string };

/** The sections, in the order the list shows them. The app's own appears only in Krida's apps. */
function useSections(): SectionDef[][] {
  const { me } = useAuthed();
  const app = useAppUpdate();
  const connections = useConnections();
  const addons = useAddons();
  const appSection: SectionDef[] = app
    ? [
        {
          id: "app",
          title: app.name,
          lede: "This app's version and updates, and how it shows the picture.",
          icon: app.name === "Krida for Android" ? <DeviceMobileIcon /> : <DesktopIcon />,
          body: <AppSettings />,
          value: app.status.state === "ready" ? "Update ready" : app.version,
        },
      ]
    : [];
  return [
    [
      { id: "profile", title: "Profile", lede: "Your name and colour, as your friends see them.", icon: <UserIcon />, body: <ProfileSection /> },
      { id: "playback", title: "Playback", lede: "How films and episodes start, which sources they play, and how subtitles look.", icon: <FilmStripIcon />, body: <PlaybackSection /> },
      { id: "taste", title: "Your taste", lede: "Where your picks come from: your ratings, and Simkl where it’s set up.", icon: <HeartIcon />, body: <TasteSection /> },
      { id: "home", title: "Home", lede: "What Home shows: its banner, and its rows’ order and names.", icon: <HouseIcon />, body: <HomeSection /> },
      {
        id: "addons",
        title: "Addons",
        lede: "Your Stremio addons: where Play finds sources, and the catalogs Home and Search show. Each profile has its own.",
        icon: <PuzzlePieceIcon />,
        body: <AddonsSection />,
        value: addons === undefined ? undefined : addons.length === 0 ? "Add one" : `${addons.filter((a) => a.enabled).length} on`,
      },
    ],
    [
      // A temporary guest has no account, so no keys.
      ...(connections === null
        ? []
        : [{
            id: "connections",
            title: "Connections",
            lede: "Your account’s keys, shared by every profile in it. Krida checks each one with its service as you paste it.",
            icon: <PlugsConnectedIcon />,
            body: <ConnectionsSection />,
            value: connections && !connections.tmdb ? "Add TMDB key" : undefined,
          }]),
      { id: "display", title: "Display and sound", lede: "How Krida looks and sounds on this device.", icon: <MonitorIcon />, body: <DisplaySection /> },
      ...appSection,
      {
        id: "privacy",
        title: "Privacy",
        lede: "What your friends see of what you watch.",
        icon: <EyeSlashIcon />,
        body: <PrivacySection />,
        value: me.prefs.private ? "On" : "Off",
      },
      { id: "account", title: "Account", lede: "This profile's PIN, and signing your account out of this device.", icon: <LockIcon />, body: <AccountSection />, value: me.hasPin ? "PIN on" : undefined },
    ],
  ];
}

const DESKTOP = "(min-width: 48rem)";

/**
 * Settings as a list of sections, like a phone's Settings app. A computer keeps the list at the left and shows one
 * section beside it; a phone shows the list, and a section on its own page with a way back to it.
 */
export function SettingsPage() {
  // Bubble glass bounces buttons, too much for a row this wide, so its rows give gently.
  const row = "press-soft";
  const { me } = useAuthed();
  const { signOutAccount: signOut } = useSession();
  const { section } = useParams();
  const wide = useMedia(DESKTOP);
  const groups = useSections();
  const all = groups.flat();
  // Simkl sends people back to #connections, from before Settings had sections.
  if (!section && location.hash === "#connections") return <Navigate to="/settings/taste" replace />;
  const open = all.find((s) => s.id === section) ?? (wide && !section ? all[0] : undefined);
  if (section && !open) return <Navigate to="/settings" replace />;

  const who = (
    <div className="flex items-center gap-3">
      <Avatar name={me.name} hue={me.hue} size={wide ? 40 : 52} />
      <div className="min-w-0">
        <p className={cx("truncate font-semibold", wide ? "text-subhead" : "font-display text-display")}>{me.name}</p>
        <p className="text-body text-fg-faint">Settings</p>
      </div>
    </div>
  );

  if (!wide && !open)
    return (
      <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 pt-20 pb-32">
        <h1 className="sr-only">Settings</h1>
        {who}
        {groups.map((g, i) => (
          <nav key={i} aria-label={i === 0 ? "Your settings" : "This device and account"} className="flex flex-col divide-y divide-line rounded-sheet bg-surface shadow-raised">
            {g.map((s) => (
              <Link key={s.id} to={`/settings/${s.id}`} className={cx(row, "flex min-h-14 items-center gap-4 px-5 text-subhead")}>
                <span className="text-[20px] text-fg-muted">{s.icon}</span>
                <span className="flex-1 font-medium">{s.title}</span>
                {s.value && <span className="text-body text-fg-faint">{s.value}</span>}
                <CaretRightIcon aria-hidden className="text-fg-faint" />
              </Link>
            ))}
          </nav>
        ))}
        <button onClick={() => void signOut()} className={cx(row, "flex min-h-14 items-center gap-4 rounded-sheet bg-surface px-5 text-subhead font-medium text-danger shadow-raised")}>
          <SignOutIcon className="text-[20px]" />
          Sign out
        </button>
      </main>
    );

  const body = open && (
    <section aria-labelledby="settings-title" className="min-w-0">
      {!wide && (
        <Link to="/settings" className="-ml-2 mb-4 inline-flex h-11 items-center gap-1 rounded-full pr-3 pl-2 text-body font-medium text-fg-muted hover:text-fg">
          <CaretLeftIcon />
          Settings
        </Link>
      )}
      <h1 id="settings-title" className="font-display text-display font-semibold">
        {open.title}
      </h1>
      <p className="mt-1 mb-6 text-body text-fg-muted">{open.lede}</p>
      {open.body}
    </section>
  );

  if (!wide) return <main className="mx-auto w-full max-w-xl px-4 pt-18 pb-32">{body}</main>;

  return (
    <main className="mx-auto grid w-full max-w-5xl grid-cols-[15rem_minmax(0,1fr)] gap-14 px-8 pt-24 pb-32">
      {/* Taller than a short window (a sideways phone), it scrolls on its own, so Account and Sign out stay reachable. */}
      <nav aria-label="Settings" className="sticky top-24 flex max-h-[calc(100dvh-6rem-var(--inset-bottom))] flex-col gap-1 self-start overflow-y-auto overscroll-contain scrollbar-none">
        <div className="px-3 pb-5">{who}</div>
        {groups.map((g, i) => (
          <div key={i} className={cx("flex flex-col gap-1", i > 0 && "mt-3 border-t border-line pt-3")}>
            {g.map((s) => (
              <Link
                key={s.id}
                to={`/settings/${s.id}`}
                replace
                aria-current={s === open ? "page" : undefined}
                className={cx(
                  "flex h-10 items-center gap-3 rounded-[12px] px-3 text-body font-medium",
                  s === open ? "fill-raised bg-white/8 text-fg" : "fill-hover text-fg-muted hover:bg-white/5 hover:text-fg",
                )}
              >
                <span className="text-[18px]">{s.icon}</span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </Link>
            ))}
          </div>
        ))}
        <div className="mt-3 border-t border-line pt-3" />
        <button
          onClick={() => void signOut()}
          className="flex h-10 items-center gap-3 rounded-[12px] px-3 text-body font-medium text-danger hover:bg-danger/10"
        >
          <SignOutIcon className="text-[18px]" />
          Sign out
        </button>
      </nav>
      {body}
    </main>
  );
}
