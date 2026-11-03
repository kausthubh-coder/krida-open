// A person's page: who they are, then a row for each thing they did (directed, wrote, acted…), best known first.
import { useParams, useSearchParams } from "react-router";
import { person as fetchPerson, type PersonPage as Page } from "../../data/api";
import { useAsync } from "../../data/cinemeta";
import { useReadyTiming } from "../../data/telemetry";
import { Art, ART_FALLBACK } from "../../ui/artwork";
import { PosterCard } from "../../ui/posterCard";
import { Rail } from "../../ui/rail";
import { Button, ButtonLink, cx, EmptyState } from "../../ui/ui";
import { CardActions, CardMenu, Description } from "../title";

type Group = Page["groups"][number];

export function PersonPage() {
  const { id = "" } = useParams<{ id: string }>();
  // A title page names people without TMDB's ids, so it links by name and says which title it came from.
  const [params] = useSearchParams();
  const title = params.get("title") ?? undefined;
  const page = useAsync(id ? `person:${id}:${title ?? ""}` : null, () => fetchPerson(id, title));
  useReadyTiming("person", !!page.data, id);

  if (page.error)
    return page.error.message === "No such person" ? (
      <EmptyState
        className="min-h-[70dvh] pt-24"
        title="We couldn’t find this person"
        description="TMDB has nobody at this link. Search for them by name instead."
        action={<ButtonLink to="/search">Search</ButtonLink>}
      />
    ) : (
      <EmptyState
        className="min-h-[70dvh] pt-24"
        title="Couldn’t load this person"
        description="TMDB didn’t answer. Check your connection and try again."
        action={<Button onClick={() => location.reload()}>Try again</Button>}
      />
    );
  if (!page.data) return <PersonSkeleton />;
  const p = page.data;
  return (
    <main className="flex flex-col gap-8 pb-16 md:gap-10">
      <header className="flex gap-5 px-4 pt-20 max-sm:flex-col md:gap-8 md:px-12 md:pt-24 short:pt-16">
        <Art
          src={p.photo}
          alt=""
          eager
          className={cx("aspect-2/3 w-32 shrink-0 self-start rounded-card img-outline md:w-44", ART_FALLBACK)}
          imgClassName="object-[center_20%]"
        />
        <div className="flex min-w-0 flex-col gap-3 sm:justify-end">
          <h1 className="font-display text-display font-semibold md:text-hero">{p.name}</h1>
          <Facts person={p} />
          {p.bio && <Description text={p.bio} />}
        </div>
      </header>
      {p.groups.length === 0 ? (
        <EmptyState title="Nothing to watch yet" description={`TMDB doesn’t list any films or shows for ${p.name}.`} />
      ) : (
        p.groups.map((g) => <GroupRail key={g.title} group={g} />)
      )}
    </main>
  );
}

const day = (date: string) =>
  new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function age(born: string, until?: string) {
  const from = new Date(born);
  const to = until ? new Date(until) : new Date();
  const years = to.getUTCFullYear() - from.getUTCFullYear();
  const before = to.getUTCMonth() < from.getUTCMonth() || (to.getUTCMonth() === from.getUTCMonth() && to.getUTCDate() < from.getUTCDate());
  return years - (before ? 1 : 0);
}

/** What they do, when and where they were born, and when they died. */
function Facts({ person: p }: { person: Page }) {
  const born = p.born && `Born ${day(p.born)}${p.died ? "" : ` (${age(p.born)})`}${p.place ? ` in ${p.place}` : ""}`;
  const died = p.died && `Died ${day(p.died)}${p.born ? ` (${age(p.born, p.died)})` : ""}`;
  const facts = [p.role, born, died].filter(Boolean);
  if (!facts.length) return null;
  // Plain text, so a line that wraps leaves its dot at the end of the line before, not at the start of the next.
  return <p className="max-w-[60ch] text-body text-fg-muted">{facts.join("\u00a0· ")}</p>;
}

function GroupRail({ group }: { group: Group }) {
  return (
    <Rail title={group.title}>
      {group.titles.map((item) => (
        <CardMenu key={item.id} item={item} to={`/title/${item.type}/${item.id}`}>
          <PosterCard
            to={`/title/${item.type}/${item.id}`}
            poster={item.poster}
            title={item.name}
            subtitle={[item.year, item.character && `as ${item.character}`].filter(Boolean).join(" · ") || undefined}
            score={{ rating: item.rating, ratingSource: "tmdb" }}
            actions={<CardActions item={item} />}
          />
        </CardMenu>
      ))}
    </Rail>
  );
}

/** The header's shape while TMDB answers. */
function PersonSkeleton() {
  return (
    <main className="flex flex-col gap-8 pb-16" aria-busy>
      <div className="flex gap-5 px-4 pt-20 max-sm:flex-col md:gap-8 md:px-12 md:pt-24 short:pt-16">
        <div className="skeleton aspect-2/3 w-32 shrink-0 rounded-card md:w-44" />
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-3">
          <div className="skeleton h-12 w-72 max-w-full rounded-card" />
          <div className="skeleton h-5 w-80 max-w-full rounded-full" />
          <div className="flex max-w-[55ch] flex-col gap-2">
            <div className="skeleton h-4 rounded-full" />
            <div className="skeleton h-4 rounded-full" />
            <div className="skeleton h-4 w-2/3 rounded-full" />
          </div>
        </div>
      </div>
      <span role="status" className="sr-only">Loading…</span>
    </main>
  );
}
