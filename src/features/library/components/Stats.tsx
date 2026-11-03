import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { FunctionReturnType } from "convex/server";
import { ChartBarIcon, SparkleIcon } from "@phosphor-icons/react";
import type { api } from "../../../../convex/_generated/api";
import type { Period, Stats } from "../../../../convex/lib/statsShape";
import { hoursLabel, shortDate, titleLink } from "../filters";
import { art } from "../../../data/cinemeta";
import { plural } from "../../../ui/format";
import { Art } from "../../../ui/artwork";
import { Button, ButtonLink, EmptyState, Segmented } from "../../../ui/ui";
import { HoursByMonth, Legend, ScoreHistogram, ShareBar } from "./charts";
import { SectionHead } from "./shared";

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-4 rounded-sheet bg-surface p-6 shadow-raised"><SectionHead title={title} note={note} />{children}</section>;
}

const KINDS = [
  { key: "anime", label: "Anime", color: "var(--color-anime)" },
  { key: "show", label: "Shows", color: "var(--color-show)" },
  { key: "movie", label: "Movies", color: "var(--color-movie)" },
] as const;

/** Anime, shows and movies as one bar. Stats from before the split was kept show only the anime share. */
export function KindBar({ period, className }: { period: Period; className?: string }) {
  const kinds = period.kinds;
  const total = kinds ? kinds.anime + kinds.show + kinds.movie : 1;
  const parts = kinds ? KINDS.filter((k) => kinds[k.key] > 0).map((k) => ({ ...k, share: kinds[k.key] / total }))
    : [{ ...KINDS[0], share: period.animeShare }, { key: "rest", label: "Shows and movies", color: "oklch(1 0 0 / 0.2)", share: 1 - period.animeShare }];
  if (!period.minutes || !parts.length) return null;
  return <div className={className}>
    <div role="img" aria-label={parts.map((p) => `${p.label} ${Math.round(p.share * 100)}%`).join(", ")} className="flex h-3 gap-0.5 overflow-hidden rounded-full">
      {parts.map((p) => <i key={p.key} style={{ flexGrow: p.share, background: p.color }} />)}
    </div>
    <p className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-caption text-fg-muted">
      {parts.filter((p) => p.share > 0).map((p) => <span key={p.key} className="inline-flex items-center gap-2">
        <i aria-hidden className="size-2 rounded-full" style={{ background: p.color }} />{p.label} <span className="tabular-nums">{Math.round(p.share * 100)}%</span>
      </span>)}
    </p>
  </div>;
}

/** One number leads, then what you watched most, how you score, and a few things worth knowing. */
export function StatsView({ result, error, onRefresh, onWrapped }: {
  result: FunctionReturnType<typeof api.wrapped.get> | undefined; error: boolean; onRefresh: () => void; onWrapped: () => void;
}) {
  const [key, setKey] = useState("all");
  const stats = result?.stats;
  const heading = <h1 className="font-display text-display font-semibold md:text-hero">Stats</h1>;
  if (result === undefined && !error) return <div aria-busy className="flex flex-col gap-8">{heading}<p role="status" className="sr-only">Loading your stats…</p>
    <div className="skeleton h-24 w-80 rounded-card" /><div className="skeleton h-3 w-full max-w-2xl rounded-full" />
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton aspect-2/3 rounded-card" />)}</div>
  </div>;
  if (!stats) return <>{heading}<EmptyState icon={<ChartBarIcon />} title={error ? "Couldn’t start your stats" : result?.computing || !result ? "Putting your history together…" : "Your stats aren’t ready yet"}
    description="Krida combines your watch history and scores. Large libraries can take a few minutes the first time."
    action={!result?.computing && <Button onClick={onRefresh}>Try again</Button>} /></>;
  if (!stats.coverage.titles && !stats.periods[0]?.minutes) return <>{heading}<EmptyState icon={<ChartBarIcon />} title="Your story starts with a watch"
    description="Finish something in Krida or connect Simkl in Settings to bring in your history. Your stats will grow from there."
    action={<ButtonLink to="/settings/taste">Connect Simkl</ButtonLink>} /></>;
  // Years only when something was watched in them; most imported history has no dates and lives in All time.
  const periods = stats.periods.filter((p) => p.key === "all" || p.minutes > 0);
  const period = periods.find((p) => p.key === key) ?? periods[0];
  const hours = Math.round(period.minutes / 60);
  const friend = stats.friend && (stats.friend.agreement !== undefined || stats.friend.togetherMinutes > 0) ? stats.friend : undefined;
  const dated = period.months.some((m) => m.anime + m.show + m.movie > 0);
  // Only what there was: "4 movies", not "4 titles: 0 episodes and 4 movies".
  const made = [period.episodes && plural(period.episodes, "episode", "episodes"), period.movies && plural(period.movies, "movie", "movies")].filter(Boolean);
  return <div className="flex flex-col gap-12">
    <header className="flex flex-wrap items-end justify-between gap-4">
      {heading}
      {periods.length > 1 && <Segmented label="Stats period" value={period.key} onChange={setKey}
        options={periods.map((p) => ({ value: p.key, label: p.key === "all" ? "All time" : p.key }))} />}
    </header>

    <section aria-label="Time watched">
      <p className="font-display text-[clamp(4rem,10vw,6rem)] leading-none font-semibold tracking-[-0.035em] tabular-nums">
        {hours.toLocaleString()}<span className="ml-3 text-display font-semibold tracking-[-0.02em] text-fg-muted">{hours === 1 ? "hour" : "hours"}</span>
      </p>
      <p className="mt-4 max-w-[60ch] text-subhead text-fg-muted">
        {hours >= 48 ? `About ${Math.round(hours / 24)} days of watching across ` : "Across "}{period.episodes ? `${plural(period.titles, "title", "titles")}: ${made.join(" and ")}` : plural(period.movies, "movie", "movies")}.
      </p>
      <KindBar period={period} className="mt-6 max-w-2xl" />
    </section>

    {period.top.length > 0 && <section className="flex flex-col gap-4">
      <SectionHead title="What you watched most" />
      <ol className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
        {period.top.slice(0, 5).map((t, i) => <li key={t.id} className="min-w-0">
          <Link to={titleLink(t)} className="group/top flex flex-col gap-2 rounded-card outline-offset-4">
            <Art src={t.poster ?? art.poster(t.id)} alt="" fallbackTitle={t.name} className="aspect-2/3 w-full rounded-card img-outline group-hover/top:brightness-110" />
            <p className="truncate text-body font-medium"><span className="mr-2 text-fg-faint tabular-nums">{i + 1}</span>{t.name}</p>
            <p className="-mt-1.5 text-caption text-fg-faint tabular-nums">{hoursLabel(t.minutes)}{t.episodes > 0 && ` · ${plural(t.episodes, "episode", "episodes")}`}</p>
          </Link>
        </li>)}
      </ol>
    </section>}

    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Genres" note={period.genres.length ? undefined : "Filling in as Krida learns your titles"}>
        <div className="flex flex-col gap-4">{period.genres.slice(0, 6).map((g) => <ShareBar key={g.name} label={g.name} value={Math.round(g.share * 100)} max={Math.round(period.genres[0].share * 100)} suffix="%" />)}</div>
      </Card>
      <Card title="Your scores" note={period.scores.average ? `Usually a ${Math.round(period.scores.average)} · ${plural(period.scores.count, "title", "titles")}` : "Score a few titles to see this"}>
        <ScoreHistogram hist={period.scores.hist} />
      </Card>
      {period.key !== "all" && dated && <div className="lg:col-span-2"><Card title="Hours by month" note={period.key}><Legend /><HoursByMonth period={period} /></Card></div>}
    </div>

    {stats.insights.length > 0 && <section className="flex flex-col gap-4">
      <SectionHead title="Worth knowing" />
      <ul className="grid gap-4 md:grid-cols-2">{stats.insights.slice(0, 4).map((i) => <li key={i.key}>
        {i.ref ? <Link to={titleLink(i.ref)} className="flex h-full items-center gap-4 rounded-sheet bg-surface p-4 shadow-raised hover:bg-raised"><Insight insight={i} /></Link>
          : <div className="flex h-full items-center gap-4 rounded-sheet bg-surface p-4 shadow-raised"><Insight insight={i} /></div>}
      </li>)}</ul>
    </section>}

    {friend && <Card title={`You and ${friend.name}`}>
      {friend.agreement !== undefined && <p className="text-subhead"><span className="font-display text-display font-semibold tabular-nums">{Math.round(friend.agreement * 100)}%</span> <span className="text-fg-muted">in agreement on {plural(friend.bothScored, "shared score", "shared scores")}</span></p>}
      {friend.split && <p className="text-body text-fg-muted">Your biggest split: <Link className="text-fg underline underline-offset-4" to={titleLink(friend.split)}>{friend.split.name}</Link>. You gave it {friend.split.mine}, {friend.name} gave it {friend.split.theirs}.</p>}
      {friend.togetherMinutes > 0 && <p className="text-body text-fg-muted">About {hoursLabel(friend.togetherMinutes)} watched together across {plural(friend.parties, "party", "parties")}.</p>}
    </Card>}

    <section className="flex flex-wrap items-center justify-between gap-6 rounded-sheet bg-surface p-6 shadow-raised md:p-8">
      <div className="min-w-0"><p className="font-display text-display font-semibold">{stats.persona.name}</p><p className="mt-2 max-w-[60ch] text-body text-fg-muted">{stats.persona.line}</p></div>
      <Button icon={<SparkleIcon />} onClick={onWrapped}>Open your Wrapped</Button>
    </section>

    <details className="text-caption text-fg-faint">
      <summary className="inline-flex min-h-11 cursor-pointer items-center text-fg-muted hover:text-fg">How these are counted</summary>
      <div className="mt-2 flex max-w-[70ch] flex-col gap-2">
        <p>Hours combine what you played in Krida with each title’s runtime. {Math.round(period.estimatedShare * 100)}% of them use a typical runtime because the real one is unknown.</p>
        {stats.coverage.undated && <p>Most history imported from Simkl has no watch dates, so it counts in All time but not in a year.</p>}
        <p>Genres are known for {stats.coverage.factsFor} of {stats.coverage.factsWanted} titles. Watching something again isn’t counted twice.{result?.computedAt && ` Updated ${shortDate(result.computedAt)}.`}{error && " The last refresh failed, so these are from before."}</p>
      </div>
    </details>
  </div>;
}

function Insight({ insight }: { insight: Stats["insights"][number] }) {
  return <>
    {insight.ref && <Art src={insight.ref.poster ?? art.poster(insight.ref.id)} alt="" fallbackTitle={insight.ref.name} className="aspect-2/3 w-12 shrink-0 rounded-control img-outline" />}
    <div className="min-w-0"><p className="text-body font-medium text-balance">{insight.title}</p>{insight.detail && <p className="mt-1 text-body text-fg-faint">{insight.detail}</p>}</div>
  </>;
}
