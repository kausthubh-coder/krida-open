import { v } from "convex/values";
import { internalAction, internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { carriesSecret, createStream, fetchSegments, isTorrent, NEEDS_DEBRID_SOURCES, PlainFile, resolveDirect, resolveToTorbox, SlowSource, SourceError, torboxKeyOf, UnavailableSource, viaTorBox, type FailKind, type RawSource } from "./lib/providers";
import type { AccountKeys } from "./lib/accounts";
import type { SourceOrigin } from "./lib/addons";
import { parseSource } from "./lib/parse";
import { containerOf, isBrowserContainer } from "../shared/formats";
import { contextFor, languageFor, rankSources, sameKind, sourceKey, type RankContext, type Screen } from "./lib/rank";
import { sha256 } from "./lib/auth";
import { listKey, loadSources } from "./sources";
import { bingeFor } from "./lib/rooms";
import { track, trackError } from "./lib/telemetry";
import { introValidator, mediaValidator, screenValidator, sourceSummaryValidator, subtitleTrackValidator } from "./schema";

type Media = NonNullable<Doc<"rooms">["media"]>;
/**
 * Who a stream is picked for: their language settings, their screen, the binge group the room keeps to (or the kind of
 * file they played last, `sameKind`), and the words their sources may not contain.
 */
type Viewer = { audioLang?: string; subLang?: string; screen?: Screen; binge?: string; exclude?: string };
/** Which source to play: its key (current pickers), its list position (older tabs), or neither for Krida's pick. */
type Choice = { index?: number; key?: string };
/**
 * Whose keys and addons a stream is built with: the room host's (a party plays the host's TorBox stream for everyone,
 * found by the host's addons). Streams are kept per account, since torrent and file ids mean something only in that
 * account's TorBox, and a direct link can carry that account's debrid key or its addons' settings.
 */
type Access = { accountId: Id<"accounts"> | null; keys: AccountKeys; origin: SourceOrigin };

async function accessOf(ctx: ActionCtx, profileId: Id<"profiles">): Promise<Access> {
  const [{ accountId, keys }, origin] = await Promise.all([
    ctx.runQuery(internal.accounts.keysOfProfile, { profileId }),
    ctx.runQuery(internal.addons.originOf, { profileId }),
  ]);
  return { accountId, keys, origin };
}

const AUTO_TRIES = 4;
/** A prepared stream stays good to start from for this long (expired TorBox sessions are refreshed). */
const WARM_TTL_MS = 3 * 60 * 60 * 1000;
/**
 * After that, its file is restarted with one TorBox call instead of being searched for again. TorBox keeps a file
 * for 30 days after it was last downloaded, so streams not started in that time are dropped (`sweep`).
 */
const REUSE_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
/** A build that hasn't finished by now has died with its action; the next request builds again. */
const BUILD_TTL_MS = 3 * 60 * 1000;
const BUILD_POLL_MS = 500;
/** How long a copy gets to reach TorBox before the next is tried. The last one tried waits as long as it takes. */
const SLOW_SOURCE_MS = 15_000;
/** A copy that took longer than this goes in the failure log, so a slow addon shows in `scripts/logs.mjs`. */
const SLOW_LOG_MS = 10_000;

/** What happened to a copy that didn't start, for one copy and for several. */
const WHY: Record<FailKind | "other", [string, string]> = {
  slow: ["was too slow", "were too slow"],
  notCached: ["wasn’t ready on TorBox", "weren’t ready on TorBox"],
  notReady: ["wasn’t ready on your debrid service", "weren’t ready on your debrid service"],
  torrent: ["was a torrent, which needs TorBox", "were torrents, which need TorBox"],
  wrongFile: ["didn’t have this video", "didn’t have this video"],
  brokenLink: ["had a broken link", "had broken links"],
  unreachable: ["couldn’t be reached", "couldn’t be reached"],
  torbox: ["was turned down by TorBox", "were turned down by TorBox"],
  other: ["didn’t start", "didn’t start"],
};

/** "Krida tried 4 copies: 3 were too slow and 1 wasn’t ready on TorBox." TorBox's own words when it refused them all. */
export function whyNoneStarted(errors: unknown[]) {
  const kinds = errors.map((e) => (e instanceof SourceError && e.kind) || "other");
  if (kinds.every((k) => k === "torbox")) return (errors.at(-1) as SourceError).message;
  if (kinds.length === 1) return `That copy ${WHY[kinds[0]][0]}.`;
  const counts = new Map<keyof typeof WHY, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  if (counts.size === 1) return `Krida tried ${kinds.length} copies and all of them ${WHY[kinds[0]][1]}.`;
  const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${WHY[k][n === 1 ? 0 : 1]}`);
  return `Krida tried ${kinds.length} copies: ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
}

/** Reports a step, with a note on why it's taking a while; throws Superseded if nobody wants this anymore. */
type Step = (text: string, note?: string) => Promise<void>;
/** One copy tried while building a stream, for PostHog's `play_build`: how long it took, and why it failed. */
type Attempt = { source: number; ms: number; resolveMs?: number; slowestHost?: string; failed?: string };

/** Try other providers for the same file first, then matching quality. A downgrade needs a person's choice.
 * Files that look like another episode are only tried when nothing else is listed. Without a choice, a cached file
 * from the `binge` group someone picked on an earlier episode comes before Krida's pick, as in Stremio and Nuvio.
 * Without a choice, `playable` copies go first: a browser playing another service's files straight from their link
 * can only play some of them. */
export function chosenCandidates(items: RawSource[], ctx: RankContext, choice: Choice, binge?: string, playable?: (item: RawSource) => boolean) {
  const { options, best, pick } = rankSources(items, ctx);
  const at = choice.key === undefined ? choice.index : items.findIndex(item => sourceKey(item) === choice.key);
  if (at === -1) throw new SourceError("That source isn’t listed anymore. Pick another one.");
  const inGroup = (o: { indices: number[] }) => !!binge && o.indices.some(i => !!items[i] && sameKind(items[i], binge));
  const kept = at === undefined ? best.find(o => inGroup(o) && !o.mismatch && o.cached) : undefined;
  // A copy this screen can play beats a better one it can't: the best of those, unless Krida's own pick is one.
  const plays = (o?: { indices: number[] }) => !!o && o.indices.some(i => !!items[i] && playable!(items[i]));
  const ownPick = kept ?? pick;
  const auto = playable && !plays(ownPick) ? best.find(o => plays(o) && !o.mismatch) ?? ownPick : ownPick;
  const selected = at === undefined ? auto : options.find(o => o.indices.includes(at));
  const language = languageFor(ctx.audioLang);
  const compatible = best.filter(o => !o.mismatch && (!language || !selected?.languages.includes(language) || o.languages.includes(language)));
  const sameQuality = compatible
    .filter(o => o !== selected && o.resolution === selected?.resolution)
    .sort((a, b) => Number(inGroup(b)) - Number(inGroup(a)));
  const copies = selected ? [at ?? selected.index, ...selected.indices.filter(i => i !== (at ?? selected.index))] : [];
  const indices = choice.key === undefined && choice.index !== undefined
    ? [choice.index]
    : [...copies, ...sameQuality.flatMap(o => o.indices), ...(selected ? [] : best.flatMap(o => o.indices))];
  const lower = compatible.find(o => o.resolution && Number.parseInt(o.resolution) < Number.parseInt(selected?.resolution ?? ""));
  const tried = indices.filter(i => !items[i]?.unavailable);
  const ordered = playable && at === undefined ? [...tried.filter(i => playable(items[i]!)), ...tried.filter(i => !playable(items[i]!))] : tried;
  return {
    indices: ordered.slice(0, AUTO_TRIES),
    fallback: lower ? { index: lower.index, key: lower.key, resolution: lower.resolution! } : undefined,
  };
}

class PlaybackUnavailable extends SourceError {
  readonly detail: string;
  readonly fallback: ReturnType<typeof chosenCandidates>["fallback"];
  constructor(message: string, detail: string, fallback: ReturnType<typeof chosenCandidates>["fallback"]) {
    super(message);
    this.detail = detail.replace(/https?:\/\/\S+/g, "<provider link>").slice(0, 500);
    this.fallback = fallback;
  }
}

/** The language settings of whoever asked, the screen it's for, and the room's binge group; they change Krida's pick. */
async function viewerOf(ctx: ActionCtx, profileId?: Id<"profiles">, screen?: Screen, binge?: string): Promise<Viewer> {
  const prefs = profileId ? await ctx.runQuery(internal.profiles.prefsOf, { profileId }) : null;
  return { audioLang: prefs?.audioLang, subLang: prefs?.subLang, screen, binge, exclude: prefs?.sourceFilter || undefined };
}

/**
 * Streams are only reused for the same languages, screen, binge group and hidden words: "" (none), "eng|jpn",
 * "eng|#sdr", "eng|#sdr~<group>", "eng|#sdr!cam|ts". Older tabs send no screen and keep the keys they had.
 */
const rankKey = ({ audioLang, subLang, screen, binge, exclude }: Viewer) =>
  (audioLang || subLang ? `${audioLang ?? ""}|${subLang ?? ""}` : "") + (screen ? `#${screen}` : "") + (binge ? `~${binge}` : "") +
  (exclude ? `!${exclude.toLowerCase().replace(/\s+/g, "")}` : "");

/** Ranking context for a room: the episode, plus the languages, screen and hidden words of whoever it's for. */
function rankContext(media: Media, { audioLang, subLang, screen, exclude }: Viewer): RankContext {
  return {
    ...contextFor(media.type, media.videoId),
    name: media.name,
    ...(media.season !== undefined ? { season: media.season } : {}),
    ...(media.episode !== undefined ? { episode: media.episode } : {}),
    audioLang, subLang, screen, exclude,
  };
}

class Superseded extends Error {}

/** Skip times by IMDb id; anime episodes use the IMDb episode they map to. */
function segmentsFor(media: Media) {
  if (media.ref) return fetchSegments(media.ref.imdbId, media.ref.season, media.ref.episode);
  if (!media.imdbId.startsWith("tt")) return Promise.resolve({} as Awaited<ReturnType<typeof fetchSegments>>);
  return media.type === "series" ? fetchSegments(media.imdbId, media.season, media.episode) : fetchSegments(media.imdbId);
}

/**
 * Find sources, hand one to TorBox and start TorBox's browser stream, or play it from its link. Tries the given source,
 * or the best few automatically. `step` reports progress and throws Superseded if nobody wants this anymore.
 */
async function buildStream(
  ctx: ActionCtx,
  media: Media,
  choice: Choice,
  viewer: Viewer,
  access: Access,
  step: Step = async () => {},
  attempts: Attempt[] = [],
): Promise<Doc<"streams">> {
  // TorBox's files go through TorBox's HLS. Another debrid service's files, and an addon's plain web videos whatever
  // keys the account has (none too), play from their link as they are. A torrent needs a debrid service.
  const torbox = viaTorBox(access.keys);
  const key = torbox ? torboxKeyOf(access.keys) : "";
  const debrid = !!access.keys.debrid;
  const { origin } = access;
  await step("Finding sources…");
  const { items: listed, olderFrom } = await loadSources(ctx, media.type, media.videoId, origin, {
    onNote: (note) => step("Finding sources…", note),
  });
  if (listed.length === 0) throw new SourceError("No sources found for this title yet.");
  if (!debrid && listed.every(isTorrent)) throw new SourceError(NEEDS_DEBRID_SOURCES, "torrent");
  const segmentsLookup = segmentsFor(media);
  // Without a debrid service nothing plays a torrent, so those copies are left out of Krida's pick and of the tries.
  const items = debrid ? listed : listed.map((item) => (isTorrent(item) ? { ...item, unavailable: true } : item));
  const ranking = rankContext(media, viewer);
  // A browser plays MP4, WebM and HLS from a link itself, so those go first there; the app plays them all.
  const playable =
    torbox || viewer.screen === "app" ? undefined : (item: RawSource) => isBrowserContainer(containerOf(item.filename, item.url));
  const { indices: candidates, fallback } = chosenCandidates(items, ranking, choice, viewer.binge, playable);
  if (candidates.length === 0 && !debrid) {
    const at = choice.key === undefined ? choice.index : listed.findIndex((item) => sourceKey(item) === choice.key);
    if (at !== undefined && listed[at] && isTorrent(listed[at]))
      throw new SourceError("This copy is a torrent, which needs a debrid service. Add one in Settings → Connections.", "torrent");
  }
  const addonUrls = origin.addons.map((a) => a.url);

  const errors: unknown[] = [];
  let note = olderFrom === undefined ? undefined : "Your addons aren’t answering, so Krida is using the sources they found earlier.";
  for (const [n, i] of candidates.entries()) {
    const item = items[i];
    if (!item) continue;
    const t0 = Date.now();
    const slow = (host: string, ms: number) =>
      ctx.runMutation(internal.logs.slowSource, { videoId: media.videoId, host, ms, file: item.filename ?? item.name });
    try {
      const last = n === candidates.length - 1;
      let slowest = { host: "", ms: 0 };
      const timing = {
        limitMs: last ? undefined : SLOW_SOURCE_MS,
        onTimed: (host: string, ms: number) => { if (ms > slowest.ms) slowest = { host, ms }; },
      };
      const info = parseSource(item.name, item.description, item.filename, item.size);
      const kept = {
        videoId: media.videoId,
        sourceIndex: i,
        sourceKey: sourceKey(item),
        rankedFor: rankKey(viewer),
        accountId: access.accountId ?? undefined,
        source: {
          addon: info.addon,
          resolution: info.resolution,
          quality: info.quality,
          size: info.size,
          filename: info.filename,
          bingeGroup: item.bingeGroup,
        },
      };
      /**
       * A stream played from its link. `plain` when no debrid service gave it (nothing on the way, and the addon didn't
       * mark it ⚡, on your debrid service) and neither the addon's link nor the file's carries one of the account's
       * secrets: then a party's members from other accounts may have the file too (see mayPlay).
       */
      const insertDirect = async (resolved: { url: string; container?: string; plain: boolean }) => {
        const plain =
          resolved.plain && !info.cached && !carriesSecret(item.url, access.keys, addonUrls) && !carriesSecret(resolved.url, access.keys, addonUrls);
        const segments = await segmentsLookup;
        return await ctx.runMutation(internal.engine.insertStream, {
          ...kept,
          direct: { link: item.url, container: resolved.container, audio: info.audio, ...(plain ? { plain } : {}) },
          videoCodec: info.codec,
          size: info.size,
          height: info.resolution ? Number.parseInt(info.resolution) || undefined : undefined,
          audios: [],
          intro: segments.intro,
          recap: segments.recap,
          outro: segments.outro,
        });
      };
      if (!torbox) {
        // Asking the addon for the file makes it ask the debrid service, which can take a moment.
        await step(debrid ? "Asking your debrid service…" : "Opening the source…", note);
        const resolved = await resolveDirect(item, timing);
        const resolvedMs = Date.now() - t0;
        if (resolvedMs > SLOW_LOG_MS) await slow(slowest.host, slowest.ms);
        attempts.push({ source: i, ms: resolvedMs, resolveMs: resolvedMs, slowestHost: slowest.host || undefined });
        return await insertDirect(resolved);
      }
      await step("Adding to TorBox…", note);
      let found: Awaited<ReturnType<typeof resolveToTorbox>>;
      try {
        found = await resolveToTorbox(key, item, ranking, timing);
      } catch (error) {
        if (!(error instanceof PlainFile)) throw error;
        // A plain web video: TorBox has nothing to add, so it plays from its link, as on an account without TorBox.
        const resolvedMs = Date.now() - t0;
        if (resolvedMs > SLOW_LOG_MS) await slow(slowest.host, slowest.ms);
        attempts.push({ source: i, ms: resolvedMs, resolveMs: resolvedMs, slowestHost: slowest.host || undefined });
        return await insertDirect({ url: error.url, container: error.container, plain: true });
      }
      const { torrentId, fileId, hash } = found;
      const resolvedMs = Date.now() - t0;
      if (resolvedMs > SLOW_LOG_MS) await slow(slowest.host, slowest.ms);
      await step("Starting stream…", note);
      const { chapterIntro, ...stream } = await createStream(key, torrentId, fileId);
      const segments = await segmentsLookup;
      const intro = segments.intro ?? chapterIntro;
      console.log(`prepared ${media.videoId} source ${i}: resolve ${resolvedMs}ms, total ${Date.now() - t0}ms`);
      attempts.push({ source: i, ms: Date.now() - t0, resolveMs: resolvedMs, slowestHost: slowest.host || undefined });
      return await ctx.runMutation(internal.engine.insertStream, {
        torrentId,
        fileId,
        ...stream,
        intro,
        recap: segments.recap,
        outro: segments.outro,
        hash: stream.hash ?? hash,
        ...kept,
      });
    } catch (error) {
      if (error instanceof Superseded) throw error;
      errors.push(error);
      if (error instanceof UnavailableSource)
        await ctx.runMutation(internal.sources.markUnavailable, { key: listKey(media.type, media.videoId, origin.scope), linkHash: await sha256(item.url) });
      if (error instanceof SlowSource) await slow(error.host, error.ms);
      note =
        error instanceof SlowSource ? "That copy was slow. Trying another."
        : error instanceof UnavailableSource ? "This source is unavailable. Trying another copy…"
        : "That copy didn’t work. Trying another.";
      console.warn(`source ${i} failed after ${Date.now() - t0}ms`, error instanceof Error ? error.message : error);
      attempts.push({ source: i, ms: Date.now() - t0, failed: error instanceof SlowSource ? `slow: ${error.host}` : error instanceof Error ? error.message : String(error) });
    }
  }
  const last = errors.at(-1);
  throw new PlaybackUnavailable(
    errors.length ? whyNoneStarted(errors) : "No source worked.",
    last instanceof Error ? last.message : "No available source links remain in this list.",
    fallback,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new TorBox session for a file prepared before, or null if the stream was swept meanwhile. */
async function restartStream(ctx: ActionCtx, stream: Doc<"streams">, step: Step, access: Access) {
  await step("Starting stream…");
  // A direct link is followed afresh each time it's played (desktop.fileLink); checking it now finds one that's gone.
  if (stream.direct) {
    await resolveDirect({ url: stream.direct.link, filename: stream.source?.filename });
    return await ctx.runMutation(internal.engine.restarted, { streamId: stream._id });
  }
  if (stream.torrentId === undefined || stream.fileId === undefined) return null;
  const { presignedToken, domain, subtitles } = await createStream(torboxKeyOf(access.keys), stream.torrentId, stream.fileId);
  return await ctx.runMutation(internal.engine.restarted, { streamId: stream._id, presignedToken, domain, subtitles });
}

/**
 * Krida's pick for an episode in these languages on this kind of screen: a stream prepared earlier (restarted if it's
 * been a while), the one being prepared right now, or a new one. One build per episode and viewer at a time, so a
 * warm-up and a press of Play never hand the same
 * file to TorBox twice. Without `step` (a warm-up), it leaves a build already under way alone.
 */
async function sharedStream(
  ctx: ActionCtx,
  media: Media,
  viewer: Viewer,
  access: Access,
  step?: Step,
): Promise<{ stream: Doc<"streams">; warm: boolean } | null> {
  const key = { videoId: media.videoId, rankedFor: rankKey(viewer), accountId: access.accountId ?? undefined };
  // A browser can't play an MKV from its link (another service's, or a plain web video's), so one picked there before
  // isn't started again on its own. TorBox's own streams are HLS and always kept.
  const playableOnly = viewer.screen !== "app";
  let claimId: Id<"streamBuilds">;
  let earlier: Doc<"streams"> | null;
  for (;;) {
    const claim = await ctx.runMutation(internal.engine.claimBuild, { ...key, playableOnly });
    if (claim.stream) return { stream: claim.stream, warm: true };
    if (claim.claimId) { claimId = claim.claimId; earlier = claim.earlier; break; }
    if (!step) return null;
    // Someone else (usually a warm-up from resting on Play) is building it: show how far they've got.
    await step(claim.step ?? "Starting stream…");
    await sleep(BUILD_POLL_MS);
  }
  const report: Step = async (text, note) => {
    await step?.(text, note);
    await ctx.runMutation(internal.engine.buildStep, { claimId, step: text });
  };
  try {
    // The same file as last time, which also resumes on the copy someone was watching.
    if (earlier) {
      try {
        const stream = await restartStream(ctx, earlier, report, access);
        if (stream) return { stream, warm: true };
      } catch (error) {
        if (error instanceof Superseded) throw error;
        console.warn(`restarting ${media.videoId} failed, finding it again`, error instanceof Error ? error.message : error);
      }
    }
    return { stream: await buildStream(ctx, media, {}, viewer, access, report), warm: false };
  } finally {
    await ctx.runMutation(internal.engine.releaseBuild, { ...key, claimId });
  }
}

export const prepare = internalAction({
  args: {
    roomId: v.id("rooms"),
    jobId: v.number(),
    index: v.optional(v.number()),
    // The picked file's `sourceKey`, which survives the list being fetched again in a new order.
    key: v.optional(v.string()),
    startAt: v.number(),
    // The screens in the room: SDR if anyone's is (see rooms.screenFor).
    screen: v.optional(screenValidator),
  },
  handler: async (ctx, { roomId, jobId, index, key, screen }) => {
    const room = await ctx.runQuery(internal.rooms.getInternal, { roomId });
    if (!room || room.jobId !== jobId || !room.media) return;
    const media = room.media;
    const started = Date.now();
    const picked = index !== undefined || key !== undefined;
    // When each step began and every copy tried, for PostHog's `play_build` (lib/telemetry.ts).
    const steps: Record<string, number> = {};
    const attempts: Attempt[] = [];
    const facts = () => ({ videoId: media.videoId, type: media.type, ms: Date.now() - started, steps, attempts, picked });
    const step: Step = async (text, note) => {
      steps[text.replace("…", "")] ??= Date.now() - started;
      const current = await ctx.runMutation(internal.rooms.setStep, { roomId, jobId, step: text, note });
      if (!current) throw new Superseded();
    };

    try {
      const viewer = await viewerOf(ctx, room.requestedBy, screen, picked ? undefined : bingeFor(room, media));
      const access = await accessOf(ctx, room.hostId);
      // Something already prepared ahead of time (queued, or the next episode) starts at once.
      const { stream, warm } =
        !picked
          ? (await sharedStream(ctx, media, viewer, access, step))!
          : { stream: await buildStream(ctx, media, { index, key }, viewer, access, step, attempts), warm: false };
      const streamId = stream._id;
      if (warm) {
        console.log(`prepared ${media.videoId} from a warm stream`);
        // Skip times may have been added to IntroDB since this was prepared.
        const segments = await segmentsFor(media);
        await ctx.runMutation(internal.engine.patchSegments, {
          streamId,
          intro: segments.intro ?? stream.intro,
          recap: segments.recap,
          outro: segments.outro,
        });
      }
      await ctx.runMutation(internal.rooms.setReady, {
        roomId,
        jobId,
        streamId,
        sourceIndex: stream.sourceIndex ?? 0,
        source: stream.source ?? { addon: "Source" },
        picked,
      });
      const { addon, resolution, size } = stream.source ?? {};
      await track("play_build", { ...facts(), outcome: warm ? "warm" : "built", addon, resolution, size }, room.requestedBy);
    } catch (error) {
      if (error instanceof Superseded) return;
      console.error("prepare failed", error);
      const message =
        error instanceof SourceError
          ? error.message
          : "Something went wrong starting this stream. Try another source.";
      await ctx.runMutation(internal.rooms.setError, {
        roomId, jobId, error: message,
        detail: error instanceof PlaybackUnavailable ? error.detail : undefined,
        fallback: error instanceof PlaybackUnavailable ? error.fallback : undefined,
      });
      await ctx.runMutation(internal.logs.playFailed, { videoId: media.videoId, message });
      // After the room has its message, so reporting never holds the error screen.
      await track("play_build", { ...facts(), outcome: "failed", error: error instanceof Error ? error.message : String(error) }, room.requestedBy);
      if (!(error instanceof SourceError)) await trackError(error, { action: "engine.prepare", ...facts() }, room.requestedBy);
    }
  },
});

/** Prepare a stream before anyone asks for it, so switching to it is instant. */
export const warm = internalAction({
  // Ranked for this profile's languages and screen, and the room's binge group; without them (older callers), for none.
  // `keysFrom`: whose account builds it (a room's host); else the profile's own.
  args: {
    media: mediaValidator, profileId: v.optional(v.id("profiles")), keysFrom: v.optional(v.id("profiles")),
    screen: v.optional(screenValidator), binge: v.optional(v.string()),
  },
  handler: async (ctx, { media, profileId, keysFrom, screen, binge }) => {
    const owner = keysFrom ?? profileId;
    if (!owner) return;
    try {
      await sharedStream(ctx, media, await viewerOf(ctx, profileId, screen, binge), await accessOf(ctx, owner));
    } catch (error) {
      // Nothing waits on a warm-up; the real request will try again and report any problem.
      console.warn(`warm ${media.videoId} failed`, error instanceof Error ? error.message : error);
    }
  },
});

/**
 * A recent stream for this episode ranked for this viewer, or else the right to build one now, with the last
 * stream from the past month to restart first.
 */
export const claimBuild = internalMutation({
  // `playableOnly`: leave out direct streams a browser can't play (an MKV played from its link).
  args: { videoId: v.string(), rankedFor: v.string(), accountId: v.optional(v.id("accounts")), playableOnly: v.optional(v.boolean()) },
  handler: async (ctx, { videoId, rankedFor, accountId, playableOnly }) => {
    const now = Date.now();
    const recent = await ctx.db
      .query("streams")
      .withIndex("by_account_video", (q) => q.eq("accountId", accountId).eq("videoId", videoId).gt("createdAt", now - REUSE_MS))
      .order("desc")
      .take(20);
    const latest =
      recent.find((s) => (s.rankedFor ?? "") === rankedFor && (!playableOnly || !s.direct || isBrowserContainer(s.direct.container))) ?? null;
    if (latest && now - latest.createdAt < WARM_TTL_MS) return { stream: latest, claimed: false, claimId: null, earlier: null };
    const builds = await ctx.db
      .query("streamBuilds")
      .withIndex("by_account_video", (q) => q.eq("accountId", accountId).eq("videoId", videoId).eq("rankedFor", rankedFor))
      .collect();
    const building = builds.find((b) => now - b.startedAt < BUILD_TTL_MS);
    if (building) return { stream: null, claimed: false, claimId: null, earlier: null, step: building.step };
    for (const b of builds) await ctx.db.delete(b._id);
    const claimId = await ctx.db.insert("streamBuilds", { videoId, rankedFor, startedAt: now, accountId });
    return { stream: null, claimed: true, claimId, earlier: latest };
  },
});

/** A restarted stream counts as prepared now: it starts at once for a while, and the sweep keeps it a month more. */
export const restarted = internalMutation({
  // Subtitles too, for streams prepared before their tracks were kept.
  // No session for a direct stream: there's nothing to restart but the clock.
  args: { streamId: v.id("streams"), presignedToken: v.optional(v.string()), domain: v.optional(v.string()), subtitles: v.optional(v.array(subtitleTrackValidator)) },
  handler: async (ctx, { streamId, presignedToken, domain, subtitles }) => {
    if (!(await ctx.db.get(streamId))) return null;
    await ctx.db.patch(streamId, presignedToken === undefined ? { createdAt: Date.now() } : { presignedToken, domain, subtitles, createdAt: Date.now() });
    return await ctx.db.get(streamId);
  },
});

/**
 * Drops streams nobody started in a month, a batch at a time. A room plays a stream for hours at most, so none in
 * use is old enough to go.
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("streams")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", Date.now() - REUSE_MS))
      .take(SWEEP_BATCH);
    for (const s of old) await ctx.db.delete(s._id);
    if (old.length === SWEEP_BATCH) await ctx.scheduler.runAfter(0, internal.engine.sweep, {});
  },
});

export const buildStep = internalMutation({
  args: { claimId: v.id("streamBuilds"), step: v.string() },
  handler: async (ctx, { claimId, step }) => {
    if (await ctx.db.get(claimId)) await ctx.db.patch(claimId, { step });
  },
});

export const releaseBuild = internalMutation({
  args: { videoId: v.string(), rankedFor: v.string(), claimId: v.id("streamBuilds"), accountId: v.optional(v.id("accounts")) },
  handler: async (ctx, { videoId, rankedFor, claimId }) => {
    const build = await ctx.db.get(claimId);
    if (build?.videoId === videoId && build.rankedFor === rankedFor) await ctx.db.delete(claimId);
  },
});

const audioValidator = v.object({
  language: v.optional(v.string()),
  title: v.optional(v.string()),
  codec: v.optional(v.string()),
  channels: v.optional(v.number()),
});

export const insertStream = internalMutation({
  args: {
    torrentId: v.optional(v.number()),
    fileId: v.optional(v.number()),
    hash: v.optional(v.string()),
    presignedToken: v.optional(v.string()),
    domain: v.optional(v.string()),
    direct: v.optional(v.object({ link: v.string(), container: v.optional(v.string()), audio: v.optional(v.array(v.string())), plain: v.optional(v.boolean()) })),
    duration: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    videoCodec: v.optional(v.string()),
    size: v.optional(v.number()),
    osHash: v.optional(v.string()),
    intro: v.optional(introValidator),
    recap: v.optional(introValidator),
    outro: v.optional(introValidator),
    audios: v.array(audioValidator),
    subtitles: v.optional(v.array(subtitleTrackValidator)),
    videoId: v.optional(v.string()),
    sourceIndex: v.optional(v.number()),
    sourceKey: v.optional(v.string()),
    rankedFor: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    source: v.optional(sourceSummaryValidator),
  },
  handler: async (ctx, args) => (await ctx.db.get(await ctx.db.insert("streams", { ...args, createdAt: Date.now() })))!,
});

export const getStream = internalQuery({
  args: { streamId: v.id("streams") },
  handler: async (ctx, { streamId }) => await ctx.db.get(streamId),
});

/**
 * Whether a profile may play a stream, which plays from its account's TorBox or from a link: a profile of that account,
 * or someone in an open room playing it now. Someone who pressed Leave or was kicked is out; one the sweep counted as
 * gone (a phone asleep) is still in, since their next heartbeat puts them back.
 *
 * Who of them may have the link itself is `mayHaveFile`. A TorBox stream's file link holds the account's TorBox key,
 * and another debrid service's file is the account's own, so those stay with the account and everyone else plays the
 * HLS. A plain web video (`direct.plain`) is another matter: no debrid service gave it, and neither the addon's link
 * nor the file's holds one of the account's keys or an addon's settings, so it's a link anyone could have found with
 * that addon. Handing it to the people in the room costs the account nothing, and it's the only way they can play it.
 */
export const mayPlay = internalQuery({
  args: { profileId: v.id("profiles"), streamId: v.id("streams") },
  returns: v.boolean(),
  handler: async (ctx, { profileId, streamId }) => {
    const [profile, stream] = await Promise.all([ctx.db.get(profileId), ctx.db.get(streamId)]);
    if (!profile || !stream) return false;
    if (profile.accountId && stream.accountId === profile.accountId) return true;
    return await inRoomPlaying(ctx, profileId, streamId);
  },
});

/** Whether the profile is in an open room playing this stream now (mayPlay). */
async function inRoomPlaying(ctx: QueryCtx, profileId: Id<"profiles">, streamId: Id<"streams">) {
  const rows = await ctx.db.query("roomMembers").withIndex("by_profile", (q) => q.eq("profileId", profileId)).collect();
  for (const row of rows) {
    if (row.kicked || (row.left && !row.swept)) continue;
    const room = await ctx.db.get(row.roomId);
    if (room && !room.closedAt && room.streamId === streamId) return true;
  }
  return false;
}

/**
 * Whether a profile may have the stream's own file link (desktop.fileLink, the HLS route of a plain .m3u8): a profile
 * of the stream's account, or, for a plain web video only, anyone mayPlay lets play it (see there for why).
 */
export const mayHaveFile = internalQuery({
  args: { profileId: v.id("profiles"), streamId: v.id("streams") },
  returns: v.boolean(),
  handler: async (ctx, { profileId, streamId }): Promise<boolean> => {
    const [profile, stream] = await Promise.all([ctx.db.get(profileId), ctx.db.get(streamId)]);
    if (!profile || !stream) return false;
    if (profile.accountId && stream.accountId === profile.accountId) return true;
    return !!stream.direct?.plain && (await inRoomPlaying(ctx, profileId, streamId));
  },
});

export const patchSegments = internalMutation({
  args: {
    streamId: v.id("streams"),
    intro: v.optional(introValidator),
    recap: v.optional(introValidator),
    outro: v.optional(introValidator),
  },
  handler: async (ctx, { streamId, intro, recap, outro }) => {
    await ctx.db.patch(streamId, { intro, recap, outro });
  },
});

export const patchStream = internalMutation({
  args: { streamId: v.id("streams"), presignedToken: v.string(), domain: v.string() },
  handler: async (ctx, { streamId, presignedToken, domain }) => {
    await ctx.db.patch(streamId, { presignedToken, domain });
  },
});
