import { useState, type ReactNode } from "react";
import { BookmarkSimpleIcon, CheckCircleIcon, MagnifyingGlassIcon, StarIcon } from "@phosphor-icons/react";
import type { Overview } from "../libraryData";
import { art } from "../../../data/cinemeta";
import { factsOf, monthName, sortBy, titleLink, type Sort } from "../filters";
import { plural } from "../../../ui/format";
import { Art } from "../../../ui/artwork";
import { PosterCard } from "../../../ui/posterCard";
import { CardActions, CardMenu } from "../../title";
import { Button, ButtonLink, EmptyState } from "../../../ui/ui";
import { Growing, POSTER_GRID, ScoreBadge, SectionHead, useGrowing } from "./shared";

type Entry = Overview["watched"][number];
type ListEntry = Overview["list"][number];

const card = (e: Entry | ListEntry, undo?: boolean) => (
  <li key={e.id} className="min-w-0">
    <CardMenu item={{ id: e.id, type: e.type, name: e.name, poster: e.poster, year: e.year }} to={titleLink(e)}>
      <PosterCard to={titleLink(e)} poster={e.poster ?? art.poster(e.id)} title={e.name} subtitle={factsOf(e)}
        badge={"rating" in e && e.rating ? <ScoreBadge score={e.rating} /> : undefined}
        actions={<CardActions item={{ id: e.id, type: e.type, name: e.name, poster: e.poster, year: e.year }} undo={undo} />} />
    </CardMenu>
  </li>
);

/** The rating backlog, as one quiet line above the diary instead of a second list. */
function RatePrompt({ count, posters, onRate }: { count: number; posters: string[]; onRate: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-card bg-surface p-4 shadow-raised lg:flex-nowrap lg:pr-5">
      <div aria-hidden className="flex shrink-0">
        {posters.slice(0, 4).map((p) => <Art key={p} src={p} alt="" className="-ml-3 aspect-2/3 w-9 rounded-[6px] shadow-[0_0_0_2px_var(--color-surface)] first:ml-0" />)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{plural(count, "title is", "titles are")} waiting for your score</p>
        <p className="text-caption text-fg-faint">Scores sharpen your picks. One tap each.</p>
      </div>
      <Button icon={<StarIcon />} onClick={onRate} className="max-lg:w-full">Rate them</Button>
    </div>
  );
}

/**
 * Everything you've watched, as a diary: one group per month. Days when dozens of titles were logged at once
 * (a Simkl import) get their own group, since that's when they were logged, not watched.
 */
export function Watched({ data, sort, show, noMatch, toRate, onRate }: {
  data: Overview; sort: Sort; show: (e: Entry) => boolean; noMatch: ReactNode;
  toRate?: { count: number; posters: string[] }; onRate: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const list = data.watched.filter(show);
  const perDay = new Map<string, number>();
  for (const e of data.watched) if (e.at) perDay.set(new Date(e.at).toDateString(), (perDay.get(new Date(e.at).toDateString()) ?? 0) + 1);
  const groups: { key: string; title: string; note?: string; bulk: boolean; items: Entry[] }[] = [];
  const perMonthBulk = (at: number) => {
    const d = new Date(at);
    return list.filter((x) => x.at && new Date(x.at).getMonth() === d.getMonth() && new Date(x.at).getFullYear() === d.getFullYear() &&
      (perDay.get(new Date(x.at).toDateString()) ?? 0) >= 20).length;
  };
  for (const e of list) {
    const d = new Date(e.at);
    const bulk = e.at > 0 && (perDay.get(d.toDateString()) ?? 0) >= 20;
    const key = !e.at ? "undated" : bulk ? `bulk-${d.getFullYear()}-${d.getMonth()}` : `${d.getFullYear()}-${d.getMonth()}`;
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, items: [], bulk, title: !e.at ? "Earlier" : `${monthName(d.getMonth())} ${d.getFullYear()}`,
        note: bulk ? `${plural(perMonthBulk(e.at), "title", "titles")} imported from Simkl` : undefined };
      groups.push(group);
    }
    group.items.push(e);
  }
  // Six months at a time, more as the last comes into reach.
  const { shown: months, sentinel } = useGrowing(groups.length, 6, "months");
  if (data.watched.length === 0) return <EmptyState icon={<CheckCircleIcon />} title="Nothing watched yet"
    description="What you finish here, and everything you’ve marked watched on Simkl, collects here." />;
  return (
    <div className="flex flex-col gap-10">
      {!!toRate?.count && <RatePrompt count={toRate.count} posters={toRate.posters} onRate={onRate} />}
      {list.length === 0 ? noMatch : sort !== "recent" ? <Growing id="watched" items={sortBy(list, sort)} render={(e) => card(e)} className={POSTER_GRID} /> : <div className="relative flex flex-col gap-10">
        {groups.slice(0, months).map((g) => {
          const cap = g.bulk ? 12 : 30;
          const items = open[g.key] ? g.items : g.items.slice(0, cap);
          return (
            <section key={g.key} className="flex flex-col gap-4">
              <SectionHead title={g.title} note={g.note ?? plural(g.items.length, "title", "titles")} />
              <ul className={POSTER_GRID}>{items.map((e) => card(e))}</ul>
              {g.items.length > items.length && <Button variant="ghost" className="-ml-3 self-start"
                onClick={() => setOpen((o) => ({ ...o, [g.key]: true }))}>Show all {g.items.length.toLocaleString()}</Button>}
            </section>
          );
        })}
        {sentinel}
      </div>}
    </div>
  );
}

/** Your watchlist: saved here, or planned on Simkl. */
export function PlanToWatch({ data, sort, show, noMatch }: { data: Overview; sort: Sort; show: (e: ListEntry) => boolean; noMatch: ReactNode }) {
  if (data.list.length === 0) return <EmptyState icon={<BookmarkSimpleIcon />} title="Nothing planned yet"
    description="Choose Plan to watch on any title to keep it here for later. Your Simkl watchlist shows up here too once it’s connected."
    action={<ButtonLink to="/search" icon={<MagnifyingGlassIcon />}>Find something to watch</ButtonLink>} />;
  const list = data.list.filter(show);
  return list.length === 0 ? noMatch : <Growing id="plan" items={sortBy(list, sort)} render={(e) => card(e, true)} className={POSTER_GRID} />;
}
