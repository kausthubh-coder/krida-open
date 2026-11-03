import { useMemo, useState } from "react";
import type { Doc } from "../../../convex/_generated/dataModel";
import { useAuthed } from "../../data/session";
import { useReadyTiming } from "../../data/telemetry";
import { orderRows, rowTitle } from "./homeRows";
import { released } from "../../data/addons";
import { useHome, type HomeData } from "./useHome";
import { useContinueWatching, useMyList } from "../../data/rows";
import { MakeItYours, StarterSheet } from "../title";
import { Rail } from "../../ui/rail";
import { Hero, HeroSkeleton, WelcomeHero } from "./hero";
import { buildSlides, useHeroItems } from "./slides";
import { AddonRail, ContinueCard, FriendRail, HomeRail, MyListRail, RowsSkeleton, UpcomingCard } from "./rails";
import { splitUpcoming, useNextEpisodes } from "./nextUp";
import { useNeedsTmdbKey } from "../../data/keys";
import { NeedsTmdbKey } from "../../ui/needsKey";

export type ProgressRow = Doc<"progress">;

export type HomeRow = HomeData["rows"][number];

export type RowItem = HomeRow["items"][number];

export type Seed = NonNullable<HomeRow["seed"]>;

export type Person = NonNullable<HomeRow["people"]>[number];

export function Home() {
  const { token, me } = useAuthed();
  const home = useHome(token);
  const dismissKey = `krida.makeItYours.${me._id}`;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(dismissKey) === "1");
  const [rating, setRating] = useState(false);
  // Like the rows (useHome), these open with what Home last showed while the live results load.
  const prefs = me.prefs;
  const played = useContinueWatching(prefs.nextUpFrom);
  // Shows between episodes: their next one, and with Settings → Home's "Upcoming episodes", where one not out goes.
  const nextEpisodes = useNextEpisodes(played);
  const { current: continueRows, upcoming } = useMemo(
    () => (played ? splitUpcoming(played, nextEpisodes, prefs.upcoming) : { current: undefined, upcoming: [] }),
    [played, nextEpisodes, prefs.upcoming],
  );
  const myList = useMyList();
  const heroItems = useHeroItems(home, prefs.heroRow);
  const slides = useMemo(() => buildSlides(continueRows, home, heroItems), [continueRows, home, heroItems]);
  useReadyTiming("home", !!home && slides !== undefined);
  const needsKey = useNeedsTmdbKey();

  const rows = useMemo(() => {
    if (!home) return [];
    const all: { key: string; node: React.ReactNode }[] = [];
    if (continueRows?.length)
      all.push({
        key: "continue",
        node: (
          <Rail title={rowTitle({ key: "continue", title: "Continue watching" }, prefs.rowNames)} itemWidth="w-(--wide-w)">
            {continueRows.map((row) => (
              <ContinueCard key={row._id} row={row} />
            ))}
          </Rail>
        ),
      });
    if (upcoming.length)
      all.push({
        key: "upcoming",
        node: (
          <Rail title={rowTitle({ key: "upcoming", title: "Coming up" }, prefs.rowNames)} itemWidth="w-(--wide-w)">
            {upcoming.map((row) => (
              <UpcomingCard key={row._id} row={row} next={nextEpisodes.get(row._id)!} />
            ))}
          </Rail>
        ),
      });
    if (myList?.length)
      all.push({
        key: "mylist",
        node: <MyListRail title={rowTitle({ key: "mylist", title: "Plan to watch" }, prefs.rowNames)} items={myList} />,
      });
    const names = prefs.rowNames ?? [];
    const unreleased = !!prefs.hideUnreleased;
    for (const row of home.rows) {
      const items = unreleased ? row.items.filter((i) => released(i)) : row.items;
      if (items.length) all.push({ key: row.key, node: <HomeRail row={{ ...row, title: rowTitle(row, names), items }} /> });
    }
    for (const row of home.addonRows)
      all.push({ key: row.key, node: <AddonRail row={row} title={rowTitle(row, names, prefs.typeHiddenRows)} hideUnreleased={unreleased} /> });
    for (const row of home.friends) all.push({ key: row.key, node: <FriendRail title={rowTitle(row, names)} items={row.items} /> });
    return orderRows(all, { order: home.order, hidden: home.hidden, pinned: prefs.pinnedRows });
  }, [home, continueRows, upcoming, nextEpisodes, myList, prefs]);

  // Without the account's TMDB key there are no rows to show: say so, rather than a page of empty rows.
  if (needsKey)
    return (
      <main className="flex min-h-dvh flex-col justify-center px-4">
        <h1 className="sr-only">Home</h1>
        <NeedsTmdbKey />
      </main>
    );

  return (
    <main className="flex flex-col gap-8 pb-16 md:gap-10">
      {slides === undefined ? <HeroSkeleton /> : slides.length ? <Hero slides={slides} /> : <WelcomeHero />}

      {home?.coldStart && !dismissed && (
        <MakeItYours
          onRate={() => setRating(true)}
          onDismiss={() => {
            localStorage.setItem(dismissKey, "1");
            setDismissed(true);
          }}
        />
      )}
      <StarterSheet open={rating} onClose={() => setRating(false)} />

      {home === undefined ? (
        <RowsSkeleton />
      ) : (
        rows.map((r) => (
          <div key={r.key} className="rise-in">
            {r.node}
          </div>
        ))
      )}
      {home?.empty && (
        <p className="px-4 text-body text-fg-faint md:px-12">Couldn’t reach the catalogs just now. Their rows come back on their own.</p>
      )}
    </main>
  );
}
