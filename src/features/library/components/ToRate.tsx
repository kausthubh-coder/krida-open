import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { toast } from "../../../ui/toast";
import { ArrowBendUpRightIcon, CardsIcon, CheckCircleIcon, EyeSlashIcon, InfoIcon, StarIcon } from "@phosphor-icons/react";
import { api } from "../../../../convex/_generated/api";
import { useAuthed } from "../../../data/session";
import { useRate } from "../../../data/mine";
import { useBacklog, type Backlog } from "../libraryData";
import { art } from "../../../data/cinemeta";
import { plural } from "../../../ui/format";
import { scoreLabels } from "../../../ui/scoreValues";
import { shortDate, titleLink } from "../filters";
import { Art } from "../../../ui/artwork";
import { Sheet } from "../../../ui/sheet";
import { Button, EmptyState, Kbd, cx } from "../../../ui/ui";
import { ScaleEnds, ScoreScale } from "../../title";
import { Growing, SectionHead } from "./shared";

type Item = Backlog["items"][number];
type Done = { score: number } | { unwatched: true };
const GROUPS = [
  { key: "recent", title: "Finished recently" },
  { key: "partway", title: "Stopped partway", note: "Dropped, on hold or still going, after three or more episodes" },
  { key: "import", title: "From your Simkl import" },
] as const;

const posterOf = (i: Item) => i.poster ?? art.poster(i.imdb ?? i.id);
function metaOf(i: Item) {
  const kind = i.type === "movie" ? "Movie" : "Show";
  const eps = i.watchedEpisodes && i.totalEpisodes ? `${i.watchedEpisodes} of ${i.totalEpisodes} episodes` : i.watchedEpisodes ? plural(i.watchedEpisodes, "episode", "episodes") : undefined;
  const when = i.group !== "import" && i.at ? `${i.type === "movie" || i.status === "completed" ? "Finished" : "Last watched"} ${shortDate(i.at)}` : undefined;
  const state = i.status === "dropped" ? (eps ? `Dropped after ${eps}` : "Dropped") : i.status === "hold" ? [eps, "On hold"].filter(Boolean).join(" · ") : eps;
  return [kind, i.year && i.type === "movie" ? i.year : undefined, state, when].filter(Boolean).join(" · ");
}

/**
 * Your rating backlog: everything watched enough to judge, without a score. One tap saves. The list is
 * frozen while you work so rows never move under the pointer; rated rows stay with an Undo until you leave.
 */
export function ToRate({ show, noMatch }: { show: (i: Item) => boolean; noMatch: ReactNode }) {
  const { token } = useAuthed();
  const live = useBacklog();
  const [frozen, setFrozen] = useState<typeof live>(undefined);
  if (live !== undefined && frozen === undefined) setFrozen(live);
  const data = frozen ?? live;
  const simkl = useQuery(api.simkl.syncState, { token });
  const rate = useRate();
  const unwatch = useMutation(api.library.markUnwatched);
  const restore = useMutation(api.library.restoreWatched);
  const [done, setDone] = useState<Record<string, Done>>({});
  const [focus, setFocus] = useState<string | null>(null);

  const inFlight = useRef(new Set<string>());
  const clearDone = (id: string) => setDone((d) => { const next = { ...d }; delete next[id]; return next; });

  const items = data?.items.filter(show) ?? [];
  const left = items.filter((i) => !done[i.id]);
  const sendsToSimkl = !!simkl?.writeBack && simkl.canWrite && !simkl.needsReconnect;

  const score = async (i: Item, n: number) => {
    if (inFlight.current.has(i.id)) return false;
    inFlight.current.add(i.id);
    // Rated on the next frame; the save catches up, and a failure puts the title back.
    setDone((d) => ({ ...d, [i.id]: { score: n } }));
    try {
      await rate({ id: i.id, type: i.type, name: i.name, poster: i.poster }, { rating: n });
      return true;
    } catch { clearDone(i.id); toast.error(`Couldn’t save your score for ${i.name}. Try again.`); return false; }
    finally { inFlight.current.delete(i.id); }
  };
  const undoScore = async (i: Item) => {
    if (inFlight.current.has(i.id)) return;
    inFlight.current.add(i.id);
    try { await rate({ id: i.id, type: i.type, name: i.name, poster: i.poster }, { rating: null }); clearDone(i.id); }
    catch { toast.error("Couldn't undo that score. Try again."); }
    finally { inFlight.current.delete(i.id); }
  };
  const undoUnwatch = async (i: Item) => {
    if (inFlight.current.has(i.id)) return;
    inFlight.current.add(i.id);
    try {
      const result = await restore({ token, id: i.id });
      clearDone(i.id);
      if (result === "simkl") toast(`${i.name} is back in your history`, { description: "Simkl may already have removed it. Check its history before adding it back." });
    } catch { toast.error("Couldn't undo that. Try again."); }
    finally { inFlight.current.delete(i.id); }
  };
  const notWatched = async (i: Item) => {
    if (inFlight.current.has(i.id)) return false;
    inFlight.current.add(i.id);
    try {
      await unwatch({ token, item: { id: i.id, type: i.type, name: i.name, year: i.year } });
      setDone((d) => ({ ...d, [i.id]: { unwatched: true } }));
      toast(`Removed ${i.name} from your watched history`, {
        duration: 8000,
        description: i.onSimkl && sendsToSimkl ? "Simkl updates in about a minute. Your picks forget it too." : "Your picks and stats forget it too.",
        action: { label: "Undo", onClick: () => void undoUnwatch(i) },
      });
      return true;
    } catch { toast.error(`Couldn't remove ${i.name}. Try again.`); return false; }
    finally { inFlight.current.delete(i.id); }
  };

  if (data === undefined) return <div aria-busy className="flex max-w-6xl flex-col gap-8">
    <div className="flex flex-col gap-2"><p role="status" className="sr-only">Finding what you haven’t rated…</p><div className="skeleton h-6 w-44 rounded-full" /><div className="skeleton h-4 w-72 max-w-full rounded-full" /></div>
    <ul className="flex flex-col">{Array.from({ length: 6 }, (_, i) => <li key={i} className="flex min-h-[96px] items-center gap-4 border-t border-line py-3">
      <div className="skeleton aspect-2/3 w-12 rounded-control" /><div className="flex flex-col gap-1.5"><div className="skeleton h-3.5 w-48 rounded-full" /><div className="skeleton h-3 w-32 rounded-full" /></div>
    </li>)}</ul>
  </div>;

  if (items.length === 0) return data.items.length ? noMatch : <EmptyState icon={<StarIcon />} title="No titles waiting for a score"
    description={data.tooFew.count ? "Shows appear after three episodes, half a short show, or when you mark them finished. One episode of a long show stays out." : "When you finish something new, it waits here for your score."} />;

  return (
    <div className="flex max-w-6xl flex-col gap-10">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
        {/* The page title already counts what's left, so this only says how it works, or that you're done. */}
        <div className="min-w-0 flex-1">
          {!left.length && <h2 className="mb-1 text-title font-semibold">That’s all of them</h2>}
          <p className="text-body text-fg-muted">One tap saves. Each score sharpens your picks{sendsToSimkl ? ", and whole-title scores sync to Simkl" : ""}.</p>
        </div>
        {left.length > 0 && <Button variant="primary" icon={<CardsIcon />} onClick={() => setFocus(left[0].id)} className="max-sm:w-full">Rate one at a time</Button>}
      </div>

      {GROUPS.map((g) => {
        const rows = items.filter((i) => i.group === g.key);
        if (!rows.length) return null;
        const note = g.key === "import" && data.importedOn ? `Logged together on ${shortDate(data.importedOn)} · ${rows.length}` : "note" in g ? `${g.note} · ${rows.length}` : String(rows.length);
        return (
          <section key={g.key} className="flex flex-col gap-3">
            <SectionHead title={g.title} note={note} />
            {g.key === "import" && <p className="-mt-1 text-body text-fg-faint">These came in all at once. If one isn’t really yours, choose Didn’t watch it.</p>}
            <Growing id={`rate-${g.key}`} items={rows} step={30} className="flex flex-col" render={(i) => <Row key={i.id} item={i} done={done[i.id]} onScore={(n) => void score(i, n)}
              onUnwatch={() => void notWatched(i)} onUndo={() => void ("score" in (done[i.id] ?? {}) ? undoScore(i) : undoUnwatch(i))}
              onOpen={() => setFocus(i.id)} />} />
          </section>
        );
      })}

      {data.tooFew.count > 0 && <div className="flex items-start gap-3 rounded-card bg-surface p-4 text-body text-fg-muted shadow-raised">
        <InfoIcon className="mt-0.5 shrink-0 text-[18px] text-fg-faint" aria-hidden />
        <p>{plural(data.tooFew.count, "show is", "shows are")} waiting for more watch history{data.tooFew.names.length ? `, like ${data.tooFew.names.slice(0, 2).join(" and ")}` : ""}. They appear after three episodes, half a short show, or when you mark the show finished.</p>
      </div>}

      {focus !== null && <RateOne items={items} done={done} start={focus} onClose={() => setFocus(null)}
        onScore={score} onUnwatch={notWatched} />}
    </div>
  );
}

/**
 * A row per title. From 1100px the 1–10 scale sits in the row; it fills up to the number you point at, and
 * one tap saves. Focus follows the change, to Undo and back, so the keyboard never drops to the page.
 */
function Row({ item, done, onScore, onUnwatch, onUndo, onOpen }: {
  item: Item; done?: Done; onScore: (n: number) => void; onUnwatch: () => void; onUndo: () => void; onOpen: () => void;
}) {
  const [pointed, setHover] = useState<number | null>(null);
  // The scale leaves when a score lands, without a mouseleave, so a finished row forgets what was pointed at.
  const hover = done ? null : pointed;
  const row = useRef<HTMLLIElement>(null);
  const refocus = useRef(false);
  const mark = () => { refocus.current = !!row.current?.contains(document.activeElement); };
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const next = [...(row.current?.querySelectorAll<HTMLElement>("[data-refocus], [role=radiogroup] [tabindex='0']") ?? [])].find((el) => el.offsetParent !== null);
    next?.focus();
  }, [done]);
  return (
    <li ref={row} className="flex min-h-[96px] items-center gap-4 border-t border-line py-3">
      <Link to={titleLink(item)} className="shrink-0 rounded-control outline-offset-2" tabIndex={-1} aria-hidden>
        <Art src={posterOf(item)} alt="" fallbackTitle={item.name} className="aspect-2/3 w-12 rounded-control img-outline" />
      </Link>
      <div className="min-w-0 flex-1">
        <Link to={titleLink(item)} className="line-clamp-2 w-fit max-w-full text-body font-medium break-words hover:underline hover:decoration-white/30 hover:underline-offset-4 min-[1100px]:line-clamp-1" title={item.name}>{item.name}</Link>
        {/* Pointing at a score names it here, where the eye already is, instead of in a slot of its own. */}
        <p className={cx("mt-0.5 truncate text-caption tabular-nums", hover ? "text-fg-muted" : "text-fg-faint")}>{hover ? `${hover} · ${scoreLabels[hover]}` : metaOf(item)}</p>
      </div>
      {done ? (
        <p className="flex shrink-0 items-center gap-2 text-body text-fg-muted" role="status">
          {"score" in done
            ? <><CheckCircleIcon weight="fill" className="text-[20px] text-fg" aria-hidden />Rated <span className="font-medium text-fg tabular-nums">{done.score}</span></>
            : <><EyeSlashIcon className="text-[18px]" aria-hidden />Not watched</>}
          <span aria-hidden>·</span>
          <button data-refocus onClick={() => { mark(); onUndo(); }} className="relative rounded-control font-medium text-fg underline decoration-white/30 underline-offset-4 after:absolute after:-inset-3 hover:decoration-white">Undo</button>
        </p>
      ) : <>
        <ScoreScale label={`Score ${item.name}`} value={null} variant="inline" className="hidden shrink-0 min-[1100px]:flex"
          onPreview={setHover} onPick={(n) => { mark(); onScore(n); }} />
        <span className="hidden shrink-0 min-[1100px]:inline-flex"><Button variant="ghost" className="min-h-11" icon={<EyeSlashIcon />} onClick={() => { mark(); onUnwatch(); }}>Didn’t watch it</Button></span>
        <span className="shrink-0 min-[1100px]:hidden"><Button data-refocus className="min-h-11" icon={<StarIcon />} onClick={onOpen}>Rate</Button></span>
      </>}
    </li>
  );
}

/** One title at a time, for a quick pass: big targets, and the keyboard (1–9, 0 for 10, H, S, ←). */
function RateOne({ items, done, start, onClose, onScore, onUnwatch }: {
  items: Item[]; done: Record<string, Done>; start: string; onClose: () => void;
  onScore: (i: Item, n: number) => Promise<boolean>; onUnwatch: (i: Item) => Promise<boolean>;
}) {
  // The queue is fixed when the sheet opens: what's left, starting from the title you picked.
  const [queue] = useState(() => { const open = items.filter((i) => !done[i.id] || i.id === start); const at = open.findIndex((i) => i.id === start); return [...open.slice(at), ...open.slice(0, at)]; });
  const [index, setIndex] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const item = queue[index] as Item | undefined;
  const chosen = item && done[item.id] && "score" in done[item.id] ? (done[item.id] as { score: number }).score : null;
  const next = () => { setHover(null); setIndex((n) => n + 1); };
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<boolean>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { if (await fn()) next(); }
    finally { pending.current = false; setBusy(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key the scale already used (arrows moving along it) isn't a shortcut too.
      if (e.defaultPrevented || pending.current || !item || e.repeat || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (/^[0-9]$/.test(k)) { e.preventDefault(); act(() => onScore(item, k === "0" ? 10 : Number(k))); }
      else if (k === "h") { e.preventDefault(); act(() => onUnwatch(item)); }
      else if (k === "s") { e.preventDefault(); next(); }
      else if (k === "arrowleft" && index > 0) { e.preventDefault(); setIndex((n) => n - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const shown = hover ?? chosen;
  return (
    <Sheet open onClose={onClose} variant="center" wide title="Rate what you’ve watched"
      description={item ? <span className="tabular-nums">{index + 1} of {queue.length}</span> : undefined}>
      <div className="-mx-6 -mt-4 mb-5 h-0.5 bg-white/8"><div className="h-full bg-fg transition-[width] duration-200" style={{ width: `${(Math.min(index, queue.length) / Math.max(1, queue.length)) * 100}%` }} /></div>
      {!item ? (
        <EmptyState icon={<CheckCircleIcon />} title="That’s everything for now" description="New things you finish will wait for your score in Library."
          action={<Button variant="primary" onClick={onClose}>Done</Button>} />
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex items-end gap-5 max-sm:items-center">
            <Art src={posterOf(item)} alt="" fallbackTitle={item.name} eager className="aspect-2/3 w-32 shrink-0 rounded-card shadow-overlay img-outline max-sm:w-20" />
            <div className="min-w-0">
              {item.group === "import" && <p className="text-caption font-semibold tracking-[0.08em] text-fg-faint uppercase">From your Simkl import</p>}
              <p className="mt-1 line-clamp-3 font-display text-display font-semibold text-balance break-words" title={item.name}>{item.name}</p>
              <p className="mt-1 text-body text-fg-faint">{metaOf(item)}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-body font-medium">How was it?</p>
              <p aria-live="polite" aria-busy={busy} className="text-body text-fg-muted tabular-nums">{shown ? `${shown} · ${scoreLabels[shown]}` : ""}</p>
            </div>
            {/* The score you pick is the lens at once; the next title follows when the save lands. */}
            <ScoreScale label={`Score ${item.name}`} value={chosen} size="lg" className="sm:grid-cols-10" onPreview={setHover}
              onPick={(n) => void act(() => onScore(item, n))} />
            <ScaleEnds />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" className="-ml-3 min-h-11" icon={<EyeSlashIcon />} onClick={() => void act(() => onUnwatch(item))}>Didn’t watch it <Kbd>H</Kbd></Button>
            <Button variant="ghost" className="min-h-11" icon={<ArrowBendUpRightIcon />} disabled={busy} onClick={next}>Skip <Kbd>S</Kbd></Button>
            <p className="ml-auto hidden items-center gap-1.5 text-caption text-fg-faint sm:flex">Press <Kbd>1</Kbd>–<Kbd>9</Kbd>, <Kbd>0</Kbd> for 10</p>
          </div>
        </div>
      )}
    </Sheet>
  );
}
