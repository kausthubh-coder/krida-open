// A title page's details: facts (runtime, genres), credits and the description.
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Meta } from "../../data/cinemeta";
import { cx } from "../../ui/ui";

/** "166 min" as "2 h 46 min", the way the rest of Krida writes durations. */
function runtimeLabel(runtime?: string) {
  const minutes = Number(/^(\d+)\s*min$/i.exec(runtime?.trim() ?? "")?.[1]);
  if (!minutes) return runtime;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/** Year, length, genres, then the certification once MDBList has it (last, so nothing before it moves). */
export function Facts({ meta, certification }: { meta: Meta; certification?: string }) {
  // Kitsu writes year ranges with a hyphen; Cinemeta with an en dash.
  const year = (meta.releaseInfo ?? meta.year)?.replace(/^(\d{4})-(?=\d{4}$|$)/, "$1–");
  const episodes = (meta.videos ?? []).filter((v) => v.season > 0);
  const seasons = new Set(episodes.map((v) => v.season)).size;
  const length =
    meta.type === "movie"
      ? runtimeLabel(meta.runtime)
      : seasons > 1
        ? `${seasons} seasons`
        : episodes.length
          ? `${episodes.length.toLocaleString("en-US")} ${episodes.length === 1 ? "episode" : "episodes"}`
          : undefined;
  const genres = (meta.genres ?? meta.genre ?? []).slice(0, 3).join(", ");
  const facts = [year, length, genres].filter(Boolean);
  if (!facts.length && !certification) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-fg-muted">
      {facts.map((f, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden className="size-1 rounded-full bg-fg-faint" />}
          <span className={cx(i < 2 && "tabular-nums")}>{f}</span>
        </span>
      ))}
      {certification && (
        <span className="ml-1 rounded-[4px] px-1.5 text-caption font-medium text-fg-muted ring-1 ring-fg-faint ring-inset">
          {certification}
        </span>
      )}
    </p>
  );
}

/** Who made it and who's in it: quiet, under the buttons, for the curious. */
export function Credits({ meta, className }: { meta: Meta; className?: string }) {
  const directors = meta.director?.slice(0, 2) ?? [];
  const cast = meta.cast?.slice(0, 5) ?? [];
  if (!directors.length && !cast.length) return null;
  // People are linked by name; the title's IMDb id finds them among its own credits (an anime asks by name alone).
  const imdbId = meta.id.startsWith("tt") ? meta.id : meta.imdb_id?.startsWith("tt") ? meta.imdb_id : undefined;
  const people = (names: string[]) =>
    names.map((name, i) => (
      <Fragment key={name}>
        {i > 0 && ", "}
        <Link to={`/person/${encodeURIComponent(name)}${imdbId ? `?title=${imdbId}` : ""}`} className="underline decoration-fg-faint/50 underline-offset-[3px] hover:text-fg hover:decoration-current">
          {name}
        </Link>
      </Fragment>
    ));
  return (
    // A step further from the buttons than they are from each other: it's reading, not doing.
    <dl className={cx("mt-2 grid max-w-[55ch] grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-body", className)}>
      {directors.length > 0 && (
        <>
          <dt className="text-fg-faint">{directors.length > 1 ? "Directors" : "Director"}</dt>
          <dd className="truncate text-fg-muted">{people(directors)}</dd>
        </>
      )}
      {cast.length > 0 && (
        <>
          <dt className="text-fg-faint">Cast</dt>
          <dd className="line-clamp-2 text-fg-muted">{people(cast)}</dd>
        </>
      )}
    </dl>
  );
}

/** Long synopses (anime especially) clamp to four lines, with a way to read the rest when they're cut. */
export function Description({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);
  return (
    <div className={cx("flex max-w-[55ch] flex-col items-start gap-1", className)}>
      <p ref={ref} className={cx("text-subhead text-fg-muted", !open && "line-clamp-4 short:line-clamp-2")}>
        {text}
      </p>
      {(cut || open) && (
        <button
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="relative -ml-1 rounded-full px-1 text-body font-medium text-fg after:absolute after:-inset-x-1 after:-inset-y-3 hover:underline"
        >
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
