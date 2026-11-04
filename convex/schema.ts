import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { statsValidator } from "./lib/statsShape";
import { debridValidator } from "./lib/accounts";
import { addonSuggestionValidator, manifestValidator } from "./lib/addons";

export const mediaValidator = v.object({
  type: v.union(v.literal("movie"), v.literal("series")),
  imdbId: v.string(),
  // Stremio video id: "tt123" for movies, "tt123:1:2" for episodes
  videoId: v.string(),
  season: v.optional(v.number()),
  episode: v.optional(v.number()),
  name: v.string(),
  episodeTitle: v.optional(v.string()),
  poster: v.optional(v.string()),
  background: v.optional(v.string()),
  logo: v.optional(v.string()),
  year: v.optional(v.string()),
  // For anime (Kitsu ids): the same episode on IMDb, which IntroDB and subtitles understand.
  ref: v.optional(v.object({ imdbId: v.string(), season: v.optional(v.number()), episode: v.optional(v.number()) })),
});

export const prefsValidator = v.object({
  audioLang: v.string(),
  subLang: v.optional(v.string()),
  sounds: v.boolean(),
  // Home rows this profile hid, and its own order for them (row keys).
  hiddenRows: v.optional(v.array(v.string())),
  rowOrder: v.optional(v.array(v.string())),
  // Settings → Home's catalog editor: rows pinned above the rest, the row the banner draws from, its own names for
  // rows, rows that don't say whether they're movies or shows, and titles not out yet left off every row.
  pinnedRows: v.optional(v.array(v.string())),
  heroRow: v.optional(v.string()),
  rowNames: v.optional(v.array(v.object({ key: v.string(), name: v.string() }))),
  typeHiddenRows: v.optional(v.array(v.string())),
  hideUnreleased: v.optional(v.boolean()),
  // Automatic playback. Unset means on.
  skipIntro: v.optional(v.boolean()),
  skipRecap: v.optional(v.boolean()),
  autoNext: v.optional(v.boolean()),
  // Muted trailers on Home (the banner, and posters you rest on). Unset means on.
  trailers: v.optional(v.boolean()),
  // Private mode: what this profile watches isn't shown to the others (their Home, the party button). Unset means off.
  private: v.optional(v.boolean()),
  // Spoilers: unwatched episodes' stills and descriptions blurred (title page, the player's episodes panel and Up
  // next). Unset means off.
  blurUnwatched: v.optional(v.boolean()),
  // Continue watching: a finished show's next episode follows the furthest episode played, or the last one played
  // (unset); a next episode not out yet stays in the row (unset), gets a row of its own, or is left out.
  nextUpFrom: v.optional(v.union(v.literal("furthest"), v.literal("last"))),
  upcoming: v.optional(v.union(v.literal("row"), v.literal("hide"))),
  // A show's next episode tries the kind of file played last time first (`lastSources`). Unset means off.
  reuseSource: v.optional(v.boolean()),
  // Sources whose name or file matches this (a regular expression, any case) are left out, e.g. "CAM|TS|HDCAM".
  sourceFilter: v.optional(v.string()),
  // Subtitles: a second language for when the first has none, and how Krida draws them. Unset is medium white text
  // with a shadow, as before.
  subLang2: v.optional(v.string()),
  subtitleSize: v.optional(v.union(v.literal("small"), v.literal("medium"), v.literal("large"), v.literal("huge"))),
  subtitleColor: v.optional(v.union(v.literal("white"), v.literal("yellow"), v.literal("cyan"))),
  subtitleEdge: v.optional(v.union(v.literal("shadow"), v.literal("outline"), v.literal("box"))),
});

/** A title as catalogs and the recommender see it: display fields plus the features used to compare. */
export const catalogItemValidator = v.object({
  id: v.string(),
  type: v.union(v.literal("movie"), v.literal("series")),
  name: v.string(),
  poster: v.optional(v.string()),
  background: v.optional(v.string()),
  logo: v.optional(v.string()),
  year: v.optional(v.string()),
  description: v.optional(v.string()),
  rating: v.optional(v.number()),
  // Where `rating` comes from when it isn't IMDb (Cinemeta), so cards can label it.
  ratingSource: v.optional(v.literal("tmdb")),
  popularity: v.optional(v.number()),
  // Original language (ISO 639-1) and vote count, from TMDB when known: the recommender matches
  // what people actually watch (Telugu films, anime) and trusts well-voted titles more.
  lang: v.optional(v.string()),
  votes: v.optional(v.number()),
  genres: v.array(v.string()),
  cast: v.array(v.string()),
  director: v.array(v.string()),
  writer: v.array(v.string()),
});

export const recItemValidator = v.object({
  id: v.string(),
  type: v.union(v.literal("movie"), v.literal("series")),
  name: v.string(),
  poster: v.optional(v.string()),
  background: v.optional(v.string()),
  logo: v.optional(v.string()),
  year: v.optional(v.string()),
  description: v.optional(v.string()),
  rating: v.optional(v.number()),
  ratingSource: v.optional(v.literal("tmdb")),
  scores: v.optional(v.object({ imdb: v.optional(v.number()), tomatoes: v.optional(v.number()), metacritic: v.optional(v.number()),
    letterboxd: v.optional(v.number()), mal: v.optional(v.number()) })),
  genres: v.array(v.string()),
  reason: v.optional(v.string()),
  // YouTube id of its trailer (MDBList's), so a poster on Home can start it without looking it up.
  trailer: v.optional(v.string()),
});

/** The title a "Because you watched" row grows from, shown as the row's first tile. */
export const seedValidator = v.object({
  id: v.string(), name: v.string(), loved: v.boolean(), type: v.optional(v.union(v.literal("movie"), v.literal("series"))), poster: v.optional(v.string()),
});

const kindValidator = v.union(v.literal("movie"), v.literal("series"));

/** A profile's taste as the recommender reads it (shared/taste.ts), worked out in its browser. */
export const tasteValidator = v.object({
  seeds: v.array(v.object({
    id: v.string(), type: kindValidator, weight: v.number(), seen: v.boolean(), loved: v.boolean(),
    name: v.optional(v.string()), imdb: v.optional(v.string()),
  })),
  exclude: v.array(v.string()),
  disliked: v.array(v.object({ id: v.string(), type: kindValidator })),
  seenFranchises: v.array(v.string()),
});

export const ratingsValidator = v.object({
  score: v.optional(v.number()),
  imdb: v.optional(v.number()),
  tomatoes: v.optional(v.number()),
  popcorn: v.optional(v.number()),
  metacritic: v.optional(v.number()),
  letterboxd: v.optional(v.number()),
  mal: v.optional(v.number()),
  tmdb: v.optional(v.number()),
});

export const trackedStatusValidator = v.union(
  v.literal("watching"),
  v.literal("plantowatch"),
  v.literal("hold"),
  v.literal("completed"),
  v.literal("dropped"),
);

export const queueItemValidator = v.object({
  id: v.string(),
  media: mediaValidator,
  addedBy: v.id("profiles"),
  addedAt: v.number(),
});

/** Something on the lobby's table: who suggested it, and who's in for it. */
export const suggestionValidator = v.object({
  id: v.string(),
  media: mediaValidator,
  by: v.id("profiles"),
  inIds: v.array(v.id("profiles")),
  createdAt: v.number(),
});

/** Asking the people watching to switch titles, instead of yanking the picture away from them. */
export const switchRequestValidator = v.object({
  id: v.string(),
  media: mediaValidator,
  startAt: v.number(),
  by: v.id("profiles"),
  createdAt: v.number(),
  declinedBy: v.optional(v.id("profiles")),
});

export const outboxOpValidator = v.union(v.literal("watched"), v.literal("plan"), v.literal("unplan"), v.literal("rate"),
  v.literal("status"), v.literal("unwatch"));

/** One of a file's own subtitle tracks, as TorBox lists it. */
export const subtitleTrackValidator = v.object({
  language: v.optional(v.string()),
  title: v.optional(v.string()),
  codec: v.optional(v.string()),
});

export const introValidator = v.object({ start: v.number(), end: v.number(), source: v.string() });
export const viewingStateValidator = v.union(trackedStatusValidator, v.literal("rewatching"));

/** Whether a device's screen is showing HDR right now (CSS `dynamic-range`), or it's Krida for Windows (`Screen`). */
export const screenValidator = v.union(v.literal("sdr"), v.literal("hdr"), v.literal("app"));

export const sourceSummaryValidator = v.object({
  addon: v.string(),
  resolution: v.optional(v.string()),
  quality: v.optional(v.string()),
  size: v.optional(v.number()),
  filename: v.optional(v.string()),
  // The addon's binge group (`RawSource`), so the next episode can look for the same kind of file.
  bingeGroup: v.optional(v.string()),
});

export const sourceFallbackValidator = v.object({ index: v.number(), key: v.string(), resolution: v.string() });

export default defineSchema({
  // One Clerk sign-in with its profiles (up to 8) and keys (lib/accounts.ts).
  accounts: defineTable({
    name: v.string(),
    clerkUserId: v.optional(v.string()),
    createdAt: v.number(),
    // Onboarding (convex/onboarding.ts): when the account went past the debrid step and the optional keys step,
    // whether it added something or skipped, and when it last skipped the TMDB step. Kept here so it resumes on
    // another device.
    tmdbAskedAt: v.optional(v.number()),
    debridAskedAt: v.optional(v.number()),
    extrasAskedAt: v.optional(v.number()),
  }).index("by_clerkUserId", ["clerkUserId"]).index("by_name", ["name"]),

  // An account's provider keys, each checked with its provider when saved. Only that account's sessions read them.
  accountKeys: defineTable({
    accountId: v.id("accounts"),
    tmdb: v.optional(v.string()),
    mdblist: v.optional(v.string()),
    debrid: v.optional(debridValidator),
    updatedAt: v.number(),
    // A saved key its provider turned down later (onboarding.recheck): sends the account to fix it. Cleared by a new key.
    tmdbRefusedAt: v.optional(v.number()),
    debridRefusedAt: v.optional(v.number()),
    // The last time onboarding.recheck asked the providers, so a burst of app opens asks once.
    checkedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // A profile's Stremio addons (lib/addons.ts), in its order. `url` is the addon's base (no /manifest.json); it can
  // hold a key, so only the profile's own sessions read it.
  addons: defineTable({
    profileId: v.id("profiles"),
    url: v.string(),
    manifest: manifestValidator,
    enabled: v.boolean(),
    order: v.number(),
    // Installed from Krida's suggestions, built with the account's debrid key.
    suggestion: v.optional(addonSuggestionValidator),
    installedAt: v.number(),
  }).index("by_profile", ["profileId", "order"]),

  profiles: defineTable({
    name: v.string(),
    hue: v.number(),
    // Only QA profiles have a password (profiles.qaSignIn); everyone else picks their profile after Clerk sign-in.
    passwordHash: v.optional(v.string()),
    salt: v.optional(v.string()),
    // An optional 4-digit PIN asked for when the profile is chosen, hashed like passwords.
    pin: v.optional(v.object({ hash: v.string(), salt: v.string() })),
    order: v.number(),
    failedAttempts: v.number(),
    lockedUntil: v.optional(v.number()),
    prefs: prefsValidator,
    recsJobId: v.optional(v.id("_scheduled_functions")),
    expiresAt: v.optional(v.number()),
    // Unset on temporary party guests, who have no account and no keys.
    accountId: v.optional(v.id("accounts")),
    // Onboarding's addons step, once this profile went past it (convex/onboarding.ts). A profile with addons is past it.
    addonsStep: v.optional(v.union(v.literal("installed"), v.literal("skipped"))),
  }).index("by_account", ["accountId"]).index("by_name", ["name"]),

  temporaryInvites: defineTable({
    roomId: v.id("rooms"),
    name: v.string(),
    hue: v.number(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    profileId: v.optional(v.id("profiles")),
  }).index("by_tokenHash", ["tokenHash"]).index("by_room", ["roomId"]),

  // Catalog rows (AIOStreams catalogs, Cinemeta popular and genre rows), refreshed on a schedule so
  // the home screen reads them instantly.
  catalogCache: defineTable({
    key: v.string(),
    title: v.string(),
    type: v.union(v.literal("movie"), v.literal("series")),
    source: v.string(),
    items: v.array(catalogItemValidator),
    fetchedAt: v.number(),
  }).index("by_key", ["key"]),

  // What Home shows of each catalog row: display fields only and only as many as a row shows, so
  // the home query reads a few kilobytes per row instead of every title's cast and crew.
  catalogRows: defineTable({
    key: v.string(),
    title: v.string(),
    type: v.union(v.literal("movie"), v.literal("series")),
    source: v.string(),
    items: v.array(recItemValidator),
    fetchedAt: v.number(),
    // The full row in catalogCache, and a digest of its items, so a refresh can skip unchanged rows
    // without reading the big document.
    cacheId: v.optional(v.id("catalogCache")),
    digest: v.optional(v.string()),
  }).index("by_key", ["key"]).index("by_source", ["source"]),

  // "More like this" per title, shared by everyone for a week: computing it reads every catalog row.
  moreLike: defineTable({ id: v.string(), items: v.array(recItemValidator), at: v.number() }).index("by_title", ["id"]),

  // Singletons for background work, e.g. the one pending recommendation refresh.
  jobs: defineTable({
    name: v.string(),
    jobId: v.optional(v.id("_scheduled_functions")),
    ranAt: v.optional(v.number()),
    // When the change that booked the pending run came: later ones push it back, up to a limit.
    since: v.optional(v.number()),
  }).index("by_name", ["name"]),

  // Features for titles someone watched, to compare candidates against.
  metaCache: defineTable({
    item: catalogItemValidator,
    fetchedAt: v.number(),
  }).index("by_item_id", ["item.id"]),

  // Recommendation rows per profile, recomputed when what they watch changes.
  recs: defineTable({
    profileId: v.id("profiles"),
    kind: v.union(v.literal("picks"), v.literal("because"), v.literal("together"), v.literal("taste")),
    title: v.string(),
    seedId: v.optional(v.string()),
    seed: v.optional(seedValidator),
    genres: v.optional(v.array(v.string())),
    // On the taste row: the languages this profile watches most ("anime" for anime), best first.
    langs: v.optional(v.array(v.string())),
    items: v.array(recItemValidator),
    order: v.number(),
    computedAt: v.number(),
    // On the taste row (always order 0): the digest of the taste these rows were computed from (shared/taste.ts), and
    // of the others' tastes the "For you and…" rows used.
    digest: v.optional(v.string()),
    othersDigest: v.optional(v.string()),
  }).index("by_profile", ["profileId", "order"]),

  // Each profile's taste from its last recompute, for the "For you and…" rows of the others.
  tastes: defineTable({ profileId: v.id("profiles"), taste: tasteValidator, digest: v.string(), at: v.number() })
    .index("by_profile", ["profileId"]),

  // Ratings and ids for a title from MDBList and TMDB, and the titles TMDB says its fans also liked.
  titleInfo: defineTable({
    imdbId: v.string(),
    tmdbId: v.optional(v.number()),
    tmdbType: v.optional(v.union(v.literal("movie"), v.literal("tv"))),
    ratings: v.optional(ratingsValidator),
    certification: v.optional(v.string()),
    trailer: v.optional(v.string()),
    // Original language (ISO 639-1), from TMDB.
    lang: v.optional(v.string()),
    // TMDB artwork, for titles the usual artwork service doesn't have; "" means TMDB has none either.
    poster: v.optional(v.string()),
    background: v.optional(v.string()),
    artAt: v.optional(v.number()),
    ratedAt: v.optional(v.number()),
    // IMDb ids, best first.
    similar: v.optional(v.array(v.object({ id: v.string(), type: v.union(v.literal("movie"), v.literal("series")),
      lang: v.optional(v.string()), votes: v.optional(v.number()), vote: v.optional(v.number()) }))),
    similarAt: v.optional(v.number()),
    // TMDB had no IMDb id for this TMDB id when last asked (imdbId is ""), so searches don't keep asking.
    noImdbAt: v.optional(v.number()),
  })
    .index("by_imdb", ["imdbId"])
    .index("by_tmdb", ["tmdbType", "tmdbId"]),

  // What a profile told Krida about a title: not for me, I like this, love this.
  feedback: defineTable({
    profileId: v.id("profiles"),
    id: v.string(),
    type: v.union(v.literal("movie"), v.literal("series")),
    // A cleared thumb keeps its timestamp so an older import cannot restore it.
    value: v.union(v.literal("down"), v.literal("up"), v.literal("love"), v.null()),
    rating: v.optional(v.union(v.number(), v.null())),
    syncError: v.optional(v.string()),
    name: v.string(),
    poster: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_profile", ["profileId", "at"])
    .index("by_profile_id", ["profileId", "id"]),

  partRatings: defineTable({
    profileId: v.id("profiles"), id: v.string(), season: v.number(), episode: v.optional(v.number()),
    rating: v.union(v.number(), v.null()), at: v.number(),
  }).index("by_profile", ["profileId"]).index("by_title", ["profileId", "id"])
    .index("by_part", ["profileId", "id", "season", "episode"]),

  viewing: defineTable({
    profileId: v.id("profiles"), id: v.string(), type: v.union(v.literal("movie"), v.literal("series")),
    name: v.string(), poster: v.optional(v.string()), state: viewingStateValidator, at: v.number(), syncError: v.optional(v.string()),
    syncedAt: v.optional(v.number()),
  }).index("by_profile", ["profileId"]).index("by_title", ["profileId", "id"]),

  // A profile's own tracker account. Tokens never leave the server.
  connections: defineTable({
    profileId: v.id("profiles"),
    provider: v.literal("simkl"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    scope: v.string(),
    account: v.optional(v.object({ name: v.string(), avatar: v.optional(v.string()) })),
    // The last /sync/activities response, so each sync fetches only what changed.
    snapshot: v.optional(v.string()),
    syncing: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    needsReconnect: v.optional(v.boolean()),
    writeBack: v.boolean(),
    connectedAt: v.number(),
    // When the outbox is due to be sent next (a send is scheduled for then).
    flushAt: v.optional(v.number()),
    flushJobId: v.optional(v.id("_scheduled_functions")),
    // Simkl said "slow down" (429): nothing is sent or fetched before this.
    backoffUntil: v.optional(v.number()),
    // Requests made today (UTC), to stay well inside the user's shared daily allowance.
    usage: v.optional(v.object({ day: v.string(), count: v.number() })),
  }).index("by_profile", ["profileId", "provider"]),

  // Changes made in Krida waiting to go to Simkl, batched and retried with backoff.
  syncOutbox: defineTable({
    profileId: v.id("profiles"),
    op: outboxOpValidator,
    // Coalescing key: one pending change per episode or per watchlist entry.
    key: v.string(),
    item: v.object({
      id: v.string(),
      type: v.union(v.literal("movie"), v.literal("series")),
      name: v.string(),
      year: v.optional(v.string()),
      season: v.optional(v.number()),
      episode: v.optional(v.number()),
      // For "rate": 1–10, or 0 to clear the rating.
      rating: v.optional(v.number()),
      status: v.optional(trackedStatusValidator),
    }),
    at: v.number(),
    attempts: v.number(),
    nextAt: v.number(),
    // A sender has taken a snapshot. Further edits must get a new row id.
    inFlight: v.optional(v.boolean()),
  })
    .index("by_profile", ["profileId", "nextAt"])
    .index("by_key", ["profileId", "key"]),

  oauthStates: defineTable({
    state: v.string(),
    profileId: v.id("profiles"),
    provider: v.literal("simkl"),
    verifier: v.string(),
    redirectUri: v.string(),
    createdAt: v.number(),
  }).index("by_state", ["state"]),

  // Titles from a profile's tracker: what they finished, are watching, dropped, rated or plan to watch.
  tracked: defineTable({
    profileId: v.id("profiles"),
    source: v.literal("simkl"),
    externalId: v.number(),
    // The id Krida opens it with: "tt…" or "kitsu:…".
    id: v.string(),
    // Its IMDb id when that differs (anime opened by Kitsu id), for TMDB suggestions and duplicates.
    imdb: v.optional(v.string()),
    type: v.union(v.literal("movie"), v.literal("series")),
    name: v.string(),
    poster: v.optional(v.string()),
    year: v.optional(v.string()),
    status: trackedStatusValidator,
    rating: v.optional(v.number()),
    ratedAt: v.optional(v.number()),
    watchedEpisodes: v.optional(v.number()),
    totalEpisodes: v.optional(v.number()),
    // The episode Simkl says comes next for a show in progress.
    nextSeason: v.optional(v.number()),
    nextEpisode: v.optional(v.number()),
    // Watched episodes, compact: "1:1-12,14;2:1-3".
    watched: v.optional(v.string()),
    // When each episode was marked watched, compact: "1:1@<base36 seconds>,1:2@…". For stats.
    watchedAt: v.optional(v.string()),
    // Minutes per episode (or per movie), as Simkl reports it.
    runtime: v.optional(v.number()),
    lastWatchedAt: v.optional(v.number()),
    addedAt: v.optional(v.number()),
  })
    .index("by_profile", ["profileId", "source"])
    .index("by_profile_id", ["profileId", "id"])
    // An IMDb id is an alias of the Kitsu entry that carries it (lib/titleIds).
    .index("by_profile_imdb", ["profileId", "imdb"])
    .index("by_status", ["profileId", "status"])
    .index("by_profile_external", ["profileId", "source", "externalId"]),

  // Which of a profile's rows changed when (one row per document, moved forward on each change), so each browser
  // fetches only what changed since it last looked (convex/sync.ts). Kept 30 days.
  changes: defineTable({ profileId: v.id("profiles"), table: v.string(), docId: v.string(), at: v.number() })
    .index("by_profile_at", ["profileId", "at"])
    .index("by_doc", ["docId"])
    .index("by_at", ["at"]),
  // The newest change forgotten per profile: a copy from before it can't catch up by pulling.
  syncFloors: defineTable({ profileId: v.id("profiles"), at: v.number() }).index("by_profile", ["profileId"]),

  sessions: defineTable({
    profileId: v.id("profiles"),
    tokenHash: v.string(),
    createdAt: v.number(),
    // Set when a Clerk sign-in chose the profile: the token then works only for that Clerk user, and signing out of
    // that Clerk session ends it. Unset for QA sign-ins and temporary guests.
    accountId: v.optional(v.id("accounts")),
    clerkUserId: v.optional(v.string()),
    clerkSessionId: v.optional(v.string()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_profile", ["profileId"])
    .index("by_account", ["accountId"])
    .index("by_clerkSession", ["clerkSessionId"]),

  library: defineTable({
    profileId: v.id("profiles"),
    type: v.union(v.literal("movie"), v.literal("series")),
    imdbId: v.string(),
    name: v.string(),
    poster: v.optional(v.string()),
    year: v.optional(v.string()),
    addedAt: v.number(),
    // On the profile's Simkl watchlist and kept in step with it: it leaves Plan to watch when it leaves there.
    source: v.optional(v.literal("simkl")),
  })
    .index("by_profile", ["profileId", "addedAt"])
    .index("by_profile_imdb", ["profileId", "imdbId"]),

  progress: defineTable({
    profileId: v.id("profiles"),
    media: mediaValidator,
    position: v.number(),
    duration: v.number(),
    finished: v.boolean(),
    hidden: v.optional(v.boolean()),
    // Played or marked in private mode: kept off the others' "has been watching" rows, even once it's turned off.
    private: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_profile_updated", ["profileId", "updatedAt"])
    .index("by_profile_video", ["profileId", "media.videoId"])
    .index("by_profile_imdb", ["profileId", "media.imdbId", "updatedAt"]),

  // Raw addon results stay on the server: their URLs carry account credentials. The list itself (about 120 KB, mostly
  // playback URLs) is a file in Convex's storage, so checking and reading it costs no database reads.
  sourceLists: defineTable({
    key: v.string(),
    file: v.optional(v.id("_storage")),
    // Lists saved before files: dropped within two days by the sweep.
    items: v.optional(v.array(
      v.object({
        url: v.string(),
        name: v.string(),
        description: v.string(),
        filename: v.optional(v.string()),
        size: v.optional(v.number()),
      }),
    )),
    fetchedAt: v.number(),
  }).index("by_key", ["key"]).index("by_fetchedAt", ["fetchedAt"]),

  // When each source list was fetched, and whether a fetch is under way (the others wait for its answer).
  sourceFetches: defineTable({
    key: v.string(),
    fetchedAt: v.optional(v.number()),
    fetchingSince: v.optional(v.number()),
    // Hashes identify failed provider links without storing credentials. A refreshed list clears them.
    failedLinks: v.optional(v.array(v.string())),
  }).index("by_key", ["key"]),

  streams: defineTable({
    // A TorBox stream: the file in the account's TorBox and the session its HLS plays from. Unset on a direct stream.
    torrentId: v.optional(v.number()),
    fileId: v.optional(v.number()),
    hash: v.optional(v.string()),
    presignedToken: v.optional(v.string()),
    domain: v.optional(v.string()),
    // A direct stream (another debrid service, or a plain web video): the addon's link, which redirects to the file. It
    // can carry the account's debrid key or the addon's settings, so it never leaves the server; the file's link goes
    // to that account's sessions, and for a `plain` one (no debrid service, no secret in either link) to the room's
    // members too (desktop.fileLink, engine.mayPlay). `container` and the audio formats say whether a browser can play
    // the file (src/features/player/playsIn.ts).
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
    // What it was prepared for, so a queued title or the next episode can start instantly.
    videoId: v.optional(v.string()),
    sourceIndex: v.optional(v.number()),
    // Names the file across refetches of the source list (`sourceKey` in lib/rank).
    sourceKey: v.optional(v.string()),
    // The audio and subtitle languages it was ranked for (see engine.ts); unset means none.
    rankedFor: v.optional(v.string()),
    source: v.optional(sourceSummaryValidator),
    audios: v.array(
      v.object({
        language: v.optional(v.string()),
        title: v.optional(v.string()),
        codec: v.optional(v.string()),
        channels: v.optional(v.number()),
      }),
    ),
    // The file's own subtitle tracks (`createStream`). Unset on streams prepared before they were kept.
    subtitles: v.optional(v.array(subtitleTrackValidator)),
    // When its TorBox session was last started (see `restarted` in engine.ts).
    createdAt: v.number(),
    // Whose TorBox holds the file: torrent and file ids mean something only in that account's TorBox.
    accountId: v.optional(v.id("accounts")),
  })
    .index("by_videoId", ["videoId", "createdAt"])
    .index("by_account_video", ["accountId", "videoId", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // The kind of file a profile last played of each show: the addon's binge group, else "release:<group>|<resolution>".
  // With "Reuse the last source" on, the show's next episode tries the same kind first (engine.ts `sameKind`).
  lastSources: defineTable({
    profileId: v.id("profiles"),
    show: v.string(),
    group: v.string(),
    at: v.number(),
  }).index("by_profile_show", ["profileId", "show"]),

  // A stream being prepared right now, so a warm-up and a press of Play share one TorBox build.
  streamBuilds: defineTable({
    videoId: v.string(),
    rankedFor: v.string(),
    startedAt: v.number(),
    // What the build is doing, so a Play waiting on it can say so.
    step: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
  }).index("by_video", ["videoId", "rankedFor"]).index("by_account_video", ["accountId", "videoId", "rankedFor"]),

  rooms: defineTable({
    hostId: v.id("profiles"),
    // The host's account, so rooms.live finds the rooms hosted in yours without reading everyone's.
    hostAccountId: v.optional(v.id("accounts")),
    // The party's invite link: anyone signed in who opens it may join. Unset until first shared, and once it ends.
    linkCode: v.optional(v.string()),
    // "solo": someone pressed Play. "party": a shared space that outlives any one title.
    kind: v.optional(v.union(v.literal("solo"), v.literal("party"))),
    // A solo room a friend dropped into: it goes back to solo once the host is alone in it again.
    startedSolo: v.optional(v.boolean()),
    // Empty while a party is still picking what to watch.
    media: v.optional(mediaValidator),
    // Legacy multi-item Up next. Replaced by `next`; kept so older rooms still validate.
    queue: v.optional(v.array(queueItemValidator)),
    // "Watch after this": the one thing lined up after the current title.
    next: v.optional(queueItemValidator),
    suggestions: v.optional(v.array(suggestionValidator)),
    // Everyone present is in for a suggestion: it starts at `at` (server time) unless someone cancels.
    starting: v.optional(v.object({ suggestionId: v.string(), at: v.number() })),
    switchRequest: v.optional(switchRequestValidator),
    // Autoplay is off after this video, for everyone.
    stopAfter: v.optional(v.object({ by: v.id("profiles"), videoId: v.string() })),
    // Someone chose Watch credits on this video: Up next waits for its end.
    credits: v.optional(v.object({ by: v.id("profiles"), videoId: v.string() })),
    requestedBy: v.optional(v.id("profiles")),
    status: v.union(
      v.literal("idle"),
      v.literal("choosing"),
      v.literal("preparing"),
      v.literal("ready"),
      v.literal("error"),
    ),
    step: v.optional(v.string()),
    // Why the step is taking a while: "That copy was slow. Trying another."
    stepNote: v.optional(v.string()),
    error: v.optional(v.string()),
    errorDetail: v.optional(v.string()),
    sourceFallback: v.optional(sourceFallbackValidator),
    // Someone picked a source of this show (`media.imdbId`): its next episodes try the same binge group first.
    binge: v.optional(v.object({ show: v.string(), group: v.string() })),
    streamId: v.optional(v.id("streams")),
    source: v.optional(sourceSummaryValidator),
    sourceIndex: v.optional(v.number()),
    jobId: v.optional(v.number()),
    // Titles that started on their own in a row, with nobody pausing, seeking or chatting in between.
    autoStreak: v.optional(v.number()),
    playback: v.object({
      playing: v.boolean(),
      position: v.number(),
      anchorAt: v.number(),
      seq: v.number(),
      by: v.optional(v.id("profiles")),
      action: v.optional(v.string()),
    }),
    createdAt: v.number(),
    lastActiveAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_lastActive", ["lastActiveAt"])
    .index("by_open", ["closedAt", "lastActiveAt"])
    .index("by_hostAccount_open", ["hostAccountId", "closedAt", "lastActiveAt"])
    .index("by_link", ["linkCode"]),

  roomMembers: defineTable({
    roomId: v.id("rooms"),
    profileId: v.id("profiles"),
    joinedAt: v.number(),
    lastSeenAt: v.number(),
    buffering: v.boolean(),
    position: v.number(),
    // In the player right now, as opposed to browsing elsewhere in the app.
    watching: v.optional(v.boolean()),
    left: v.boolean(),
    // Set when the sweep counted them as gone (not when they pressed Leave): their next heartbeat
    // puts them back.
    swept: v.optional(v.boolean()),
    // The host removed them: they stay out, link or not.
    kicked: v.optional(v.boolean()),
    // Their screen, from their last heartbeat: what the room plays is picked to look right on it.
    screen: v.optional(screenValidator),
  })
    .index("by_room", ["roomId"])
    .index("by_room_profile", ["roomId", "profileId"])
    .index("by_profile", ["profileId", "lastSeenAt"]),

  invites: defineTable({
    roomId: v.id("rooms"),
    fromId: v.id("profiles"),
    toId: v.id("profiles"),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    // "knock": the other way round, someone asking whoever is watching alone to let them join.
    kind: v.optional(v.literal("knock")),
  })
    .index("by_to_status", ["toId", "status"])
    .index("by_room", ["roomId"]),

  // "I didn't watch this": hides history recorded before `at` from Library, stats, ratings and picks.
  unwatched: defineTable({
    profileId: v.id("profiles"), id: v.string(), type: v.union(v.literal("movie"), v.literal("series")),
    name: v.string(), at: v.number(),
    // Simkl has already removed it from history.
    sent: v.optional(v.boolean()), syncError: v.optional(v.string()),
  }).index("by_title", ["profileId", "id"]),

  // Genres, people and country for titles in someone's history, for stats.
  titleFacts: defineTable({
    id: v.string(), genres: v.array(v.string()), cast: v.array(v.string()), director: v.array(v.string()),
    country: v.optional(v.string()), runtime: v.optional(v.number()), fetchedAt: v.number(),
  }).index("by_title", ["id"]),

  // Each profile's stats and Wrapped, recomputed nightly and when Stats is opened after a while.
  wrapped: defineTable({
    profileId: v.id("profiles"), version: v.number(), computedAt: v.number(), timeZone: v.optional(v.string()),
    jobId: v.optional(v.id("_scheduled_functions")), stats: v.optional(statsValidator), revision: v.optional(v.number()),
    // When Stats was last opened: until a while after, changes rebuild them right away (lib/statsCache.ts).
    viewedAt: v.optional(v.number()),
  }).index("by_profile", ["profileId"]),

  // What failed in someone's browser or app, for debugging (convex/logs.ts). Kept 14 days.
  clientLogs: defineTable({
    at: v.number(),
    profileId: v.optional(v.id("profiles")),
    // Short and stable, to filter by: "meta", "api", "error", "player"…
    kind: v.string(),
    message: v.string(),
    detail: v.optional(v.string()),
    // The path it happened on, the platform ("web", "android", "windows 0.1.2") and the build's commit.
    page: v.string(),
    platform: v.string(),
    build: v.optional(v.string()),
  }).index("by_at", ["at"]),

  messages: defineTable({
    roomId: v.id("rooms"),
    profileId: v.id("profiles"),
    kind: v.union(v.literal("chat"), v.literal("reaction"), v.literal("event")),
    body: v.string(),
    createdAt: v.number(),
  }).index("by_room", ["roomId", "createdAt"]),
});
