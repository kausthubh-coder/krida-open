import { useEffect, type ReactNode } from "react";
import {
  AndroidLogoIcon,
  AppleLogoIcon,
  ArrowRightIcon,
  BrowserIcon,
  DeviceMobileIcon,
  GithubLogoIcon,
  RowsIcon,
  SparkleIcon,
  TelevisionSimpleIcon,
  UsersThreeIcon,
  UserSwitchIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react";
import { Wordmark } from "../../ui/wordmark";
import { useReleased, type App } from "./releases";
import home from "./shots/home.webp";
import homeSmall from "./shots/home-small.webp";
import title from "./shots/title.webp";
import titleSmall from "./shots/title-small.webp";
import player from "./shots/player.webp";
import playerSmall from "./shots/player-small.webp";
import party from "./shots/party.webp";
import partySmall from "./shots/party-small.webp";
import phone from "./shots/phone.webp";

/*
 * What a signed-out visitor sees at /: what Krida is, the real app, how it works, where it runs, and the questions
 * people ask first. It loads on its own (src/main.tsx), so it uses plain elements and the tokens in styles.css, not
 * ui.tsx, whose bubbles would bring bubli with them.
 */

const GITHUB = "https://github.com/kausthubh-coder/krida-open";
const SIGN_IN = "/sign-in";

const primary =
  "press inline-flex h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 text-subhead font-semibold text-on-accent hover:bg-accent-hover";
const quiet =
  "press inline-flex h-12 items-center justify-center gap-2 rounded-full bg-white/8 px-6 text-subhead font-semibold text-fg ring-1 ring-line ring-inset hover:bg-white/12";
const textLink = "font-medium text-fg underline decoration-fg-faint underline-offset-2 hover:decoration-fg";

export function Landing() {
  useEffect(() => {
    document.title = "Krida: press play on anything";
    // Signing in from here (in the app, not the landing-only page) keeps this tab: the app is plain "Krida".
    return () => {
      document.title = "Krida";
    };
  }, []);
  return (
    <div className="min-h-dvh bg-page text-fg">
      <Header />
      <main>
        <Hero />
        <Screens />
        <HowItWorks />
        <Features />
        <Platforms />
        <OpenSource />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="absolute inset-x-0 top-0 z-10 pt-(--inset-top)">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="/" aria-label="Krida" className="press rounded-full">
          <Wordmark className="text-title" />
        </a>
        <nav className="flex items-center gap-1">
          <a href={GITHUB} target="_blank" rel="noreferrer" className="press grid size-11 place-items-center rounded-full text-[22px] text-fg-muted hover:bg-white/8 hover:text-fg">
            <GithubLogoIcon aria-hidden />
            <span className="sr-only">Krida on GitHub</span>
          </a>
          <a href={SIGN_IN} className="press inline-flex h-10 items-center rounded-full px-4 text-body font-semibold text-fg hover:bg-white/8">
            Sign in
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative isolate overflow-hidden px-4 pt-[calc(var(--inset-top)+112px)] sm:px-6 md:pt-[calc(var(--inset-top)+144px)]">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 -z-10 h-[90dvh]"
        style={{ background: "radial-gradient(60% 55% at 50% 0%, oklch(0.4 0.01 60 / 0.45), transparent 70%)" }}
      />
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
        <h1 className="text-hero font-semibold text-balance md:text-[4.25rem] md:leading-[1.02] md:tracking-[-0.035em]">Press play on anything</h1>
        <p className="max-w-[54ch] text-subhead text-pretty text-fg-muted md:text-title md:font-normal">
          Krida is a free, open-source streaming app. Search any film, show or anime and watch it in your browser, alone or
          with friends, through your own debrid service and Stremio addons.
        </p>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
          <a href={SIGN_IN} className={primary}>
            Get started
            <ArrowRightIcon weight="bold" aria-hidden />
          </a>
          <a href="#how" className={quiet}>
            How it works
          </a>
        </div>
        <p className="text-body text-fg-faint">Free, no ads. Krida hosts no files.</p>
      </div>
      <figure className="mx-auto mt-14 max-w-6xl md:mt-20">
        <picture>
          <source media="(max-width: 640px)" srcSet={phone} />
          <img
            src={home}
            srcSet={`${homeSmall} 960w, ${home} 1920w`}
            sizes="(max-width: 1152px) 100vw, 1152px"
            width={1920}
            height={1200}
            alt="Krida’s Home: a large banner for the film you were watching, then rows of posters to pick from"
            fetchPriority="high"
            className="w-full rounded-[20px] shadow-overlay outline-1 -outline-offset-1 outline-white/10 max-sm:mx-auto max-sm:w-[78%] max-sm:rounded-[28px]"
          />
        </picture>
      </figure>
    </section>
  );
}

function Screens() {
  return (
    <section aria-labelledby="screens" className="px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto flex max-w-6xl flex-col gap-16">
        <SectionTitle id="screens" title="What it looks like">
          Pick a title, press Play, and it starts. Bring people in when you want company.
        </SectionTitle>
        <Shot src={title} small={titleSmall} alt="A title page: the film’s artwork, scores, a Play button and its cast" title="A page for every title">
          Scores from IMDb, Rotten Tomatoes and Letterboxd, the cast, every episode, the trailer, and Play where you left off.
        </Shot>
        <Shot src={player} small={playerSmall} alt="The player, paused, with the timeline and its controls over the picture" title="Skips intros, keeps your place" flip>
          It skips intros and recaps, remembers your subtitles, shows a picture as you scrub, and goes on to the next episode.
        </Shot>
        <Shot src={party} small={partySmall} alt="A watch party: the film playing, with the people watching and their chat beside it" title="Watch together">
          Start a party and share its link. Everyone stays on the same second, with a shared queue, chat and reactions.
        </Shot>
      </div>
    </section>
  );
}

function SectionTitle({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h2 id={id} className="text-display font-semibold text-balance md:text-[2.5rem] md:leading-[1.1]">
        {title}
      </h2>
      {children && <p className="text-subhead text-pretty text-fg-muted">{children}</p>}
    </div>
  );
}

function Shot({ src, small, alt, title, flip, children }: { src: string; small: string; alt: string; title: string; flip?: boolean; children: ReactNode }) {
  return (
    <figure className="grid items-center gap-6 md:grid-cols-[3fr_2fr] md:gap-12">
      <img
        src={src}
        srcSet={`${small} 1080w, ${src} 1440w`}
        sizes="(min-width: 768px) 690px, calc(100vw - 32px)"
        alt={alt}
        width={1440}
        height={900}
        loading="lazy"
        decoding="async"
        className={["w-full rounded-card shadow-overlay outline-1 -outline-offset-1 outline-white/10", flip && "md:order-2"].filter(Boolean).join(" ")}
      />
      <figcaption className="flex flex-col gap-2">
        <h3 className="text-title font-semibold">{title}</h3>
        <p className="max-w-[44ch] text-subhead text-pretty text-fg-muted">{children}</p>
      </figcaption>
    </figure>
  );
}

const STEPS: { title: string; body: ReactNode }[] = [
  { title: "Sign in", body: "With Google or a code sent to your email." },
  { title: "Add your keys", body: "A free TMDB key, so Krida can find titles, and the key of your debrid service. Each one is checked as you paste it." },
  { title: "Add addons", body: "Torrentio comes set up with your debrid key in one tap, or bring your addons over from Stremio." },
  { title: "Press Play", body: "Setup takes a few minutes, and Krida walks you through it." },
];

function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-8 bg-surface px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto flex max-w-6xl flex-col gap-12">
        <SectionTitle id="how-title" title="Krida hosts nothing">
          It’s an app on top of services you bring. Your Stremio addons find what to play, your debrid service fetches it, and
          Krida plays it.
        </SectionTitle>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex flex-col gap-3 rounded-sheet bg-raised p-6 shadow-raised">
              <span aria-hidden className="grid size-9 place-items-center rounded-full bg-white/10 text-body font-semibold tabular-nums">
                {i + 1}
              </span>
              <h3 className="text-subhead font-semibold">{step.title}</h3>
              <p className="text-body text-pretty text-fg-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const FEATURES: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <UsersThreeIcon />,
    title: "Parties with friends",
    body: "Synced playback for everyone, from any account, with chat, reactions and a queue you fill together.",
  },
  {
    icon: <UserSwitchIcon />,
    title: "A profile for everyone",
    body: "Up to 8 profiles on one account, each with its own history, Plan to watch and picks, and a PIN if you want one.",
  },
  {
    icon: <SparkleIcon />,
    title: "Picks for you",
    body: "Recommendations learn from what each profile watches and rates, and Home shows what to watch next.",
  },
  {
    icon: <RowsIcon />,
    title: "Your rows, your order",
    body: "Every catalog your addons offer can be a row on Home. Rename, reorder, hide or pin them.",
  },
];

function Features() {
  return (
    <section aria-labelledby="features" className="px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto flex max-w-6xl flex-col gap-12">
        <SectionTitle id="features" title="What else it does" />
        <ul className="grid gap-x-10 gap-y-10 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-4">
              <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-white/8 text-[22px] text-fg">
                {f.icon}
              </span>
              <span className="flex flex-col gap-1">
                <h3 className="text-subhead font-semibold">{f.title}</h3>
                <p className="max-w-[46ch] text-body text-pretty text-fg-muted">{f.body}</p>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const APPS: { app: App; icon: ReactNode; name: string; body: string }[] = [
  { app: "android", icon: <AndroidLogoIcon />, name: "Android", body: "The app for phones and tablets." },
  { app: "mac", icon: <AppleLogoIcon />, name: "Mac", body: "Plays with mpv, so every debrid service works." },
  { app: "windows", icon: <WindowsLogoIcon />, name: "Windows", body: "Plays with mpv, so every debrid service works." },
];

function Platforms() {
  const released = useReleased();
  return (
    <section aria-labelledby="platforms" className="bg-surface px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto flex max-w-6xl flex-col gap-12">
        <SectionTitle id="platforms" title="Where it runs">
          One account works on all of them, with the same profiles, history and parties.
        </SectionTitle>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Platform icon={<BrowserIcon />} name="Web" body="Any modern browser on a computer, phone or tablet.">
            <a href={SIGN_IN} className={quiet}>
              Open Krida
            </a>
          </Platform>
          <Platform icon={<DeviceMobileIcon />} name="Install from the browser" body="On iPhone, tap Share, then Add to Home Screen. On Android and in Chrome, choose Install.">
            <a href={SIGN_IN} className={quiet}>
              Open Krida
            </a>
          </Platform>
          {APPS.map(({ app, icon, name, body }) => (
            <Platform key={app} icon={icon} name={name} body={body}>
              {released?.[app] ? (
                <a href={released[app]} className={quiet}>
                  Download for {name}
                </a>
              ) : (
                <span className="inline-flex h-12 items-center text-body font-medium text-fg-faint" aria-live="polite">
                  {released === undefined ? "" : "Coming soon"}
                </span>
              )}
            </Platform>
          ))}
          <Platform icon={<TelevisionSimpleIcon />} name="TV" body="Android TV and other big screens.">
            <span className="inline-flex h-12 items-center text-body font-medium text-fg-faint">Later</span>
          </Platform>
        </ul>
      </div>
    </section>
  );
}

function Platform({ icon, name, body, children }: { icon: ReactNode; name: string; body: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-4 rounded-sheet bg-raised p-6 shadow-raised">
      <span aria-hidden className="text-[28px] text-fg">
        {icon}
      </span>
      <span className="flex flex-1 flex-col gap-1">
        <h3 className="text-subhead font-semibold">{name}</h3>
        <p className="text-body text-pretty text-fg-muted">{body}</p>
      </span>
      <span className="flex">{children}</span>
    </li>
  );
}

function OpenSource() {
  return (
    <section aria-labelledby="source" className="px-4 py-24 sm:px-6 md:py-32">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 rounded-sheet bg-surface p-8 shadow-raised md:flex-row md:items-center md:justify-between md:p-12">
        <div className="flex max-w-2xl flex-col gap-3">
          <h2 id="source" className="text-display font-semibold">
            Open source
          </h2>
          <p className="text-subhead text-pretty text-fg-muted">
            All of Krida’s code is on GitHub. Read it, run your own copy, or send a fix.
          </p>
        </div>
        <a href={GITHUB} target="_blank" rel="noreferrer" className={quiet}>
          <GithubLogoIcon aria-hidden className="text-[20px]" />
          View on GitHub
        </a>
      </div>
    </section>
  );
}

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: "Is it free?",
    a: "Yes. Krida costs nothing and shows no ads. You pay for your debrid service if you use one. TMDB and MDBList keys are free.",
  },
  {
    q: "Which debrid services work?",
    a: "TorBox, Real-Debrid, AllDebrid, Premiumize, Debrid-Link, Offcloud and EasyDebrid. You pick one while you set up, and can change it later.",
  },
  {
    q: "What does TorBox do that other services don’t?",
    a: "Browsers play only a few video formats. TorBox turns any file into a stream a browser can play, so with TorBox everything plays in the browser and the installed web app, and parties and timeline previews work. With another service, the browser plays MP4 and WebM files itself; the rest (most MKV files) play in Krida for Mac and Windows, or in an external player like VLC or Infuse.",
  },
  {
    q: "Is it legal?",
    a: "Krida hosts and indexes nothing. Like Stremio, it plays what your own addons and debrid service give it. What you watch with them is up to you and the laws where you live.",
  },
  {
    q: "What do I need to start?",
    a: (
      <>
        A Google account or an email address, a free{" "}
        <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer" className={textLink}>
          TMDB account
        </a>{" "}
        for its key, and a debrid account. Krida walks you through each one.
      </>
    ),
  },
];

function Faq() {
  return (
    <section aria-labelledby="faq" className="px-4 pb-24 sm:px-6 md:pb-32">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <h2 id="faq" className="text-display font-semibold">
          Questions
        </h2>
        <div className="flex flex-col divide-y divide-line border-y border-line">
          {QUESTIONS.map(({ q, a }) => (
            <details key={q} className="group">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-3 text-subhead font-medium [&::-webkit-details-marker]:hidden">
                {q}
                <span aria-hidden className="text-title text-fg-faint transition-transform duration-200 group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="pb-5 text-body text-pretty text-fg-muted md:text-subhead">{a}</p>
            </details>
          ))}
        </div>
        <a href={SIGN_IN} className={[primary, "self-start"].join(" ")}>
          Get started
          <ArrowRightIcon weight="bold" aria-hidden />
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line px-4 pt-10 pb-[calc(var(--inset-bottom,0px)+40px)] sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-4">
          <Wordmark className="text-title" />
          <div className="flex items-center gap-4">
            <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="shrink-0">
              <img src="/tmdb.svg" alt="TMDB" width={96} height={12} loading="lazy" className="h-3 w-auto" />
            </a>
            <p className="max-w-[48ch] text-caption text-fg-faint">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
          </div>
        </div>
        <nav className="flex gap-6 text-body text-fg-muted">
          <a href={GITHUB} target="_blank" rel="noreferrer" className="hover:text-fg">
            GitHub
          </a>
          <a href={SIGN_IN} className="hover:text-fg">
            Sign in
          </a>
        </nav>
      </div>
    </footer>
  );
}
