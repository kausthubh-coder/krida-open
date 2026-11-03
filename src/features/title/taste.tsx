import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "convex-helpers/react/cache/hooks";
import { ConvexError } from "convex/values";
import { CloudCheckIcon, CloudSlashIcon, MagnifyingGlassIcon, StarIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { useAuthed } from "../../data/session";
import { useRate, type RatingChange } from "../../data/mine";
import { starter } from "../../data/api";
import { starterBatch, type StarterBatch, type StarterItem } from "../home";
import { useOwnRows, useSimklRows } from "../../data/rows";
import { WATCH_STATUSES } from "../../data/watchStatus";
import { scoreLabels } from "../../ui/scoreValues";
import { art, getMeta, useAsync } from "../../data/cinemeta";
import { Art } from "../../ui/artwork";
import { Sheet } from "../../ui/sheet";
import { Button, ButtonLink, cx, IconButton, Spinner, EmptyState } from "../../ui/ui";
import { toolbarItem } from "./watchStatus";

type Item = { id: string; type: "movie" | "series"; name: string; poster?: string; year?: string };
// Fields sit inside glass sheets, so they're plain fills: glass inside glass can't see the page.
const fieldClass = "min-h-11 w-full rounded-control fill-quiet bg-white/6 px-3 py-2 text-body text-fg outline-offset-2 hover:bg-white/10";
const SCORES = Array.from({ length: 10 }, (_, i) => i + 1);
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input, textarea, select");

/**
 * The 1–10 scale wherever you score something. One tab stop: arrows move along it, Enter or Space picks.
 * With `follow`, arrows change the choice as they go (a draft, saved later); otherwise they only preview,
 * because picking saves. The picked score is the lens, sliding between numbers on the spring.
 */
export function ScoreScale({ label, value, onPick, onCommit, onPreview, follow = false, disabled = false, size = "md", variant = "tiles", className }: {
  label: string;
  value: number | null;
  onPick: (score: number) => void;
  /** Enter on a score: pick it and finish (save). */
  onCommit?: (score: number) => void;
  /** The score under the pointer or focus, to name it where the eye already is. */
  onPreview?: (score: number | null) => void;
  follow?: boolean;
  disabled?: boolean;
  size?: "md" | "lg";
  /** Tiles for sheets; inline for a row of plain numbers that fill up to the one you point at. */
  variant?: "tiles" | "inline";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const show = (n: number | null) => { setPreview(n); onPreview?.(n); };
  const stop = at ?? value ?? 1;
  // A choice made elsewhere (a number key) brings focus along when it's already on the scale.
  useEffect(() => {
    const root = ref.current;
    if (!follow || value === null || !root?.contains(document.activeElement)) return;
    root.querySelector<HTMLButtonElement>(`[data-score="${value}"]`)?.focus();
  }, [follow, value, ref]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = Number((e.target as HTMLElement).dataset.score) || stop;
    // Following, Enter keeps what's chosen, which a number key may have changed without moving focus.
    if (e.key === "Enter" && onCommit) { e.preventDefault(); if (!disabled) onCommit(follow && value !== null ? value : from); return; }
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? from + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? from - 1
      : e.key === "Home" ? 1 : e.key === "End" ? 10 : null;
    if (to === null) return;
    e.preventDefault();
    const next = Math.min(10, Math.max(1, to));
    ref.current?.querySelector<HTMLButtonElement>(`[data-score="${next}"]`)?.focus();
    if (follow && !disabled) onPick(next);
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}
      onMouseLeave={() => show(null)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) show(null); }}
      // Tiles keep to the sheet's edges, in line with what's above and below them.
      className={cx("relative", variant === "tiles" ? "grid grid-cols-[repeat(5,auto)] justify-between gap-y-1.5" : "flex", className)}>
      {SCORES.map((n) => {
        const picked = value === n;
        return (
          <button key={n} type="button" role="radio" data-score={n} data-lens={n} aria-checked={picked} aria-label={`${n}, ${scoreLabels[n]}`}
            tabIndex={n === stop ? 0 : -1} aria-disabled={disabled || undefined}
            onClick={() => { if (!disabled) onPick(n); }} onMouseEnter={() => show(n)} onFocus={() => { setAt(n); show(n); }}
            className={cx("press relative grid place-items-center font-medium tabular-nums outline-offset-2 select-none",
              variant === "inline" ? cx("size-11 rounded-control text-body",
                preview === n ? "bg-white/12 text-fg" : preview !== null && n < preview ? "text-fg" : "text-fg-faint hover:text-fg")
                : cx("rounded-full", size === "lg" ? "size-14 text-title" : "size-11 text-subhead",
                  picked ? "bg-accent text-on-accent" : "fill-quiet text-fg-muted hover:text-fg"),
              disabled && "cursor-default opacity-60")}>
            {n}
          </button>
        );
      })}
    </div>
  );
}

/** The scale's two ends, so the numbers read as a feeling. */
export function ScaleEnds() {
  return <div aria-hidden className="flex justify-between text-caption text-fg-faint"><span>{scoreLabels[1]}</span><span>{scoreLabels[10]}</span></div>;
}

export function RateButton({ item, variant = "pill", className }: { item: Item; variant?: "pill" | "toolbar"; className?: string }) {
  const { token } = useAuthed();
  const saved = useQuery(api.ratings.details, { token, id: item.id });
  const rate = useRate();
  return <RateMenu item={item} variant={variant} className={className} value={saved?.rating ?? null} loading={saved === undefined} onChange={(change) => rate({ id: item.id, type: item.type, name: item.name, poster: item.poster }, change)} />;
}

/**
 * The dialog top layer stays reachable inside clipped heroes, rails and poster cards. `instant` saves a whole-title
 * score the moment it's picked, for quick passes like the starter sheet.
 */
export function RateMenu({ item, value, onChange, size = "lg", loading = false, variant = "icon", instant = false, className }: {
  item: Item;
  value: number | null;
  onChange: (change: RatingChange) => Promise<unknown>;
  size?: "sm" | "lg";
  align?: "center" | "end";
  loading?: boolean;
  variant?: "icon" | "card" | "pill" | "secondary" | "toolbar";
  instant?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Counts saves, so the new score rises into its button: the confirmation lands where the sheet closes onto.
  const [saves, setSaves] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  const save = async (change: RatingChange) => { await onChange(change); setSaves((n) => n + 1); };
  const rated = value !== null;
  const triggerProps = {
    "aria-haspopup": "dialog" as const, "aria-expanded": open, "aria-busy": loading || undefined, onClick: () => setOpen(true),
    "aria-label": rated ? `Your rating: ${value} out of 10. Change your rating for ${item.name}` : `Rate ${item.name}`,
    title: rated ? "Your rating" : "Rate it",
  };
  const star = <StarIcon weight={rated ? "fill" : "regular"} />;
  const score = (rest: string) => <span key={saves} className={cx("tabular-nums", saves > 0 && "rise-in")}>{value}<span className={rest}>/10</span></span>;
  return <>
    {variant === "card" ? <button ref={trigger} type="button" {...triggerProps} title={undefined}
      className="group flex w-full min-w-0 flex-col gap-2 rounded-card text-left outline-offset-4">
      <span className="relative block w-full overflow-hidden rounded-card">
        <Art src={item.poster ?? art.poster(item.id)} alt="" fallbackTitle={item.name} className="aspect-2/3 w-full img-outline" />
        {/* A scrim, not glass: there's one of these on every card. */}
        <span className="absolute inset-x-0 bottom-0 flex items-center bg-linear-to-t from-black/85 to-transparent px-3 pt-10 pb-3">
          <span className={cx("inline-flex min-h-8 items-center gap-1.5 rounded-full bg-black/65 px-3 text-body font-medium shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]",
            rated ? "text-fg" : "text-fg-muted group-hover:bg-black/80 group-hover:text-fg")}>
            <span className="inline-flex text-[16px]">{star}</span>{rated ? score("text-fg-muted") : "Rate"}
          </span>
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span data-rating-title className="line-clamp-2 text-body font-medium break-words underline-offset-4 group-hover:underline group-hover:decoration-white/30" title={item.name}>{item.name}</span>
        <span className="text-caption text-fg-muted">{[item.type === "movie" ? "Movie" : "Show", item.year].filter(Boolean).join(" · ")}</span>
      </span>
    </button> : variant === "pill" || variant === "secondary" ? <Button ref={trigger} size="lg" variant={variant === "pill" ? "glass" : "secondary"} className={className} icon={star} {...triggerProps}>
      {rated ? score("text-fg-muted") : "Rate"}
    </Button> : variant === "toolbar" ? <button ref={trigger} type="button" {...triggerProps}
      // Phones keep the score and drop the word, so the toolbar fits beside the status.
      className={cx(toolbarItem, "pl-3.5", !rated ? "max-sm:w-10 max-sm:px-0" : "max-sm:pr-3.5", className)}>
      <span className="inline-flex shrink-0 text-[20px]">{star}</span>
      {rated ? score("text-fg-muted max-sm:sr-only") : <span className="max-sm:sr-only">Rate</span>}
    </button> : <IconButton ref={trigger} label={triggerProps["aria-label"]}
      size={size} tone="scrim" className="min-h-11 min-w-11" aria-haspopup="dialog" aria-expanded={open} aria-busy={loading}
      onClick={() => setOpen(true)}>
      {rated ? <span key={saves} className={cx("text-caption font-semibold tabular-nums", saves > 0 && "rise-in")}>{value}</span> : <StarIcon />}
    </IconButton>}
    {open && <RatingEditor item={item} instant={instant} onClose={close} onSave={save} />}
  </>;
}

function RatingPoster({ item }: { item: Item }) {
  return <Art src={item.poster ?? art.poster(item.id)} alt="" fallbackTitle={item.name} className="aspect-2/3 w-10 rounded-control img-outline" />;
}

/**
 * Native radios keep arrow keys, focus and selection consistent across both groups. Inside the sheet's glass
 * they're a plain fill, and the choice is the lens. A pill track for the scope, a grid for the statuses, so
 * the two never read as the same control.
 */
function RatingChoices<T extends string>({ label, value, options, disabled, shape, onChange }: {
  label: string; value: T | null; options: { value: T; label: string }[];
  disabled: boolean; shape: "pill" | "grid"; onChange: (value: T) => void;
}) {
  const name = useId();
  // Narrow sheets drop to caption size so "Plan to watch" stays on one line.
  return <div role="radiogroup" aria-label={label} className={cx("@container grid grid-cols-3 gap-1 bg-white/6 p-1", shape === "pill" ? "rounded-full" : "rounded-card")}>
    {options.map((option) => <label key={option.value} className="relative block min-w-0 cursor-pointer">
      <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled}
        onChange={() => onChange(option.value)} className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      {/* Nested corners: the track's 12px less its 4px padding. */}
      <span className={cx("flex min-h-10 items-center justify-center px-1 text-center text-body font-medium whitespace-nowrap @max-[340px]:text-caption text-fg-muted hover:bg-white/8 hover:text-fg",
        "peer-checked:lens peer-checked:text-fg peer-disabled:opacity-40 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
        shape === "pill" ? "rounded-full" : "rounded-[8px]")}>
        {option.label}
      </span>
    </label>)}
  </div>;
}

/** One sheet from the first frame: the form fills in under the same header once your rating arrives. */
export function RatingEditor({ item, instant, onClose, onSave }: { item: Item; instant: boolean; onClose: () => void; onSave: (change: RatingChange) => Promise<unknown> }) {
  const { token } = useAuthed();
  const details = useQuery(api.ratings.details, { token, id: item.id });
  const [scope, setScope] = useState<"show" | "season" | "episode">("show");
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [draft, setDraft] = useState<number | null | undefined>(undefined);
  const initialStatus = details && (details.watchStatus === undefined ? details.state : details.watchStatus);
  // Untouched until someone picks a status, so it shows the saved one whenever that arrives.
  const [picked, setState] = useState<typeof initialStatus>(undefined);
  const state = picked === undefined ? initialStatus : picked;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const scale = useRef<HTMLDivElement>(null);
  const meta = useAsync(item.type === "series" ? `meta:series:${item.id}` : null, () => getMeta("series", item.id));
  const seasons = [...new Set(meta.data?.videos?.map((v) => v.season) ?? [])];
  const episodes = meta.data?.videos?.filter((v) => v.season === season) ?? [];
  const current = (scope === "show" ? details?.rating : details?.parts.find((r) =>
    r.season === season && r.episode === (scope === "episode" ? episode : undefined))?.rating) ?? null;
  const value = draft === undefined ? current : draft;
  const changed = draft !== undefined || state !== initialStatus;
  const chooseScope = (next: typeof scope) => { setScope(next); setDraft(undefined); setError(null); };
  const seasonName = season === 0 ? "the specials" : `season ${season}`;
  const target = scope === "show" ? (item.type === "series" ? "the show" : "the movie") : scope === "season" ? seasonName : `episode ${episode}`;
  const watchNote = item.type === "movie" ? "Saving marks this movie watched, and clearing the score later keeps it watched." : undefined;
  const syncNote = details?.sync === "on"
    ? scope === "show" ? "Your exact score syncs to Simkl." : state === "rewatching" ? "This score stays in Krida. Simkl keeps the show as Watched, with your original history."
      : "This score stays in Krida. The watched season or episode syncs to Simkl."
    : details?.sync === "reconnect" ? "Saved in Krida. Reconnect Simkl in Settings to send changes."
      : details?.sync === "off" ? "Saved in Krida. Turn on Keep Simkl up to date in Settings to send changes."
        : "Saved in Krida. Connect Simkl in Settings to sync your history.";

  /** Saves the draft, or `score` when Enter or a quick pick names one. Nothing changed just closes. */
  const save = async (score?: number) => {
    if (sending.current) return;
    const rating = score ?? value;
    const scored = score !== undefined ? score !== current : draft !== undefined;
    const status = item.type === "series" && state !== null && state !== initialStatus ? state : undefined;
    if (!scored && !status) { onClose(); return; }
    sending.current = true; setSaving(true); setError(null);
    if (score !== undefined) setDraft(score);
    try {
      await onSave({ ...(scored || current !== null ? { rating } : {}),
        ...(scope !== "show" ? { season, ...(scope === "episode" ? { episode } : {}) } : {}),
        ...(status ? { state: status } : {}) });
      onClose();
    } catch (e) {
      setError(e instanceof ConvexError && typeof e.data === "string" ? e.data : "Couldn't save your rating. Try again.");
    } finally { sending.current = false; setSaving(false); }
  };
  const pick = (n: number) => { if (instant && scope === "show") void save(n); else { setDraft(n); setError(null); } };

  // The scale takes focus once it's there, so arrows and Enter work straight away.
  const loaded = details !== undefined;
  useEffect(() => {
    if (!loaded) return;
    const frame = requestAnimationFrame(() => scale.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [loaded]);
  // Number keys pick a score from anywhere in the sheet: 1–9, and 0 for 10.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!loaded || sending.current || e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !/^[0-9]$/.test(e.key)) return;
      e.preventDefault();
      pick(e.key === "0" ? 10 : Number(e.key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const actions = <div className="flex flex-col gap-3">
    {error && <p role="alert" className="flex items-start gap-2 text-caption text-danger"><WarningCircleIcon className="mt-px shrink-0 text-[16px]" aria-hidden />{error}</p>}
    <div className="flex items-center justify-between gap-3">
      <Button variant="ghost" className="-ml-3 min-h-11" disabled={saving || value === null} onClick={() => { setDraft(null); setError(null); }}>Clear rating</Button>
      <Button variant="primary" className="min-h-11" loading={saving} onClick={() => void save()} disabled={!saving && !changed}>Save changes</Button>
    </div>
  </div>;
  return <Sheet open onClose={onClose} variant="center" title={item.name} description="Your rating"
    leading={<RatingPoster item={item} />} footer={details && actions}>
    {details === undefined ? <div role="status" className="flex min-h-64 items-center justify-center gap-3 text-body text-fg-muted"><Spinner /> Loading your rating…</div>
      : <div className="flex flex-col gap-6" aria-busy={saving}>
        {item.type === "series" && <div className="flex flex-col gap-3">
          <RatingChoices label="What you're rating" shape="pill" value={scope} disabled={saving} onChange={chooseScope}
            options={[{ value: "show", label: "Whole show" }, { value: "season", label: "Season" }, { value: "episode", label: "Episode" }]} />
          {scope !== "show" && <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-caption text-fg-muted">Season
              {seasons.length ? <select value={season} className={fieldClass} disabled={saving}
                onChange={(e) => { setSeason(Number(e.target.value)); setEpisode(meta.data?.videos?.find((v) => v.season === Number(e.target.value))?.episode ?? 1); setDraft(undefined); }}>
                {!seasons.includes(season) && <option value={season}>Season {season}</option>}
                {seasons.map((s) => <option key={s} value={s}>{s === 0 ? "Specials" : `Season ${s}`}</option>)}
              </select> : <input type="number" inputMode="numeric" min={0} max={1000} value={season} className={cx(fieldClass, "tabular-nums")} disabled={saving}
                onChange={(e) => { setSeason(Number(e.target.value)); setDraft(undefined); }} />}
            </label>
            {scope === "episode" && <label className="flex min-w-0 flex-col gap-1.5 text-caption text-fg-muted">Episode
              {episodes.length ? <select value={episode} className={cx(fieldClass, "truncate")} disabled={saving}
                onChange={(e) => { setEpisode(Number(e.target.value)); setDraft(undefined); }}>
                {!episodes.some((v) => v.episode === episode) && <option value={episode}>Episode {episode}</option>}
                {episodes.map((v) => <option key={v.episode} value={v.episode}>{v.episode}. {v.name ?? v.title ?? `Episode ${v.episode}`}</option>)}
              </select> : <input type="number" inputMode="numeric" min={1} max={10000} value={episode} className={cx(fieldClass, "tabular-nums")} disabled={saving}
                onChange={(e) => { setEpisode(Number(e.target.value)); setDraft(undefined); }} />}
            </label>}
          </div>}
        </div>}
        <div className="flex flex-col gap-3">
          {/* The number holds its slot while empty, so picking one moves nothing. */}
          <div className="flex min-h-11 items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-body font-medium">Your score for {target}</p>
              <p aria-live="polite" className="mt-0.5 text-caption text-fg-muted">{value === null ? instant && scope === "show" ? "Tap a score to save it." : "How was it?" : scoreLabels[value]}</p>
            </div>
            <p aria-hidden className="flex shrink-0 items-baseline gap-0.5 tabular-nums">
              <span className={cx("text-display font-semibold", value === null && "invisible")}>{value ?? 10}</span>
              <span className={cx("text-body text-fg-faint", value === null && "invisible")}>/10</span>
            </p>
          </div>
          <div ref={scale} className="flex flex-col gap-2">
            <ScoreScale label={`Your score for ${target}, out of 10`} value={value} follow disabled={saving} onPick={pick} onCommit={(n) => void save(n)} />
            <ScaleEnds />
          </div>
        </div>
        {item.type === "series" && <div className="flex flex-col gap-3">
          <p className="text-body font-medium">Watch status</p>
          <RatingChoices label="Watch status" shape="grid" value={state ?? null} disabled={saving} onChange={setState} options={WATCH_STATUSES} />
          <p className="text-caption text-fg-muted">{state === "completed" ? "Marks every episode of the show watched."
            : state === "rewatching" ? "Keeps your original episode history. Shows as Watched on Simkl."
              : scope === "show" ? "Keeps your episode progress. Finish the show whenever you're ready."
                : `Saving a score marks ${target} watched.`}</p>
        </div>}
        <div className="flex items-start gap-2 text-caption text-fg-muted">
          {details.sync === "on" ? <CloudCheckIcon className="mt-px shrink-0 text-[16px]" aria-hidden /> : <CloudSlashIcon className="mt-px shrink-0 text-[16px]" aria-hidden />}
          <p>{watchNote && `${watchNote} `}{syncNote}</p>
        </div>
        {/* A real warning (Simkl didn't take it), so it gets the warning mark; the words stay readable grey. */}
        {details.syncError && <p role="alert" className="flex items-start gap-2 rounded-control bg-white/6 p-3 text-caption text-fg-muted">
          <WarningCircleIcon weight="fill" className="mt-px shrink-0 text-[16px] text-warning" aria-hidden />{details.syncError}
        </p>}
      </div>}
  </Sheet>;
}

export function StarterSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <StarterSession onClose={onClose} /> : null;
}

/**
 * Keep the opening batch until dismissal so saving never moves another card under the pointer. It's built once, from the
 * profile's synced rows and the well-known titles from /api/starter.
 */
function StarterSession({ onClose }: { onClose: () => void }) {
  const simkl = useSimklRows();
  const own = useOwnRows();
  const [popular, setPopular] = useState<StarterItem[]>();
  const [data, setData] = useState<StarterBatch>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    starter().then((r) => current && setPopular(r.items.map((x) => ({ ...x, rating: null }))), () => current && setFailed(true));
    return () => { current = false; };
  }, [attempt]);
  // Frozen the moment everything it needs is here.
  if (!data && simkl && own && popular) setData(starterBatch(simkl, own, popular));
  const rate = useRate();
  const [local, setLocal] = useState<Record<string, number | null>>({});
  const [search, setSearch] = useState("");
  const rated = data?.items.filter((x) => (x.id in local ? local[x.id] : x.rating) !== null).length ?? 0;
  const groups = data ? (data.fromHistory ? [
    { title: "From your watch history", items: data.items.slice(0, data.fromHistory) },
    { title: "More to rate", items: data.items.slice(data.fromHistory) },
  ] : [{ title: "Find something you’ve seen", items: data.items }]).filter((group) => group.items.length > 0)
    .map((group) => ({ ...group, items: group.items.filter((x) => x.name.toLowerCase().includes(search.trim().toLowerCase())) })) : [];
  const found = groups.some((group) => group.items.length > 0);
  return <Sheet open onClose={onClose} variant="center" wide title="Rate what you’ve watched"
    description="A few scores help us find your next favorite. One tap on a score saves it."
    footer={<div className="flex items-center justify-between gap-4">
      <p role="status" className="text-body text-fg-muted tabular-nums">{data?.items.length ? <><span className="font-medium text-fg">{rated}</span> of {data.items.length} rated</> : "Rate any title from its page"}</p>
      <Button variant="primary" className="min-h-11" onClick={onClose}>Done</Button>
    </div>}>
    <div className="flex flex-col gap-6">
      {data && data.items.length > 0 && <label className="relative block">
        <span className="sr-only">Find a title</span>
        <MagnifyingGlassIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[18px] text-fg-muted" />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a title in this list"
          autoComplete="off" spellCheck={false} enterKeyHint="search" className={cx(fieldClass, "rounded-full pl-10")} />
      </label>}
      {!data && failed ? <EmptyState icon={<StarIcon />} title="Couldn’t load titles to rate" description="Check your connection and try again."
        action={<Button onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>Try again</Button>} />
      : !data ? <div aria-busy className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4">
        <span role="status" className="sr-only">Loading titles…</span>
        {Array.from({ length: 8 }, (_, i) => <div key={i} aria-hidden className="flex flex-col gap-2">
          <div className="aspect-2/3 rounded-card bg-white/6" /><div className="h-4 w-3/4 rounded-full bg-white/6" /><div className="h-3 w-1/2 rounded-full bg-white/6" />
        </div>)}
      </div> : data.items.length === 0 ? <EmptyState icon={<StarIcon />} title="Nothing to rate here yet"
        description="Find a movie or show you’ve seen and rate it from its page." action={<ButtonLink to="/search" onClick={onClose}>Find a title</ButtonLink>} />
        : !found ? <EmptyState icon={<MagnifyingGlassIcon />} title={`Nothing here called “${search.trim()}”`} description="Try another name, or find any title from Search and rate it on its page."
          action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
          : groups.filter((group) => group.items.length > 0).map((group) => <section key={group.title} className="flex flex-col gap-3">
            <h3 className="text-body font-medium text-fg-muted">{group.title}</h3>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4">
              {group.items.map((x) => <li key={x.id} className="min-w-0">
                <RateMenu item={x} value={x.id in local ? local[x.id] : x.rating} variant="card" instant onChange={async (change) => {
                  await rate({ id: x.id, type: x.type, name: x.name, poster: x.poster }, change);
                  if (change.season === undefined && change.rating !== undefined) setLocal((l) => ({ ...l, [x.id]: change.rating! }));
                }} />
              </li>)}
            </ul>
          </section>)}
    </div>
  </Sheet>;
}

export function MakeItYours({ onRate, onDismiss }: { onRate: () => void; onDismiss: () => void }) {
  // Phones: "Not now" becomes a close button in the corner, so the two ways in share one row at full width.
  return <section className="px-4 md:px-12"><div className="relative flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[24px] bg-white/4 py-3 pr-3 pl-4 md:rounded-full md:pl-5">
    <div className="min-w-[200px] flex-1 max-md:pr-8"><p className="text-body"><span className="font-medium">Make Krida yours.</span> <span className="text-fg-muted">Rate a few titles, or bring in your history from Simkl, and your picks start from your taste.</span></p></div>
    <IconButton label="Not now" size="sm" onClick={onDismiss} className="absolute top-1 right-1 min-h-11 min-w-11 text-fg-muted md:hidden"><XIcon /></IconButton>
    <div className="flex items-center gap-2 max-md:w-full max-md:*:flex-1"><Button variant="ghost" onClick={onDismiss} className="max-md:hidden">Not now</Button><ButtonLink to="/settings/taste">Connect Simkl</ButtonLink><Button variant="primary" onClick={onRate}>Rate a few</Button></div>
  </div></section>;
}
