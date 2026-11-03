import type { Kind, Period, Stats } from "./statsShape";

/**
 * Library stats and Wrapped, from a profile's history. Pure: everything it needs comes in as input, so the
 * numbers can be tested without a database. Times that came from bulk marking ("I've seen all of these")
 * count toward totals but never toward when something was watched.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Two marks this close together weren't two real watches: someone ticked a list.
const BULK_GAP = 2 * MINUTE;
// Typical runtimes when Simkl and the addons don't know one.
const FALLBACK: Record<Kind, number> = { anime: 24, show: 42, movie: 120 };

export type WatchEvent = { t?: number; key: string; minutes?: number; krida?: boolean };
export type StatTitle = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  year?: string;
  anime: boolean;
  status: "watching" | "hold" | "completed" | "dropped" | "plantowatch";
  score?: number;
  watchedEpisodes?: number;
  totalEpisodes?: number;
  runtime?: number;
  lastWatchedAt?: number;
  addedAt?: number;
  events: WatchEvent[];
};
export type Facts = { genres: string[]; cast: string[]; director: string[]; country?: string; runtime?: number };
export type Friend = {
  name: string;
  hue: number;
  scores: Map<string, number>;
  togetherMinutes: number;
  parties: number;
};
export type StatsInput = {
  now: number;
  timeZone?: string;
  titles: StatTitle[];
  facts: Map<string, Facts>;
  friend?: Friend;
  kridaSince?: number;
};

/** Enough of it was watched to have an opinion: a whole movie, or three episodes (half of a short show). */
export function watchedEnough(t: { type: "movie" | "series"; status: string; watchedEpisodes?: number; totalEpisodes?: number; krida?: boolean }) {
  if (t.status === "plantowatch") return false;
  if (t.type === "movie") return t.status === "completed";
  if (t.status === "completed") return true;
  const seen = t.watchedEpisodes ?? 0;
  return seen >= 3 || (t.totalEpisodes !== undefined && t.totalEpisodes > 0 && seen * 2 >= t.totalEpisodes && seen > 0);
}

export const kindOf = (t: { anime: boolean; type: "movie" | "series" }): Kind => (t.anime ? "anime" : t.type === "movie" ? "movie" : "show");

/** "Attack on Titan Season 3 (Part 2)" and "Attack on Titan: The Final Season" are one franchise. */
export function franchiseOf(name: string) {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .split(/:| - | – /)[0]
    .replace(/\b(the )?(final )?season\b.*$/, "")
    .replace(/\b(part|cour|chapter)\b.*$/, "")
    .replace(/\b(season|s)\s*\d+.*$/, "")
    .replace(/\s+\d+$/, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
export const words = (n: number) => (n >= 0 && n <= 20 ? WORDS[n] : n.toLocaleString("en-US"));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Local hour, minute, weekday and date for a timestamp, in the profile's time zone (UTC if unknown). */
export function localParts(t: number, timeZone?: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone ?? "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(new Date(t));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
      year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
      hour: Number(get("hour")) % 24, minute: Number(get("minute")),
      weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
    };
  } catch {
    const d = new Date(t);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const dayLabel = (t: number, timeZone?: string) => { const p = localParts(t, timeZone); return `${MONTHS[p.month - 1]} ${p.day}`; };
export function clockLabel(minutes: number) {
  const h = Math.floor(minutes / 60) % 24, m = Math.round(minutes % 60);
  if (h === 0 && m === 0) return "midnight";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "a.m." : "p.m."}`;
}

type Ev = { title: StatTitle; kind: Kind; t?: number; minutes: number; estimated: boolean; bulk: boolean; krida: boolean; dateOnly: boolean };

/** Every watch event with its minutes, and whether its time is real. */
export function events(titles: StatTitle[], facts: Map<string, Facts>): Ev[] {
  const out: Ev[] = [];
  for (const title of titles) {
    const kind = kindOf(title);
    const runtime = title.runtime ?? facts.get(title.id)?.runtime;
    const sorted = title.events.map((e) => ({ ...e })).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
    for (const [i, e] of sorted.entries()) {
      const near = (o?: WatchEvent) => o?.t !== undefined && e.t !== undefined && !o.krida && Math.abs(o.t - e.t) < BULK_GAP;
      out.push({
        title, kind, t: e.t,
        minutes: e.minutes ?? runtime ?? FALLBACK[kind],
        estimated: e.minutes === undefined && runtime === undefined,
        bulk: !e.krida && (e.t === undefined || near(sorted[i - 1]) || near(sorted[i + 1])),
        krida: !!e.krida,
        // Simkl stores a date without a time as midnight UTC: the day is real, the hour isn't.
        dateOnly: !e.krida && e.t !== undefined && e.t % DAY === 0,
      });
    }
  }
  // Many movies marked within minutes of each other were logged from memory, not watched then.
  const movies = out.filter((e) => e.title.type === "movie" && !e.krida && e.t !== undefined).sort((a, b) => a.t! - b.t!);
  for (const [i, e] of movies.entries()) {
    let n = 0;
    for (let j = i - 1; j >= 0 && e.t! - movies[j].t! <= 5 * MINUTE; j--) n++;
    for (let j = i + 1; j < movies.length && movies[j].t! - e.t! <= 5 * MINUTE; j++) n++;
    if (n >= 2) e.bulk = true;
  }
  return out;
}

const yearOf = (t: number, tz?: string) => localParts(t, tz).year;
const monthKey = (t: number, tz?: string) => { const p = localParts(t, tz); return `${p.year}-${String(p.month).padStart(2, "0")}`; };

function scoresOf(titles: StatTitle[]) {
  const hist = Array.from({ length: 10 }, () => 0);
  let sum = 0, count = 0;
  for (const t of titles) if (t.score !== undefined) { hist[t.score - 1]++; sum += t.score; count++; }
  return { count, average: count ? round1(sum / count) : undefined, hist, tens: hist[9] };
}

function period(key: string, all: Ev[], titles: StatTitle[], facts: Map<string, Facts>, now: number, tz?: string): Period {
  const inYear = (e: Ev) => key === "all" || (e.t !== undefined && !e.bulk && String(yearOf(e.t, e.dateOnly ? "UTC" : tz)) === key);
  const evs = all.filter(inYear);
  const real = evs.filter((e) => !e.bulk && e.t !== undefined);
  const minutes = evs.reduce((a, e) => a + e.minutes, 0);
  const bulk = key === "all" ? evs.filter((e) => e.bulk) : [];
  const ids = new Set(evs.map((e) => e.title.id));
  const inPeriod = titles.filter((t) => ids.has(t.id) && watchedEnough(t));

  // Last 24 months up to now (or the year's 12), real watching only.
  const months: Period["months"] = [];
  const end = localParts(now, tz);
  const span = key === "all" ? 24 : 12;
  for (let i = span - 1; i >= 0; i--) {
    const y = key === "all" ? end.year + Math.floor((end.month - 1 - i) / 12) : Number(key);
    const m = key === "all" ? ((end.month - 1 - i) % 12 + 12) % 12 + 1 : 12 - i;
    months.push({ month: `${y}-${String(m).padStart(2, "0")}`, anime: 0, show: 0, movie: 0 });
  }
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const e of real) { const m = byMonth.get(monthKey(e.t!, e.dateOnly ? "UTC" : tz)); if (m) m[e.kind] += e.minutes; }
  for (const m of months) { m.anime = Math.round(m.anime); m.show = Math.round(m.show); m.movie = Math.round(m.movie); }

  // A session starts after three hours without watching anything.
  const clock = Array.from({ length: 24 }, () => 0), weekdays = Array.from({ length: 7 }, () => 0);
  const timed = real.filter((e) => !e.dateOnly).map((e) => ({ ...e, start: e.krida ? e.t! : e.t! - e.minutes * MINUTE })).sort((a, b) => a.start - b.start);
  const starts: number[] = [];
  let lastEnd = -Infinity;
  for (const e of timed) {
    if (e.start - lastEnd > 3 * HOUR) {
      const p = localParts(e.start, tz);
      clock[p.hour]++; weekdays[p.weekday]++;
      // Late-night starts belong to the evening before when finding the typical start.
      starts.push(((p.hour * 60 + p.minute) - 12 * 60 + 1440) % 1440);
    }
    lastEnd = Math.max(lastEnd, e.start + e.minutes * MINUTE);
  }
  starts.sort((a, b) => a - b);
  const medianStart = starts.length >= 5 ? (starts[Math.floor(starts.length / 2)] + 12 * 60) % 1440 : undefined;

  const perTitle = new Map<string, { title: StatTitle; minutes: number; episodes: number }>();
  for (const e of evs) {
    const cur = perTitle.get(e.title.id) ?? { title: e.title, minutes: 0, episodes: 0 };
    cur.minutes += e.minutes; cur.episodes += e.title.type === "series" ? 1 : 0;
    perTitle.set(e.title.id, cur);
  }
  const top = [...perTitle.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 5)
    .map(({ title, minutes, episodes }) => ({ id: title.id, type: title.type, name: title.name, poster: title.poster, minutes: Math.round(minutes), episodes }));

  const genreMinutes = new Map<string, number>();
  let withGenres = 0;
  for (const { title, minutes } of perTitle.values()) {
    const g = facts.get(title.id)?.genres ?? [];
    if (!g.length) continue;
    withGenres += minutes;
    for (const name of g) genreMinutes.set(name, (genreMinutes.get(name) ?? 0) + minutes / g.length);
  }
  const genres = [...genreMinutes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([name, m]) => ({ name, share: withGenres ? round1((m / withGenres) * 100) / 100 : 0 }));

  // Longest run of one title on consecutive days.
  let binge: Period["binge"];
  const byTitle = new Map<string, Ev[]>();
  for (const e of real) if (e.title.type === "series") byTitle.set(e.title.id, [...(byTitle.get(e.title.id) ?? []), e]);
  for (const list of byTitle.values()) {
    list.sort((a, b) => a.t! - b.t!);
    let from = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i].t! - list[i - 1].t! <= 36 * HOUR) continue;
      const n = i - from;
      if (n >= 6 && (!binge || n > binge.episodes)) {
        const t = list[from].title;
        binge = { id: t.id, type: t.type, name: t.name, poster: t.poster, episodes: n, from: list[from].t!, to: list[i - 1].t!,
          days: Math.max(1, Math.round((list[i - 1].t! - list[from].t!) / DAY) + 1) };
      }
      from = i;
    }
  }

  // Longest quiet stretch within the period (the last year, for "all").
  let gap: Period["gap"];
  const since = key === "all" ? now - 365 * DAY : Date.UTC(Number(key), 0, 1);
  const until = key === "all" || Number(key) === end.year ? now : Date.UTC(Number(key) + 1, 0, 1);
  const times = real.map((e) => e.t!).filter((t) => t >= since && t <= until).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    const days = Math.floor((times[i] - times[i - 1]) / DAY);
    if (days >= 21 && (!gap || days > gap.days)) gap = { from: times[i - 1], to: times[i], days };
  }

  return {
    key,
    minutes: Math.round(minutes),
    estimatedShare: minutes ? round1((evs.filter((e) => e.estimated).reduce((a, e) => a + e.minutes, 0) / minutes) * 100) / 100 : 0,
    episodes: evs.filter((e) => e.title.type === "series").length,
    movies: evs.filter((e) => e.title.type === "movie" && e.title.status === "completed").length,
    showsFinished: inPeriod.filter((t) => t.type === "series" && t.status === "completed").length,
    titles: inPeriod.length,
    animeShare: minutes ? round1((evs.filter((e) => e.kind === "anime").reduce((a, e) => a + e.minutes, 0) / minutes) * 100) / 100 : 0,
    kinds: Object.fromEntries((["anime", "show", "movie"] as const).map((k) => [k, Math.round(evs.filter((e) => e.kind === k).reduce((a, e) => a + e.minutes, 0))])) as Record<Kind, number>,
    months,
    bulkMinutes: Math.round(bulk.reduce((a, e) => a + e.minutes, 0)),
    bulkTitles: new Set(bulk.map((e) => e.title.id)).size,
    clock, weekdays, sessions: starts.length, medianStart,
    top, genres,
    scores: scoresOf(key === "all" ? titles : inPeriod),
    binge, gap,
  };
}

/** Where a title sits on the taste map: light to heavy (x) and grounded to fantastical (y), from its genres. */
const TONE: Record<string, number> = {
  horror: 1, thriller: 0.9, crime: 0.7, war: 0.9, drama: 0.5, mystery: 0.6, psychological: 1, tragedy: 1, "film-noir": 0.8,
  action: 0.2, history: 0.4, biography: 0.2, seinen: 0.6, comedy: -0.9, family: -1, animation: -0.4, romance: -0.5,
  music: -0.6, musical: -0.7, "slice of life": -0.8, kids: -1, sports: -0.3, adventure: -0.2, shoujo: -0.4, "talk-show": -0.6,
};
const REALM: Record<string, number> = {
  fantasy: 1, "sci-fi": 0.9, "science fiction": 0.9, supernatural: 1, isekai: 1, magic: 1, mecha: 1, "super power": 1,
  animation: 0.5, adventure: 0.4, horror: 0.3, documentary: -1, biography: -1, history: -0.8, crime: -0.6, drama: -0.4,
  sports: -0.5, romance: -0.3, "slice of life": -0.7, "reality-tv": -1, war: -0.4, thriller: -0.2, family: 0.1,
};
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };
export function place(id: string, genres: string[], anime: boolean) {
  const g = genres.map((x) => x.toLowerCase());
  const avg = (table: Record<string, number>) => { const xs = g.map((x) => table[x]).filter((x) => x !== undefined); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; };
  const clamp = (n: number) => Math.min(0.97, Math.max(0.03, n));
  return {
    x: clamp((avg(TONE) + 1) / 2 + (hash(id) - 0.5) * 0.12),
    y: clamp((avg(REALM) + (anime ? 0.2 : 0) + 1) / 2 + (hash(`${id}y`) - 0.5) * 0.12),
  };
}

function insightsFor(input: StatsInput, all: Period, year: Period | undefined, titles: StatTitle[], finish: Stats["finish"], people: Stats["people"], planned: Stats["planned"]) {
  const { facts, timeZone: tz, now } = input;
  const out: Stats["insights"] = [];
  const ref = (t: StatTitle) => ({ id: t.id, type: t.type, name: t.name, poster: t.poster });
  const scored = titles.filter((t) => t.score !== undefined);

  // One franchise owning your 10s.
  const tens = scored.filter((t) => t.score === 10);
  const tenGroups = new Map<string, StatTitle[]>();
  for (const t of tens) { const k = franchiseOf(t.name); tenGroups.set(k, [...(tenGroups.get(k) ?? []), t]); }
  const tenRank = [...tenGroups.values()].sort((a, b) => b.length - a.length);
  if (tens.length >= 5 && tenRank[0].length >= 3) {
    const lead = tenRank[0].reduce((a, b) => (a.name.length <= b.name.length ? a : b));
    out.push({ key: "tens", title: `${cap(words(tenRank[0].length))} of your ${words(tens.length)} 10s are ${lead.name}.`,
      detail: (tenRank[1]?.length ?? 0) <= 1 ? "Nothing else has more than one." : `${tenRank[1][0].name} is next with ${words(tenRank[1].length)}.`, ref: ref(lead) });
  }

  // So close to the end, and stopped.
  const close = titles.filter((t) => t.type === "series" && (t.status === "watching" || t.status === "hold") &&
    t.totalEpisodes && t.watchedEpisodes && t.totalEpisodes - t.watchedEpisodes >= 1 && t.totalEpisodes - t.watchedEpisodes <= 3 &&
    t.lastWatchedAt && now - t.lastWatchedAt >= 21 * DAY)
    .sort((a, b) => (a.totalEpisodes! - a.watchedEpisodes!) - (b.totalEpisodes! - b.watchedEpisodes!) || b.lastWatchedAt! - a.lastWatchedAt!);
  if (close[0]) {
    const t = close[0], left = t.totalEpisodes! - t.watchedEpisodes!;
    out.push({ key: "almost", title: `${t.name} is ${words(left)} ${left === 1 ? "episode" : "episodes"} from the end.`,
      detail: `You stopped on ${dayLabel(t.lastWatchedAt!, tz)} and haven’t been back.`, ref: ref(t) });
  }

  // A genre you keep scoring low.
  const avg = all.scores.average ?? 7;
  const low = scored.filter((t) => t.score! <= 4);
  const lowByGenre = new Map<string, { low: number; total: number; sample?: StatTitle }>();
  for (const t of scored) for (const g of facts.get(t.id)?.genres ?? []) {
    const cur = lowByGenre.get(g) ?? { low: 0, total: 0 };
    cur.total++;
    if (t.score! <= 4) { cur.low++; cur.sample ??= t; }
    lowByGenre.set(g, cur);
  }
  const lowGenre = [...lowByGenre.entries()].filter(([, c]) => c.low >= 3 && c.low / c.total >= 0.3 && avg >= 6)
    .sort((a, b) => b[1].low / b[1].total - a[1].low / a[1].total)[0];
  if (lowGenre) out.push({ key: "lowGenre", title: `${lowGenre[0]} keeps getting a 4 or lower from you.`,
    detail: `${cap(words(lowGenre[1].low))} of your ${words(low.length)} lowest scores. You keep pressing Play anyway.`, ref: lowGenre[1].sample && ref(lowGenre[1].sample) });

  // Every film 10 from one country.
  const movieTens = tens.filter((t) => t.type === "movie" && facts.get(t.id)?.country);
  const countries = new Set(movieTens.map((t) => facts.get(t.id)!.country!.split(",")[0].trim()));
  if (movieTens.length >= 4 && movieTens.length === tens.filter((t) => t.type === "movie").length && countries.size === 1) {
    const [country] = countries;
    const best = Math.max(0, ...scored.filter((t) => t.type === "movie" && facts.get(t.id)?.country && !facts.get(t.id)!.country!.startsWith(country)).map((t) => t.score!));
    out.push({ key: "tensCountry", title: `Every film you’ve given a 10 is from ${country}.`,
      detail: best ? `Your best from anywhere else is a ${best}.` : undefined, ref: ref(movieTens[0]) });
  }

  // Waiting on your list.
  if (planned.oldest && now - planned.oldest.addedAt >= 180 * DAY) {
    const yrs = (now - planned.oldest.addedAt) / (365 * DAY);
    const span = yrs >= 1.75 ? `${words(Math.round(yrs))} years` : yrs >= 0.9 ? "a year" : `${words(Math.round(yrs * 12))} months`;
    out.push({ key: "plan", title: `${planned.oldest.name} has been on your list for ${span}.`,
      detail: planned.monthsToClear ? `${plural(planned.count, "title")} are waiting. At this year’s pace that’s about ${planned.monthsToClear >= 24 ? `${Math.round(planned.monthsToClear / 12)} years` : `${planned.monthsToClear} months`}.` : `${plural(planned.count, "title")} are waiting.`,
      ref: { id: planned.oldest.id, type: planned.oldest.type, name: planned.oldest.name, poster: planned.oldest.poster } });
  }

  // The biggest commitment.
  const franchises = new Map<string, { minutes: number; episodes: number; title: StatTitle }>();
  for (const t of titles) if (t.type === "series") {
    const k = franchiseOf(t.name);
    const kind = kindOf(t);
    const eps = Math.max(t.watchedEpisodes ?? 0, t.events.length);
    const cur = franchises.get(k) ?? { minutes: 0, episodes: 0, title: t };
    cur.minutes += eps * (t.runtime ?? facts.get(t.id)?.runtime ?? FALLBACK[kind]);
    cur.episodes += eps;
    if (t.name.length < cur.title.name.length) cur.title = t;
    franchises.set(k, cur);
  }
  const biggest = [...franchises.values()].sort((a, b) => b.minutes - a.minutes)[0];
  if (biggest && biggest.episodes >= 100 && biggest.minutes >= 2 * 1440)
    out.push({ key: "commitment", title: `${biggest.title.name} alone took about ${words(Math.round(biggest.minutes / 1440))} days of your life.`,
      detail: `${biggest.episodes.toLocaleString("en-US")} episodes.`, ref: ref(biggest.title) });

  // How often you finish.
  if (finish.animeStarted >= 10 && finish.animeFinished / finish.animeStarted >= 0.8)
    out.push({ key: "finish", title: `${finish.animeFinished} of ${finish.animeStarted} settled anime are finished.`,
      detail: "Counts finished, paused, dropped and long-inactive series. Recent in-progress shows are left out." });

  const recent = year ?? all;
  if (recent.gap && recent.gap.days >= 28)
    out.push({ key: "gap", title: `${cap(words(Math.round(recent.gap.days / 7)))} weeks without a watch logged.`,
      detail: `Between ${dayLabel(recent.gap.from, tz)} and ${dayLabel(recent.gap.to, tz)}, nothing new in your history.` });
  if (recent.binge && recent.binge.episodes >= 10)
    out.push({ key: "binge", title: `Longest binge: ${recent.binge.episodes} episodes of ${recent.binge.name}.`,
      detail: recent.binge.days === 1 ? `All on ${dayLabel(recent.binge.from, tz)}.` : `${cap(words(recent.binge.days))} days, from ${dayLabel(recent.binge.from, tz)} to ${dayLabel(recent.binge.to, tz)}.`,
      ref: { id: recent.binge.id, type: recent.binge.type, name: recent.binge.name, poster: recent.binge.poster } });
  if (all.medianStart !== undefined && all.sessions >= 20) {
    const late = all.clock.slice(22).concat(all.clock.slice(0, 4)).reduce((a, b) => a + b, 0) / Math.max(1, all.sessions);
    if (late >= 0.4) out.push({ key: "clock", title: `You usually press Play around ${clockLabel(all.medianStart)}.`,
      detail: `${Math.round(late * 100)}% of what you start begins after 10 p.m.` });
  }

  const finished = titles.filter((t) => watchedEnough(t) && t.year);
  const old = finished.filter((t) => Number.parseInt(t.year!, 10) < 2000).length;
  if (finished.length >= 50 && old / finished.length <= 0.03)
    out.push({ key: "decades", title: old ? `Only ${words(old)} ${old === 1 ? "thing" : "things"} you’ve watched ${old === 1 ? "is" : "are"} older than 2000.` : "Nothing you’ve watched is older than 2000." });

  if (people[0] && people[0].count >= 3)
    out.push({ key: "person", title: `${people[0].name} is in ${words(people[0].count)} things you scored 8 or higher.` });

  if (all.scores.count >= 20) {
    const mode = all.scores.hist.indexOf(Math.max(...all.scores.hist)) + 1;
    const every = all.scores.tens ? Math.round(all.scores.count / all.scores.tens) : 0;
    out.push({ key: "scores", title: `A ${mode} is your usual score.`, detail: every ? `You give a 10 about once every ${every} scores.` : "You’ve never given a 10." });
  }
  return out;
}

function personaFor(all: Period, finish: Stats["finish"], tensCountry?: string): Stats["persona"] {
  const tags: string[] = [];
  if (all.animeShare >= 0.5) tags.push(`${Math.round(all.animeShare * 100)}% anime`);
  const finishRate = finish.animeStarted + finish.showsStarted >= 10 ? (finish.animeFinished + finish.showsFinished) / (finish.animeStarted + finish.showsStarted) : 0;
  const night = all.sessions >= 20 && all.clock.slice(22).concat(all.clock.slice(0, 4)).reduce((a, b) => a + b, 0) / all.sessions >= 0.4;
  if (night) tags.push("Night owl");
  if (finishRate >= 0.85) tags.push("Finisher");
  const avg = all.scores.average;
  if (avg !== undefined && all.scores.count >= 20 && avg <= 6.5) tags.push("Tough critic");
  if (avg !== undefined && all.scores.count >= 20 && avg >= 8.2) tags.push("Easy to please");
  if (tensCountry) tags.push(`${tensCountry} films`);
  if (all.binge && all.binge.episodes >= 30) tags.push("Binger");
  const name = finishRate >= 0.85 ? "The Finisher" : night ? "The Night Owl" : all.binge && all.binge.episodes >= 30 ? "The Binger"
    : avg !== undefined && avg <= 6.5 && all.scores.count >= 20 ? "The Tough Critic" : all.genres.length >= 6 && all.genres[0].share < 0.25 ? "The Explorer" : "The Regular";
  const line = name === "The Finisher" ? `You finished ${Math.round(finishRate * 100)}% of completed, paused, dropped or long-inactive shows${avg ? `, and a ${Math.round(avg)} is a good score from you` : ""}.`
    : name === "The Night Owl" ? `At least 40% of your estimated sessions start between 10 p.m. and 4 a.m.`
      : name === "The Binger" ? `${all.binge!.episodes} episodes of ${all.binge!.name} in ${words(all.binge!.days)} days.`
        : name === "The Tough Critic" ? `Your average score is ${avg}. A 10 from you means something.`
          : name === "The Explorer" ? `No genre takes more than a quarter of your time.` : `Your recorded watches are still building a picture of your taste.`;
  return { name, line, tags: tags.slice(0, 4) };
}

export function buildStats(input: StatsInput): Stats {
  const { now, timeZone: tz, facts } = input;
  const titles = input.titles.filter((t) => t.status !== "plantowatch");
  const evs = events(titles, facts);
  const all = period("all", evs, titles, facts, now, tz);
  const thisYear = localParts(now, tz).year;
  const years = [...new Set(evs.filter((e) => e.t !== undefined && !e.bulk).map((e) => yearOf(e.t!, e.dateOnly ? "UTC" : tz)))]
    .filter((y) => y >= thisYear - 2).sort((a, b) => b - a);
  if (!years.includes(thisYear)) years.unshift(thisYear);
  const periods = [all, ...years.map((y) => period(String(y), evs, titles, facts, now, tz))];
  const year = periods.find((p) => p.key === String(thisYear));

  // Started means watched at least one episode; finished means completed. In progress lately doesn't count yet.
  const stale = (t: StatTitle) => t.status === "dropped" || t.status === "hold" || (t.status === "watching" && (!t.lastWatchedAt || now - t.lastWatchedAt > 90 * DAY));
  const series = titles.filter((t) => t.type === "series" && (t.status === "completed" || ((t.watchedEpisodes ?? 0) > 0 && stale(t))));
  const finish = {
    animeStarted: series.filter((t) => t.anime).length, animeFinished: series.filter((t) => t.anime && t.status === "completed").length,
    showsStarted: series.filter((t) => !t.anime).length, showsFinished: series.filter((t) => !t.anime && t.status === "completed").length,
  };

  const enough = titles.filter(watchedEnough);
  const decadeMap = new Map<number, number>();
  for (const t of enough) { const y = Number.parseInt(t.year ?? "", 10); if (y > 1900) decadeMap.set(Math.floor(y / 10) * 10, (decadeMap.get(Math.floor(y / 10) * 10) ?? 0) + 1); }
  const decades = [...decadeMap.entries()].sort((a, b) => a[0] - b[0]).map(([decade, count]) => ({ decade, count }));

  const peopleMap = new Map<string, { name: string; role: "cast" | "director"; ids: string[] }>();
  for (const t of enough) if ((t.score ?? 0) >= 8) {
    const f = facts.get(t.id);
    if (!f) continue;
    for (const [role, names] of [["director", f.director], ["cast", f.cast.slice(0, 4)]] as const)
      for (const name of names) {
        const cur = peopleMap.get(name) ?? { name, role, ids: [] };
        if (!cur.ids.includes(t.id)) cur.ids.push(t.id);
        peopleMap.set(name, cur);
      }
  }
  const people = [...peopleMap.values()].filter((p) => p.ids.length >= 2).sort((a, b) => b.ids.length - a.ids.length || (a.role === "director" ? -1 : 1))
    .slice(0, 8).map((p) => ({ ...p, count: p.ids.length }));

  // Taste map: each title with known genres; the drift line follows the yearly average.
  const points: Stats["taste"]["points"] = [];
  const perYear = new Map<number, { x: number; y: number; n: number }>();
  const realYear = new Map<string, number>();
  for (const e of evs) if (e.t !== undefined && !e.bulk) realYear.set(e.title.id, Math.max(realYear.get(e.title.id) ?? 0, yearOf(e.t, e.dateOnly ? "UTC" : tz)));
  for (const t of enough) {
    const g = facts.get(t.id)?.genres;
    if (!g?.length) continue;
    const p = place(t.id, g, t.anime);
    if (points.length < 500) points.push({ id: t.id, name: t.name, ...p, kind: kindOf(t), score: t.score });
    const y = realYear.get(t.id);
    if (y) { const cur = perYear.get(y) ?? { x: 0, y: 0, n: 0 }; cur.x += p.x; cur.y += p.y; cur.n++; perYear.set(y, cur); }
  }
  const drift = [...perYear.entries()].filter(([, c]) => c.n >= 5).sort((a, b) => a[0] - b[0])
    .map(([year, c]) => ({ year, x: round1((c.x / c.n) * 100) / 100, y: round1((c.y / c.n) * 100) / 100 }));
  const labels: Stats["taste"]["labels"] = [];
  for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const inQ = points.filter((p) => (p.x >= 0.5 ? 1 : 0) === qx && (p.y >= 0.5 ? 1 : 0) === qy);
    if (inQ.length < 5) continue;
    const count = new Map<string, number>();
    for (const p of inQ) for (const g of facts.get(p.id)?.genres ?? []) count.set(g, (count.get(g) ?? 0) + 1);
    const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([g]) => g);
    labels.push({ x: qx ? 0.75 : 0.25, y: qy ? 0.92 : 0.08, text: top.join(" and ") });
  }

  // You and your friend.
  let friend: Stats["friend"];
  if (input.friend) {
    const f = input.friend;
    const both = enough.filter((t) => t.score !== undefined && f.scores.has(t.id));
    const diffs = both.map((t) => ({ t, mine: t.score!, theirs: f.scores.get(t.id)! }));
    const split = diffs.sort((a, b) => Math.abs(b.mine - b.theirs) - Math.abs(a.mine - a.theirs))[0];
    const ask = enough.filter((t) => t.score !== undefined && !f.scores.has(t.id) && (t.score ?? 0) >= 7)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0)).slice(0, 6)
      .map((t) => ({ id: t.id, type: t.type, name: t.name, poster: t.poster }));
    friend = {
      name: f.name, hue: f.hue, bothScored: both.length,
      agreement: both.length >= 5 ? Math.round((diffs.filter((d) => Math.abs(d.mine - d.theirs) <= 1).length / both.length) * 100) / 100 : undefined,
      averageGap: both.length >= 5 ? round1(diffs.reduce((a, d) => a + d.mine - d.theirs, 0) / both.length) : undefined,
      split: both.length >= 5 && split && Math.abs(split.mine - split.theirs) >= 3
        ? { id: split.t.id, type: split.t.type, name: split.t.name, poster: split.t.poster, mine: split.mine, theirs: split.theirs } : undefined,
      togetherMinutes: Math.round(f.togetherMinutes), parties: f.parties, ask,
    };
  }

  // What's waiting, and how long it would take at this year's pace.
  const plannedTitles = input.titles.filter((t) => t.status === "plantowatch");
  const oldest = plannedTitles.filter((t) => t.addedAt).sort((a, b) => a.addedAt! - b.addedAt!)[0];
  // Pace: titles you got through in the last year, by when Simkl last saw you on them.
  const pace = enough.filter((t) => (t.lastWatchedAt ?? 0) >= now - 365 * DAY).length / 12;
  const planned: Stats["planned"] = {
    count: plannedTitles.length,
    oldest: oldest ? { id: oldest.id, type: oldest.type, name: oldest.name, poster: oldest.poster, addedAt: oldest.addedAt! } : undefined,
    monthsToClear: pace >= 1 && plannedTitles.length ? Math.round(plannedTitles.length / pace) : undefined,
  };

  const insights = insightsFor(input, all, year, titles, finish, people, planned);
  const tensCountry = insights.some((i) => i.key === "tensCountry") ? insights.find((i) => i.key === "tensCountry")!.title.match(/from (.+)\.$/)?.[1] : undefined;
  const persona = personaFor(all, finish, tensCountry);

  const firstReal = evs.filter((e) => e.t !== undefined && !e.bulk).reduce((a, e) => Math.min(a, e.t!), Infinity);
  const factsWanted = enough.length;
  return {
    coverage: {
      titles: enough.length,
      since: Number.isFinite(firstReal) ? firstReal : undefined,
      kridaSince: input.kridaSince,
      bulkTitles: all.bulkTitles,
      factsFor: enough.filter((t) => facts.get(t.id)?.genres.length).length,
      factsWanted,
      undated: titles.some((t) => t.type === "series" && (t.watchedEpisodes ?? 0) > 0 && t.events.every((e) => e.t === undefined)),
    },
    periods, finish, decades, people,
    taste: { points, drift, labels },
    friend, insights, persona, planned,
  };
}
