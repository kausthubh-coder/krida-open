import type { WatchStatus } from "../../convex/lib/watchStatus";

export type { WatchStatus };

/** The status vocabulary, everywhere it's shown. */
export const WATCH_STATUSES: { value: WatchStatus; label: string }[] = [
  { value: "plantowatch", label: "Plan to watch" },
  { value: "watching", label: "Watching" },
  { value: "completed", label: "Watched" },
  { value: "rewatching", label: "Rewatching" },
  { value: "hold", label: "On hold" },
  { value: "dropped", label: "Dropped" },
];

export const statusLabel = (status: WatchStatus) => WATCH_STATUSES.find((s) => s.value === status)!.label;
