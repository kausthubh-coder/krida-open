import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Party housekeeping: expire invites, drop people who left without leaving, end idle parties. Sweeps book
// themselves every 2 minutes while a room is open (rooms.ts); this catches any room they missed. Every minute
// cost each deployment, previews included, 1,440 calls a day with nobody watching.
crons.interval("sweep parties", { minutes: 15 }, internal.rooms.sweep, {});

// Library stats and Wrapped, overnight (US Central) so they're fresh in the morning.
crons.daily("compute stats", { hourUTC: 9, minuteUTC: 0 }, internal.wrapped.computeAll, {});

// Drop source lists after two days and streams nobody started in a month (TorBox keeps files that long).
crons.daily("drop old source lists", { hourUTC: 10, minuteUTC: 0 }, internal.sources.sweep, {});
crons.daily("drop old streams", { hourUTC: 10, minuteUTC: 5 }, internal.engine.sweep, {});

// Changes browsers have long since fetched.
crons.daily("forget old changes", { hourUTC: 10, minuteUTC: 10 }, internal.sync.prune, {});

// Failures browsers reported, after two weeks.
crons.daily("forget old logs", { hourUTC: 10, minuteUTC: 15 }, internal.logs.prune, {});

export default crons;
