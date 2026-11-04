// "See all" for one of the profile's addon catalogs: every title in it, page after page, with its genre filter when
// the catalog has one.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { catalogPage, released, useAddons } from "../../data/addons";
import type { RecItem } from "../../data/api";
import { useAuthed } from "../../data/session";
import { genresOf } from "../../../shared/stremio";
import { Button, EmptyState, Spinner } from "../../ui/ui";
import { ResultsGrid, ResultsSkeleton } from "../search";
import { Select } from "../../ui/select";
import { rowTitle } from "./homeRows";
import { addonRowsOf, CINEMETA_ROWS, type AddonRow } from "./useHome";

type Pages = { items: RecItem[]; done: boolean; error?: string };

export function SeeAllPage() {
  const { addon: addonId = "", type = "", catalog: catalogId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { me } = useAuthed();
  const addons = useAddons();
  const row = useMemo(
    // An installed addon's catalog first: Cinemeta's own carries its genres, which Home's stand-in rows for an account
    // without a TMDB key don't.
    () => {
      const match = (r: AddonRow) => r.addonId === addonId && r.type === type && r.catalog.id === catalogId;
      return addons ? (addonRowsOf(addons).find(match) ?? CINEMETA_ROWS.find(match)) : undefined;
    },
    [addons, addonId, type, catalogId],
  );
  const genres = row ? genresOf(row.catalog) : [];
  const genre = params.get("genre") ?? "";
  const [pages, setPages] = useState<Pages | null>(null);
  const [loading, setLoading] = useState(false);
  const unreleased = !!me.prefs.hideUnreleased;

  const load = async (skip: number) => {
    if (!row) return;
    setLoading(true);
    try {
      const page = await catalogPage(row.base, row.catalog, { genre: genre || undefined, skip: skip || undefined });
      setPages((p) => {
        const before = skip ? (p?.items ?? []) : [];
        const fresh = page.filter((i) => !before.some((b) => b.id === i.id));
        return { items: [...before, ...fresh], done: fresh.length === 0 };
      });
    } catch {
      setPages((p) => ({ items: skip ? (p?.items ?? []) : [], done: true, error: `Couldn’t reach ${row.addon}. Try again in a moment.` }));
    } finally {
      setLoading(false);
    }
  };

  // A new catalog or genre starts again from its first page.
  useEffect(() => {
    setPages(null);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.key, genre]);

  if (addons === undefined)
    return (
      <main className="grid min-h-dvh place-items-center">
        <Spinner className="text-fg-faint" />
      </main>
    );
  if (!row)
    return (
      <main className="flex min-h-dvh flex-col justify-center px-4">
        <EmptyState
          title="This catalog isn’t in your addons"
          description="Its addon was removed or turned off, or the link is from another profile."
          action={
            <Link to="/settings/addons" className="font-medium text-fg underline decoration-fg-faint underline-offset-2">
              Go to your addons
            </Link>
          }
        />
      </main>
    );

  const items = (pages?.items ?? []).filter((i) => !unreleased || released(i));
  const title = rowTitle(row, me.prefs.rowNames, me.prefs.typeHiddenRows);
  return (
    <main className="flex flex-col gap-6 px-4 pt-24 pb-32 md:px-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-display font-semibold">{title}</h1>
          <p className="text-body text-fg-muted">From {row.addon}</p>
        </div>
        {genres.length > 0 && (
          <label className="flex flex-col gap-1 sm:w-56">
            <span className="text-caption text-fg-muted">Genre</span>
            <Select
              id="see-all-genre"
              value={genre}
              onChange={(g) => setParams(g ? { genre: g } : {}, { replace: true })}
              options={[{ value: "", label: "All genres" }, ...genres.map((g) => ({ value: g, label: g }))]}
            />
          </label>
        )}
      </header>
      {pages === null ? (
        <ResultsSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          title={pages.error ? "Couldn’t load this catalog" : "Nothing here"}
          description={pages.error ?? (genre ? `${row.addon} has nothing in ${genre} for this catalog.` : `${row.addon} gave no titles Krida can open.`)}
        />
      ) : (
        <ResultsGrid items={items} />
      )}
      {pages && !pages.done && items.length > 0 && (
        <Button className="self-center" loading={loading} onClick={() => void load(pages.items.length)}>
          Load more
        </Button>
      )}
      {pages?.error && items.length > 0 && <p className="self-center text-body text-danger">{pages.error}</p>}
    </main>
  );
}
