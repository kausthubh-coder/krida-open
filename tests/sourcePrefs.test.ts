/// <reference types="vite/client" />
// The source settings: words a profile's sources may not contain, and reusing the kind of file played last.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { excluder, kindOf, rankSources, sameKind } from "../convex/lib/rank";
import { mergePrefs } from "../convex/lib/prefs";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const listing = (filename: string, name = "⚡Addon 1080p") => ({ name, description: "", filename });

describe("hide sources containing", () => {
  test("matches whole words in any case, split by | or commas", () => {
    const hides = excluder(" CAM | hdcam, TS ")!;
    expect(["Film.2024.HDCAM.x264.mkv", "Film.2024.cam.mkv", "Film.2024.TS.mkv", "Film.2024.1080p.WEB-DL.mkv", "Film.TSUNAMI.2024.mkv", "Camera.2024.mkv"].map((f) => hides(listing(f))))
      .toEqual([true, true, true, false, false, false]);
    expect(hides({ name: "Torrentio\n720p", description: "👤 12 ⚙️ HDCAM release", filename: undefined })).toBe(true);
  });

  test("is plain words: what looks like a pattern is matched as typed, and nothing at all hides nothing", () => {
    expect(excluder("")).toBe(null);
    expect(excluder(" | , ")).toBe(null);
    const hides = excluder("x.264|(Dub)")!;
    expect([hides(listing("Film.x.264.mkv")), hides(listing("Film.xx264.mkv")), hides(listing("Film (Dub).mkv"))]).toEqual([true, false, true]);
  });

  test("leaves those copies out of the list and the pick, keeping each file's place in the stored list", () => {
    const items = [listing("Film.2024.2160p.HDCAM.mkv", "⚡Addon 2160p"), listing("Film.2024.1080p.WEB-DL.mkv")];
    const { options, pick } = rankSources(items, { type: "movie", exclude: "CAM|HDCAM" });
    expect([options.map((o) => o.index), pick?.index]).toEqual([[1], 1]);
  });
});

describe("the kind of file played last", () => {
  test("is the addon's binge group, else the release group and resolution", () => {
    expect(kindOf({ bingeGroup: "torrentio|1080p|NTb", filename: "Show.S01E02.1080p.WEB-DL-NTb.mkv" })).toBe("torrentio|1080p|NTb");
    expect(kindOf({ filename: "Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv", resolution: "1080p" })).toBe("release:ntb|1080p");
    expect(kindOf({ filename: "[SubsPlease] Show - 02 (1080p).mkv", resolution: "1080p" })).toBe("release:subsplease|1080p");
    expect(kindOf({ filename: "Show.S01E02.1080p.WEB-DL.mkv" })).toBe(undefined);
  });

  test("matches the next episode's copy from the same group at the same resolution", () => {
    const next = { name: "⚡Addon 1080p", description: "", filename: "Show.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv" };
    expect([sameKind(next, "release:ntb|1080p"), sameKind(next, "release:ntb|2160p"), sameKind({ ...next, bingeGroup: "a|b" }, "a|b")]).toEqual([true, false, true]);
  });

  async function fixture(reuseSource: boolean) {
    const t = convexTest(schema, modules);
    const profileId = await t.run(async (ctx) => {
      const accountId = await ctx.db.insert("accounts", { name: "Reuse", createdAt: Date.now() });
      await ctx.db.insert("accountKeys", { accountId, debrid: { service: "realdebrid", key: "rd" }, updatedAt: Date.now() });
      const id = await ctx.db.insert("profiles", {
        name: "Reuse", hue: 145, passwordHash: "unused", salt: "unused", order: 0, failedAttempts: 0, accountId,
        prefs: { audioLang: "eng", sounds: false, reuseSource },
      });
      await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256("reuse"), createdAt: Date.now() });
      await ctx.db.insert("lastSources", { profileId: id, show: "tt200", group: "release:ntb|1080p", at: Date.now() });
      return id;
    });
    const episode = { type: "series" as const, imdbId: "tt200", videoId: "tt200:1:3", season: 1, episode: 3, name: "Show" };
    return { t, profileId, episode };
  }

  test("with Reuse the last source on, a show's next episode starts out looking for it", async () => {
    const on = await fixture(true);
    const roomId = await on.t.mutation(api.rooms.create, { token: "reuse", media: on.episode });
    expect((await on.t.run((ctx) => ctx.db.get(roomId)))?.binge).toEqual({ show: "tt200", group: "release:ntb|1080p" });
    // A film, or a source picked by hand, doesn't.
    const film = await on.t.mutation(api.rooms.create, { token: "reuse", media: { type: "movie", imdbId: "tt300", videoId: "tt300", name: "Film" } });
    const picked = await on.t.mutation(api.rooms.create, { token: "reuse", media: on.episode, sourceIndex: 0, sourceKey: "k" });
    expect(await on.t.run(async (ctx) => [(await ctx.db.get(film))?.binge ?? null, (await ctx.db.get(picked))?.binge ?? null])).toEqual([null, null]);
    const off = await fixture(false);
    const plain = await off.t.mutation(api.rooms.create, { token: "reuse", media: off.episode });
    expect((await off.t.run((ctx) => ctx.db.get(plain)))?.binge).toBe(undefined);
  });

  test("starting an episode keeps its kind of file for the show", async () => {
    const { t, profileId, episode } = await fixture(false);
    const roomId = await t.mutation(api.rooms.create, { token: "reuse", media: episode });
    const streamId = await t.run((ctx) => ctx.db.insert("streams", { audios: [], createdAt: Date.now(), direct: { link: "https://addon.invalid/1" } }));
    const jobId = (await t.run((ctx) => ctx.db.get(roomId)))!.jobId!;
    await t.mutation(internal.rooms.setReady, {
      roomId, jobId, streamId, sourceIndex: 0,
      source: { addon: "Torrentio", resolution: "2160p", filename: "Show.S01E03.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv" },
    });
    const rows = await t.run((ctx) => ctx.db.query("lastSources").collect());
    expect(rows.map((r) => [r.profileId, r.show, r.group])).toEqual([[profileId, "tt200", "release:flux|2160p"]]);
  });
});

test("a setting that can be unset is cleared with null, and others are left as they were", () => {
  const prefs = { audioLang: "eng", sounds: true, sourceFilter: "CAM", subLang2: "spa", nextUpFrom: "furthest" as const };
  expect(mergePrefs(prefs, { sourceFilter: null, subLang2: "fre", nextUpFrom: null, subtitleSize: "large" })).toEqual({
    audioLang: "eng", sounds: true, subLang2: "fre", subtitleSize: "large",
  });
});
