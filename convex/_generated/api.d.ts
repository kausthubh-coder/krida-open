/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as addons from "../addons.js";
import type * as admin from "../admin.js";
import type * as catalogs from "../catalogs.js";
import type * as crons from "../crons.js";
import type * as desktop from "../desktop.js";
import type * as engine from "../engine.js";
import type * as feedback from "../feedback.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as legacy from "../legacy.js";
import type * as lib_accounts from "../lib/accounts.js";
import type * as lib_addons from "../lib/addons.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_deployment from "../lib/deployment.js";
import type * as lib_episodes from "../lib/episodes.js";
import type * as lib_keyCheck from "../lib/keyCheck.js";
import type * as lib_libraryViews from "../lib/libraryViews.js";
import type * as lib_mergeTitle from "../lib/mergeTitle.js";
import type * as lib_parse from "../lib/parse.js";
import type * as lib_prefs from "../lib/prefs.js";
import type * as lib_profiles from "../lib/profiles.js";
import type * as lib_providers from "../lib/providers.js";
import type * as lib_rank from "../lib/rank.js";
import type * as lib_ratings from "../lib/ratings.js";
import type * as lib_rooms from "../lib/rooms.js";
import type * as lib_simkl from "../lib/simkl.js";
import type * as lib_simklApi from "../lib/simklApi.js";
import type * as lib_simklOutbox from "../lib/simklOutbox.js";
import type * as lib_simklPull from "../lib/simklPull.js";
import type * as lib_stats from "../lib/stats.js";
import type * as lib_statsCache from "../lib/statsCache.js";
import type * as lib_statsShape from "../lib/statsShape.js";
import type * as lib_synced from "../lib/synced.js";
import type * as lib_telemetry from "../lib/telemetry.js";
import type * as lib_titleIds from "../lib/titleIds.js";
import type * as lib_traktApi from "../lib/traktApi.js";
import type * as lib_traktOutbox from "../lib/traktOutbox.js";
import type * as lib_traktPull from "../lib/traktPull.js";
import type * as lib_unwatched from "../lib/unwatched.js";
import type * as lib_watchStatus from "../lib/watchStatus.js";
import type * as library from "../library.js";
import type * as logs from "../logs.js";
import type * as messages from "../messages.js";
import type * as onboarding from "../onboarding.js";
import type * as preview from "../preview.js";
import type * as profiles from "../profiles.js";
import type * as progress from "../progress.js";
import type * as ratings from "../ratings.js";
import type * as recs from "../recs.js";
import type * as rooms from "../rooms.js";
import type * as simkl from "../simkl.js";
import type * as sources from "../sources.js";
import type * as sync from "../sync.js";
import type * as titles from "../titles.js";
import type * as trailers from "../trailers.js";
import type * as trakt from "../trakt.js";
import type * as wrapped from "../wrapped.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  addons: typeof addons;
  admin: typeof admin;
  catalogs: typeof catalogs;
  crons: typeof crons;
  desktop: typeof desktop;
  engine: typeof engine;
  feedback: typeof feedback;
  functions: typeof functions;
  http: typeof http;
  invites: typeof invites;
  legacy: typeof legacy;
  "lib/accounts": typeof lib_accounts;
  "lib/addons": typeof lib_addons;
  "lib/auth": typeof lib_auth;
  "lib/deployment": typeof lib_deployment;
  "lib/episodes": typeof lib_episodes;
  "lib/keyCheck": typeof lib_keyCheck;
  "lib/libraryViews": typeof lib_libraryViews;
  "lib/mergeTitle": typeof lib_mergeTitle;
  "lib/parse": typeof lib_parse;
  "lib/prefs": typeof lib_prefs;
  "lib/profiles": typeof lib_profiles;
  "lib/providers": typeof lib_providers;
  "lib/rank": typeof lib_rank;
  "lib/ratings": typeof lib_ratings;
  "lib/rooms": typeof lib_rooms;
  "lib/simkl": typeof lib_simkl;
  "lib/simklApi": typeof lib_simklApi;
  "lib/simklOutbox": typeof lib_simklOutbox;
  "lib/simklPull": typeof lib_simklPull;
  "lib/stats": typeof lib_stats;
  "lib/statsCache": typeof lib_statsCache;
  "lib/statsShape": typeof lib_statsShape;
  "lib/synced": typeof lib_synced;
  "lib/telemetry": typeof lib_telemetry;
  "lib/titleIds": typeof lib_titleIds;
  "lib/traktApi": typeof lib_traktApi;
  "lib/traktOutbox": typeof lib_traktOutbox;
  "lib/traktPull": typeof lib_traktPull;
  "lib/unwatched": typeof lib_unwatched;
  "lib/watchStatus": typeof lib_watchStatus;
  library: typeof library;
  logs: typeof logs;
  messages: typeof messages;
  onboarding: typeof onboarding;
  preview: typeof preview;
  profiles: typeof profiles;
  progress: typeof progress;
  ratings: typeof ratings;
  recs: typeof recs;
  rooms: typeof rooms;
  simkl: typeof simkl;
  sources: typeof sources;
  sync: typeof sync;
  titles: typeof titles;
  trailers: typeof trailers;
  trakt: typeof trakt;
  wrapped: typeof wrapped;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
