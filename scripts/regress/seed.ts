import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { parseManifest } from "../../shared/stremio.ts";

type Title = { id: string; type: "movie" | "series"; name: string; year?: string; poster?: string };
const titles = JSON.parse(readFileSync(new URL("./titles.json", import.meta.url), "utf8")) as { movies: Title[]; shows: Title[]; anime: Title[] };
const { movies, shows, anime } = titles;

export type Profile = { name: string; password: string };

const ref = (name: string) => makeFunctionReference<"mutation">(name);

/**
 * The keys the QA account starts with. With the stand-in providers (scripts/regress/providers.ts) any TorBox key plays,
 * and /api answers from the regress store, so placeholders do; `npm run qa -- up` passes TMDB and MDBList keys from
 * .env.local when it has them. `none` leaves the account without keys, to add them in Settings like a person would.
 */
export type SeedKeys = { tmdb?: string; mdblist?: string; torbox?: string } | "none";

/**
 * Two QA profiles with real-sized libraries, written through the same public mutations the app uses, in a fixed order
 * so every run produces the same rows: a long Plan to watch, ratings, statuses across collections, Continue watching.
 * Both are in the account "QA", which holds the keys.
 */
/**
 * `streamAddon`: the stand-in stream addon's base (providers.ts `standInAddon`), installed on both profiles so Play
 * finds its three copies.
 */
export async function seed(url: string, adminKey: string, keys: SeedKeys = {}, streamAddon?: string): Promise<Profile[]> {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error(`Seeding only runs against a local backend, not ${url}`);
  const admin = new ConvexHttpClient(url);
  (admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
  const client = new ConvexHttpClient(url);
  // A throwaway backend on this machine: the password only has to be the same for the seed and the walk.
  const profiles = [{ name: "Regress-QA-one", hue: 145 }, { name: "Regress-QA-two", hue: 205 }];
  const password = "regress-local-only";
  const tokens: string[] = [];
  const manifest = streamAddon && parseManifest(await (await fetch(`${streamAddon}/manifest.json`)).json());
  for (const p of profiles) {
    const profileId = await admin.mutation(ref("profiles:add"), { ...p, password });
    // A commit from before addons (npm run regress -- --base) asks the stand-in AIOStreams instead.
    if (manifest && manifest.ok)
      await admin.mutation(ref("addons:insert"), { profileId, url: streamAddon, manifest: manifest.manifest }).catch(() => {});
    // QA sign-in; a base commit from before accounts (npm run regress -- --base) still signs in with the password.
    const session = (await client.mutation(ref("profiles:qaSignIn"), { name: p.name, password }).catch(() =>
      client.mutation(ref("profiles:signIn"), { profileId, password }))) as { token?: string };
    if (!session.token) throw new Error(`Couldn't sign in as ${p.name}`);
    tokens.push(session.token);
  }
  const [one, two] = tokens;
  if (keys !== "none") {
    await admin.mutation(ref("accounts:setKeysFor"), {
      account: "QA",
      keys: { tmdb: keys.tmdb ?? "regress-tmdb", mdblist: keys.mdblist ?? "regress-mdblist", debrid: { service: "torbox", key: keys.torbox ?? "regress-torbox" } },
    });
  }

  const save = (token: string, t: Title) =>
    client.mutation(ref("library:toggle"), { token, item: { type: t.type, imdbId: t.id, name: t.name, poster: t.poster, year: t.year }, saved: true });
  const rate = (token: string, t: Title, rating: number) =>
    client.mutation(ref("ratings:save"), { token, item: { id: t.id, type: t.type, name: t.name, poster: t.poster }, rating });
  const status = (token: string, t: Title, state: string) => client.mutation(ref("library:setStatus"), { token, item: t, state });
  const play = (token: string, t: Title, position: number, duration: number) => client.mutation(ref("progress:save"), {
    token, position, duration, final: true,
    media: t.type === "movie"
      ? { type: "movie", imdbId: t.id, videoId: t.id, name: t.name, poster: t.poster, year: t.year }
      : { type: "series", imdbId: t.id, videoId: `${t.id}:1:2`, season: 1, episode: 2, name: t.name, poster: t.poster, year: t.year },
  });

  for (const t of [...movies.slice(0, 16), ...shows.slice(0, 10), ...anime.slice(0, 5)]) await save(one, t);
  for (const [i, t] of movies.slice(16, 28).entries()) await rate(one, t, 6 + (i % 5));
  for (const [i, t] of shows.slice(10, 16).entries()) await rate(one, t, 10 - (i % 4));
  for (const t of [...shows.slice(16, 24), ...anime.slice(5, 10)]) await status(one, t, "watching");
  for (const t of shows.slice(24, 26)) await status(one, t, "dropped");
  await status(one, shows[26], "hold");
  for (const t of anime.slice(10, 12)) await status(one, t, "completed");
  for (const t of movies.slice(28, 32)) await play(one, t, 1200, 6000);
  for (const t of shows.slice(16, 20)) await play(one, t, 600, 1500);

  for (const t of movies.slice(20, 32)) await save(two, t);
  for (const [i, t] of movies.slice(0, 6).entries()) await rate(two, t, 5 + i);
  for (const t of shows.slice(30, 33)) await play(two, t, 300, 1500);

  return profiles.map((p) => ({ name: p.name, password }));
}
