import { BadRequest, endpoint, NeedsKey } from "../server/http.js";
import { computeRows, type CatalogTitle } from "../server/recs.js";
import { NEEDS_TMDB, requireSession } from "../server/session.js";
import type { Taste } from "../shared/taste.js";

const ids = (x: unknown, max: number) => Array.isArray(x) && x.length <= max && x.every((s) => typeof s === "string" && s.length <= 200);
const titles = (x: unknown, max: number) =>
  Array.isArray(x) && x.length <= max && x.every((t) => typeof t?.id === "string" && (t.type === "movie" || t.type === "series"));

function isTaste(x: any): x is Taste {
  return !!x && titles(x.seeds, 30) && x.seeds.every((s: any) => typeof s.weight === "number" && typeof s.seen === "boolean" && typeof s.loved === "boolean")
    && ids(x.exclude, 8000) && titles(x.disliked, 15) && ids(x.seenFranchises, 8000);
}

// POST /api/recs { backend, token, taste, others: [{ name, taste }], catalog: [{ id, type }] }: a profile's personal rows
// on Home, from its taste (worked out in the browser), the tastes of the others it shares rows with, and titles from its
// addon catalogs as more candidates.
export default endpoint(async (_params, request) => {
  if (request.method !== "POST") throw new BadRequest("POST a taste");
  const body = (await request.json().catch(() => null)) as any;
  const { keys } = await requireSession(body?.backend, body?.token);
  if (!keys.tmdb) throw new NeedsKey("tmdb", NEEDS_TMDB);
  if (!isTaste(body.taste)) throw new BadRequest("Malformed taste");
  // Someone else's taste that can't be read only costs their "For you and…" row.
  const others = (Array.isArray(body.others) ? body.others : []).slice(0, 5)
    .filter((o: any) => isTaste(o?.taste))
    .map((o: any) => ({ name: String(o?.name ?? "").slice(0, 40), taste: o.taste as Taste }));
  // Titles from the profile's addon catalogs (the browser reads them); a malformed list only costs those candidates.
  const catalog = titles(body.catalog, 150) ? (body.catalog as CatalogTitle[]).map(({ id, type }) => ({ id: String(id).slice(0, 40), type })) : [];
  const rows = await computeRows({ tmdb: keys.tmdb, mdblist: keys.mdblist }, body.taste, others, catalog);
  return Response.json({ rows }, { headers: { "Cache-Control": "no-store" } });
});
