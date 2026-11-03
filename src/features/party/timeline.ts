/**
 * The party's conversation, shaped for reading: chat grouped by person, and what happened in the
 * party ("Ben put on Dune") folded into short activity blocks between the messages. The server
 * stores events as plain sentences, so they are recognised here by their wording.
 */

export type Row = { _id: string; kind: "chat" | "reaction" | "event"; profileId: string; body: string; createdAt: number };

export type ActivityKind =
  | "start"
  | "join"
  | "leave"
  | "back"
  | "play"
  | "picking"
  | "queue"
  | "suggest"
  | "in"
  | "holdoff"
  | "stop"
  | "autoplay"
  | "keep"
  | "other";

/** One line of activity: "<who> <before><title><after>". */
export type Activity = {
  id: string;
  kind: ActivityKind;
  profileId: string;
  mine: boolean;
  before: string;
  title?: string;
  after?: string;
  /** People who said they're in for a suggestion on the same line ("· Ben is in"). */
  alsoIn: string[];
  at: number;
};

export type Bubble = { id: string; body: string; at: number };

export type TimelineItem =
  | { type: "time"; id: string; at: number }
  | { type: "chat"; id: string; profileId: string; mine: boolean; bubbles: Bubble[] }
  | { type: "activity"; id: string; lines: Activity[] };

/** A new chat group starts after this much quiet from the same person. */
const GROUP_GAP_MS = 5 * 60_000;
/** A time label goes in after this much quiet. */
const TIME_GAP_MS = 15 * 60_000;

const patterns: [ActivityKind, RegExp][] = [
  ["start", /^started the party$/],
  ["join", /^joined$/],
  ["leave", /^left the party$/],
  ["back", /^is back$/],
  ["play", /^put on (.+)$/],
  ["picking", /^went back to picking$/],
  ["queue", /^lined up (.+) for after this$/],
  ["queue", /^added (.+) to Up next$/],
  ["suggest", /^suggested (.+)$/],
  ["in", /^is in for (.+)$/],
  ["holdoff", /^held off on (.+)$/],
  ["stop", /^stopped autoplay after (.+)$/],
  ["autoplay", /^turned autoplay back on$/],
  ["keep", /^wants to keep watching$/],
];

/** Reads an event sentence, conjugated for whoever did it ("You are in", "Ben is in"). */
export function parseEvent(row: Row, meId: string): Activity {
  const mine = row.profileId === meId;
  const base = { id: row._id, profileId: row.profileId, mine, alsoIn: [], at: row.createdAt };
  for (const [kind, re] of patterns) {
    const m = row.body.match(re);
    if (!m) continue;
    const title = m[1];
    switch (kind) {
      case "play":
        return { ...base, kind, before: "put on ", title };
      case "queue":
        return { ...base, kind, before: "lined up ", title, after: " for after this" };
      case "suggest":
        return { ...base, kind, before: "suggested ", title };
      case "in":
        return { ...base, kind, before: mine ? "are in for " : "is in for ", title };
      case "holdoff":
        return { ...base, kind, before: "held off on ", title };
      case "stop":
        return { ...base, kind, before: `stopped autoplay after ${title}` };
      case "back":
        return { ...base, kind, before: mine ? "are back" : "is back" };
      case "keep":
        return { ...base, kind, before: mine ? "want to keep watching" : "wants to keep watching" };
      default:
        return { ...base, kind, before: row.body };
    }
  }
  return { ...base, kind: "other", before: row.body };
}

const picking = new Set<ActivityKind>(["suggest", "in", "holdoff"]);

/**
 * Quiets one run of back-to-back events (nothing was said in between):
 * - picking chatter about a title that the run ends up putting on says nothing the "put on" doesn't
 * - flip-flops collapse to where each person landed ("in", then "held off", then "in" is one "in")
 * - "is in" folds into the suggestion it answers
 * - the same line twice in a row shows once
 */
function quiet(run: Activity[], name: (id: string) => string): Activity[] {
  const played = new Set(run.filter((a) => a.kind === "play").map((a) => a.title));
  const lastStance = new Map<string, string>();
  for (const a of run) if (a.kind === "in" || a.kind === "holdoff") lastStance.set(`${a.profileId}|${a.title}`, a.id);
  const out: Activity[] = [];
  for (const a of run) {
    if (picking.has(a.kind) && played.has(a.title)) continue;
    if ((a.kind === "in" || a.kind === "holdoff") && lastStance.get(`${a.profileId}|${a.title}`) !== a.id) continue;
    if (a.kind === "in") {
      const suggestion = out.find((s) => s.kind === "suggest" && s.title === a.title && s.profileId !== a.profileId);
      if (suggestion) {
        suggestion.alsoIn = [...suggestion.alsoIn, a.mine ? "you’re in" : `${name(a.profileId)} is in`];
        continue;
      }
    }
    const prev = out.at(-1);
    if (prev && prev.kind === a.kind && prev.profileId === a.profileId && prev.before === a.before && prev.title === a.title) continue;
    out.push({ ...a, alsoIn: [...a.alsoIn] });
  }
  return out;
}

/**
 * A "left the party" stops being news once that person does anything again, and the "is back" or
 * "joined" that brought them back goes with it.
 */
function staleLeaves(rows: Row[]) {
  const hidden = new Set<string>();
  rows.forEach((row, i) => {
    if (row.kind !== "event" || row.body !== "left the party") return;
    const next = rows.slice(i + 1).find((r) => r.profileId === row.profileId && r.kind !== "reaction");
    if (!next) return;
    hidden.add(row._id);
    if (next.kind === "event" && (next.body === "is back" || next.body === "joined")) hidden.add(next._id);
  });
  return hidden;
}

export function buildTimeline(rows: Row[], meId: string, name: (id: string) => string): TimelineItem[] {
  const list = rows.filter((r) => r.kind !== "reaction");
  const hidden = staleLeaves(list);
  const items: TimelineItem[] = [];
  let run: Activity[] = [];
  let lastAt: number | null = null;

  const flush = () => {
    const lines = quiet(run, name);
    if (lines.length) items.push({ type: "activity", id: `activity-${lines[0].id}`, lines });
    run = [];
  };

  for (const row of list) {
    if (hidden.has(row._id)) continue;
    if (lastAt === null || row.createdAt - lastAt >= TIME_GAP_MS) {
      flush();
      items.push({ type: "time", id: `time-${row._id}`, at: row.createdAt });
    }
    lastAt = row.createdAt;
    if (row.kind === "event") {
      run.push(parseEvent(row, meId));
      continue;
    }
    flush();
    const prev = items.at(-1);
    const bubble = { id: row._id, body: row.body, at: row.createdAt };
    if (prev?.type === "chat" && prev.profileId === row.profileId && row.createdAt - prev.bubbles.at(-1)!.at < GROUP_GAP_MS)
      prev.bubbles.push(bubble);
    else items.push({ type: "chat", id: row._id, profileId: row.profileId, mine: row.profileId === meId, bubbles: [bubble] });
  }
  flush();
  return items;
}

/** "9:41 PM" today, "Yesterday 9:41 PM", or "Mon 9:41 PM". */
export function timeLabel(at: number, now = Date.now()) {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return time;
  if (day(at) === day(now - 86_400_000)) return `Yesterday ${time}`;
  return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
