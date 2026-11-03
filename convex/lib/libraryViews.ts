import { expandEpisodes } from "./episodes";
import { scoreOf, type Thumb } from "./ratings";
import { watchedEnough } from "./stats";
import { aliasesOf, canonicalWith } from "./titleIds";
import { hiddenBy } from "./unwatched";
import { watchStatusOf, type TrackedStatus, type WatchStatus } from "./watchStatus";

// The browser imports this file too; runtime imports must stay browser-safe.

/*
 * The Library, built from a profile's rows. The server's queries and the browser share these, so the browser can
 * subscribe to each table on its own: a rating then re-reads the ratings, not the whole Simkl history with them.
 */

type Kind = "movie" | "series";

export type SimklRow = {
  id: string; type: Kind; name: string; poster?: string; year?: string; imdb?: string; status: TrackedStatus; rating?: number;
  watchedEpisodes?: number; totalEpisodes?: number; watched?: string; lastWatchedAt?: number; addedAt?: number;
  nextEpisode?: number; nextSeason?: number;
};
export type ViewingRow = { id: string; type: Kind; name: string; poster?: string; state: WatchStatus; at: number };
export type ListRow = { imdbId: string; type: Kind; name: string; poster?: string; year?: string; addedAt: number };
export type FeedbackRow = { id: string; value: Thumb; rating?: number | null };
export type ProgressRow = {
  media: { type: Kind; imdbId: string; videoId: string; name: string; poster?: string; year?: string; season?: number; episode?: number };
  position: number; duration: number; finished: boolean; hidden?: boolean; updatedAt: number;
};
/** A profile's own choices: statuses, Plan to watch (newest first), scores and "I didn't watch this". */
export type OwnRows = { viewing: ViewingRow[]; list: ListRow[]; feedback: FeedbackRow[]; unwatched: [string, number][] };

export type MineRow = { id: string; local?: WatchStatus; tracked?: TrackedStatus; saved?: boolean; rating?: number };

/**
 * A profile's own rows with every id replaced by its title's canonical one (lib/titleIds). Rows saved under both
 * ids before Simkl merged them become one: the newest status and correction, and the score under the canonical id.
 */
function canonicalRows(simkl: SimklRow[], own: OwnRows) {
  const canonical = canonicalWith(aliasesOf(simkl));
  const unwatched = new Map<string, number>();
  for (const [id, at] of own.unwatched) unwatched.set(canonical(id), Math.max(at, unwatched.get(canonical(id)) ?? 0));
  const viewing = new Map<string, ViewingRow>();
  for (const view of own.viewing) {
    const id = canonical(view.id);
    const other = viewing.get(id);
    if (!other || view.at > other.at) viewing.set(id, { ...view, id });
  }
  const feedback = new Map<string, FeedbackRow>();
  for (const f of own.feedback) {
    const id = canonical(f.id);
    if (f.id === id || !feedback.has(id)) feedback.set(id, { ...f, id });
  }
  return { canonical, unwatched, viewing, feedback };
}

/** What every poster needs about this profile: the inputs to its status, whether it's in Plan to watch, and its score. */
export function mineFrom(simkl: SimklRow[], own: OwnRows): MineRow[] {
  const { canonical, unwatched, viewing, feedback } = canonicalRows(simkl, own);
  const rows = new Map<string, MineRow>();
  const row = (id: string) => rows.get(id) ?? rows.set(id, { id }).get(id)!;
  for (const t of simkl) {
    if (t.status !== "plantowatch" && hiddenBy(unwatched, t.id, t.lastWatchedAt)) continue;
    row(t.id).tracked = t.status;
    if (t.rating !== undefined) row(t.id).rating = t.rating;
  }
  for (const view of viewing.values())
    if (view.state === "plantowatch" || !hiddenBy(unwatched, view.id, view.at)) row(view.id).local = view.state;
  for (const entry of own.list) row(canonical(entry.imdbId)).saved = true;
  // A Krida score, or a cleared one, overrides the imported score.
  for (const f of feedback.values()) {
    const score = scoreOf(f);
    if (score === null) delete row(f.id).rating;
    else row(f.id).rating = score;
  }
  return [...rows.values()];
}

export type LibraryEntry = {
  id: string;
  type: Kind;
  name: string;
  poster?: string;
  year?: string;
  // What the card says under the title.
  note?: string;
  progress?: number;
  at: number;
  // Your score, episodes still to go, and the IMDb id of an anime (for wide artwork).
  rating?: number;
  left?: number;
  imdb?: string;
};

const episode = (s?: number, e?: number) => (s !== undefined && e !== undefined ? `S${s} E${e}` : "");

/**
 * The Library: Plan to watch, what you're in the middle of, and what you've watched, from Krida and Simkl together.
 * Krida's own history wins where both know a title. `progress` is the latest 400 plays, newest first.
 */
export function overviewFrom(own: OwnRows, progress: ProgressRow[], simkl: SimklRow[], separateStatuses?: boolean) {
  const { canonical, unwatched, viewing: views, feedback } = canonicalRows(simkl, own);
  const tracked = new Map(simkl.filter((t) => t.status === "plantowatch" || !hiddenBy(unwatched, t.id, t.lastWatchedAt)).map((t) => [t.id, t]));
  const viewing = new Map([...views].filter(([, view]) => view.state === "plantowatch" || !hiddenBy(unwatched, view.id, view.at)));
  const latest = new Map<string, ProgressRow>();
  for (const p of progress) {
    const id = canonical(p.media.imdbId);
    if (!hiddenBy(unwatched, id, p.updatedAt) && !latest.has(id)) latest.set(id, p);
  }
  // One card per title, in its newest save's place, shown as the canonical row when that one is saved too.
  const byId = new Map(own.list.map((l) => [l.imdbId, l]));
  const listed = new Map<string, ListRow>();
  for (const l of own.list) {
    const id = canonical(l.imdbId);
    if (!listed.has(id)) listed.set(id, byId.get(id) ?? l);
  }
  const saved = new Set(listed.keys());

  const sections = { watching: new Map<string, LibraryEntry>(), completed: new Map<string, LibraryEntry>(), rewatching: new Map<string, LibraryEntry>(),
    hold: new Map<string, LibraryEntry>(), dropped: new Map<string, LibraryEntry>() };
  for (const id of new Set([...latest.keys(), ...tracked.keys(), ...viewing.keys()])) {
    const p = latest.get(id);
    const t = tracked.get(id);
    const view = viewing.get(id);
    const played = p && !p.hidden ? p : undefined;
    const status = watchStatusOf({ local: view?.state, tracked: t?.status, saved: saved.has(id),
      played: played ? { type: played.media.type, finished: played.finished } : null });
    // Plan to watch comes from the list itself.
    if (!status || status === "plantowatch") continue;
    const f = feedback.get(id);
    const rating = f ? scoreOf(f) : t?.rating;
    const entry: LibraryEntry = {
      // Played under the title's other id: the card opens that page, where Play carries on.
      id: p?.media.imdbId ?? id,
      type: view?.type ?? p?.media.type ?? t!.type,
      name: view?.name ?? p?.media.name ?? t!.name,
      poster: view?.poster ?? p?.media.poster ?? (t && !t.id.startsWith("tt") ? t.poster : undefined),
      year: p?.media.year ?? t?.year,
      rating: rating ?? undefined,
      imdb: t?.imdb,
      left: t?.watchedEpisodes && t.totalEpisodes && t.totalEpisodes > t.watchedEpisodes ? t.totalEpisodes - t.watchedEpisodes : undefined,
      at: view?.at ?? played?.updatedAt ?? t?.lastWatchedAt ?? t?.addedAt ?? 0,
      progress: played && !played.finished ? played.position / Math.max(1, played.duration)
        : status === "watching" && t?.watchedEpisodes && t.totalEpisodes ? t.watchedEpisodes / t.totalEpisodes : undefined,
    };
    entry.note = status === "completed" ? rating ? `You rated it ${rating}/10` : "Watched"
      : status === "hold" ? "On hold" : status === "dropped" ? "Dropped" : status === "rewatching" ? "Rewatching"
        : played?.media.type === "series" ? `${played.finished ? "Finished" : "On"} ${episode(played.media.season, played.media.episode)}`
          : t?.nextEpisode !== undefined ? `Next: ${episode(t.nextSeason ?? 1, t.nextEpisode)}` : played ? undefined : "Watching";
    sections[status].set(id, entry);
  }
  const { watching, completed: watched, rewatching, hold, dropped } = sections;
  const byRecent = (a: LibraryEntry, b: LibraryEntry) => b.at - a.at;
  return {
    list: [...listed].map(([id, l]): LibraryEntry => ({
      id,
      type: l.type,
      name: l.name,
      poster: l.poster,
      year: l.year,
      imdb: tracked.get(id)?.imdb,
      note: "Plan to watch",
      at: l.addedAt,
    })),
    // Older frontends show these in Watching until the new filters are deployed.
    watching: [...watching.values(), ...(separateStatuses ? [] : [...rewatching.values(), ...hold.values()])].sort(byRecent),
    watched: [...watched.values()].sort(byRecent),
    rewatching: [...rewatching.values()].sort(byRecent),
    hold: [...hold.values()].sort(byRecent),
    dropped: [...dropped.values()].sort(byRecent),
  };
}
export type Overview = ReturnType<typeof overviewFrom>;

export type RateItem = {
  id: string; type: Kind; name: string; poster?: string; year?: string; imdb?: string;
  // recent: finished lately. partway: stopped after enough episodes. import: logged in one go on Simkl.
  group: "recent" | "partway" | "import";
  status: "completed" | "watching" | "hold" | "dropped";
  watchedEpisodes?: number; totalEpisodes?: number; at?: number; onSimkl: boolean;
};

/**
 * Everything you've watched enough of to have an opinion, without a score yet. One episode of a show doesn't
 * count. History logged in bulk on Simkl gets its own group, since some of it may not be yours.
 */
export function toRateFrom(own: OwnRows, progress: ProgressRow[], simkl: SimklRow[]) {
  const { canonical, unwatched, viewing: statuses, feedback } = canonicalRows(simkl, own);
  const scored = new Map([...feedback].map(([id, f]) => [id, scoreOf(f)]));
  // Copies: imported rows are corrected below with what Krida knows.
  const tracked = simkl.filter((t) => t.status !== "plantowatch" && !hiddenBy(unwatched, t.id, t.lastWatchedAt)).map((t) => ({ ...t }));
  const viewing = [...statuses.values()];
  // Imported counts can lag local playback. Merge episode identities before deciding whether to ask.
  for (const t of tracked) {
    const local = progress.filter((p) => p.media.imdbId === t.id && p.finished && !hiddenBy(unwatched, t.id, p.updatedAt));
    if (local.length) {
      const known = new Set(expandEpisodes(t.watched));
      for (const p of local) if (p.media.episode !== undefined) known.add(`${t.id.startsWith("kitsu:") ? 1 : p.media.season ?? 1}:${p.media.episode}`);
      t.watchedEpisodes = Math.max(t.watchedEpisodes ?? 0, known.size, local.length);
      if (t.type === "movie") t.status = "completed";
      t.lastWatchedAt = Math.max(t.lastWatchedAt ?? 0, ...local.map((p) => p.updatedAt));
    }
    const view = statuses.get(t.id);
    if (view && !hiddenBy(unwatched, t.id, view.at)) {
      t.status = view.state === "rewatching" ? "completed" : view.state;
      if (!t.lastWatchedAt && view.state === "completed") t.lastWatchedAt = view.at;
    }
  }
  // A day with this many titles was a bulk import, not a day of watching.
  const perDay = new Map<string, number>();
  for (const t of tracked) if (t.lastWatchedAt) {
    const day = new Date(t.lastWatchedAt).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const bulkDays = new Set([...perDay.entries()].filter(([, n]) => n >= 20).map(([day]) => day));
  const unrated = (id: string, simklScore?: number) => (scored.has(id) ? scored.get(id) === null : simklScore === undefined);
  const items: RateItem[] = [];
  const tooFew: string[] = [];
  const seen = new Set<string>();
  for (const t of tracked) {
    seen.add(t.id);
    if (t.status === "plantowatch" || !unrated(t.id, t.rating)) continue;
    if (!watchedEnough(t)) {
      if (t.type === "series") tooFew.push(t.name);
      continue;
    }
    const imported = t.lastWatchedAt !== undefined && bulkDays.has(new Date(t.lastWatchedAt).toISOString().slice(0, 10));
    items.push({
      id: t.id, type: t.type, name: t.name, poster: t.id.startsWith("tt") ? undefined : t.poster, year: t.year, imdb: t.imdb,
      group: imported ? "import" : t.status === "completed" ? "recent" : "partway",
      status: t.status, watchedEpisodes: t.watchedEpisodes, totalEpisodes: t.totalEpisodes, at: t.lastWatchedAt, onSimkl: true,
    });
  }
  // Finished in Krida (or marked finished there) but not on Simkl.
  const local = new Map<string, { media: ProgressRow["media"]; episodes: Set<string>; at: number; finished: boolean }>();
  for (const p of progress) {
    // Played under the alias of a title Simkl has: Simkl's entry is the one to score.
    if (seen.has(canonical(p.media.imdbId)) || hiddenBy(unwatched, canonical(p.media.imdbId), p.updatedAt)) continue;
    const cur = local.get(p.media.imdbId) ?? { media: p.media, episodes: new Set<string>(), at: p.updatedAt, finished: false };
    if (p.finished) { cur.episodes.add(p.media.videoId); cur.finished = true; }
    local.set(p.media.imdbId, cur);
  }
  for (const view of viewing) {
    if (seen.has(view.id) || view.state !== "completed" || hiddenBy(unwatched, view.id, view.at) || local.has(view.id)) continue;
    local.set(view.id, { media: { type: view.type, imdbId: view.id, videoId: view.id, name: view.name, poster: view.poster }, episodes: new Set(), at: view.at, finished: true });
  }
  for (const [id, l] of local) {
    if (!unrated(id)) continue;
    const view = statuses.get(id);
    if (view?.state === "plantowatch") continue;
    const done = view?.state === "completed" || view?.state === "rewatching";
    const enough = done || (l.media.type === "movie" ? l.finished : l.episodes.size >= 3);
    if (!enough) {
      if (l.media.type === "series") tooFew.push(l.media.name);
      continue;
    }
    items.push({ id, type: l.media.type, name: l.media.name, poster: l.media.poster, year: l.media.year, group: l.media.type === "movie" || done ? "recent" : "partway",
      status: l.media.type === "movie" || done ? "completed" : view?.state === "dropped" ? "dropped" : view?.state === "hold" ? "hold" : "watching", watchedEpisodes: l.media.type === "series" ? l.episodes.size || undefined : undefined, at: l.at, onSimkl: false });
  }
  items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const days = [...bulkDays].sort();
  return { items, importedOn: days.length ? Date.parse(days[0]) : undefined, tooFew: { count: tooFew.length, names: tooFew.slice(0, 3) } };
}
export type Backlog = ReturnType<typeof toRateFrom>;

// Only what the builders read goes to the browser.

// Simkl posters are used only for anime: IMDb titles have Metahub artwork.
export const simklRowOf = (t: SimklRow): SimklRow => ({
  id: t.id, type: t.type, name: t.name, poster: t.id.startsWith("tt") ? undefined : t.poster, year: t.year, imdb: t.imdb, status: t.status, rating: t.rating,
  watchedEpisodes: t.watchedEpisodes, totalEpisodes: t.totalEpisodes, watched: t.watched, lastWatchedAt: t.lastWatchedAt,
  addedAt: t.addedAt, nextEpisode: t.nextEpisode, nextSeason: t.nextSeason,
});
export const viewingRowOf = (r: ViewingRow): ViewingRow => ({ id: r.id, type: r.type, name: r.name, poster: r.poster, state: r.state, at: r.at });
export const listRowOf = (l: ListRow): ListRow => ({ imdbId: l.imdbId, type: l.type, name: l.name, poster: l.poster, year: l.year, addedAt: l.addedAt });
export const feedbackRowOf = (f: FeedbackRow): FeedbackRow => ({ id: f.id, value: f.value, rating: f.rating });
export const progressRowOf = (p: ProgressRow): ProgressRow => ({
  media: { type: p.media.type, imdbId: p.media.imdbId, videoId: p.media.videoId, name: p.media.name, poster: p.media.poster, year: p.media.year,
    season: p.media.season, episode: p.media.episode },
  position: p.position, duration: p.duration, finished: p.finished, hidden: p.hidden, updatedAt: p.updatedAt,
});
