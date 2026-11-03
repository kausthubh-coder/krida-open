import type { ReactNode } from "react";
import { MagnifyingGlassIcon, PauseCircleIcon, PlayCircleIcon, XCircleIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import type { Overview } from "../libraryData";
import { shortDate, sortBy, titleLink, type Sort } from "../filters";
import { CardActions, CardMenu } from "../../title";
import { ButtonLink, EmptyState } from "../../../ui/ui";
import { Growing, SectionHead, WIDE_GRID, WideCard } from "./shared";

type Entry = Overview["watching"][number];
export type Status = "watching" | "rewatching" | "hold" | "dropped";

const EMPTY: Record<Status, { icon: ReactNode; title: string; description: string }> = {
  watching: { icon: <PlayCircleIcon />, title: "Nothing in progress", description: "Shows and movies you’ve started, here or on Simkl, wait here with where you left off." },
  rewatching: { icon: <ArrowClockwiseIcon />, title: "Nothing you’re rewatching", description: "Choose Rewatching on a title to keep it here. Your original history is kept, and Simkl shows it as Watched." },
  hold: { icon: <PauseCircleIcon />, title: "Nothing on hold", description: "Choose On hold when you want to take a break. Your progress is kept." },
  dropped: { icon: <XCircleIcon />, title: "Nothing dropped", description: "Titles you mark Dropped, here or on Simkl, show up here." },
};
// Notes that only repeat the chip you're on.
const STATUS_NOTES = new Set(["Watching", "Rewatching", "On hold", "Dropped", "Watched"]);
const leftLabel = (n: number) => `${n} ${n === 1 ? "episode" : "episodes"} left`;

/**
 * What you're in the middle of. Nearly finished comes first: it's the strongest reason to press Play. Any
 * other sort is one plain grid.
 */
export function UpNext({ data, status, sort = "recent", show, noMatch }: { data: Overview; status: Status; sort?: Sort; show: (e: Entry) => boolean; noMatch: ReactNode }) {
  const list = sortBy(data[status].filter(show), sort);
  const almost = status === "watching" && sort === "recent" ? list.filter((e) => e.left !== undefined && e.left <= 3).slice(0, 4) : [];
  const rest = list.filter((e) => !almost.includes(e));
  const subtitle = (e: Entry, near: boolean) => {
    const next = e.note && !STATUS_NOTES.has(e.note) ? e.note.replace("Next: ", "Next ") : undefined;
    return [next, near || e.left === undefined ? (e.at ? `watched ${shortDate(e.at)}` : undefined) : leftLabel(e.left)].filter(Boolean).join(" · ");
  };
  const card = (e: Entry, near: boolean) => (
    <li key={e.id} className="min-w-0">
      <CardMenu item={{ id: e.id, type: e.type, name: e.name, poster: e.poster, year: e.year }} to={titleLink(e)}>
        <WideCard to={titleLink(e)} id={e.id} imdb={e.imdb} poster={e.poster} title={e.name}
          left={near ? e.left : undefined} progress={e.progress} subtitle={subtitle(e, near)}
          actions={<CardActions item={{ id: e.id, type: e.type, name: e.name, poster: e.poster, year: e.year }} />} />
      </CardMenu>
    </li>
  );
  const unfiltered = data[status].length;
  return (
    <div className="flex flex-col gap-8">
      {list.length === 0 ? unfiltered ? noMatch : (
        <EmptyState icon={EMPTY[status].icon} title={EMPTY[status].title} description={EMPTY[status].description}
          action={status === "watching" ? <ButtonLink to="/search" icon={<MagnifyingGlassIcon />}>Find something to watch</ButtonLink> : undefined} />
      ) : <>
        {almost.length > 0 && <section className="flex flex-col gap-4">
          <SectionHead title="Almost done" note="Three episodes or fewer to go" />
          <ul className={WIDE_GRID}>{almost.map((e) => card(e, true))}</ul>
        </section>}
        {rest.length > 0 && <section className="flex flex-col gap-4">
          {almost.length > 0 && <SectionHead title="Still going" note="Most recent first" />}
          <Growing id={status} items={rest} render={(e) => card(e, false)} className={WIDE_GRID} />
        </section>}
      </>}
    </div>
  );
}
