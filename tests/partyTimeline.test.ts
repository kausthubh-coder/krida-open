import { describe, expect, test } from "vitest";
import { buildTimeline, parseEvent, timeLabel, type Row } from "../src/features/party/timeline";
import { presenceLine, type Presence } from "../src/features/party/presence";

const ME = "me";
const RAVI = "ravi";
const names: Record<string, string> = { [ME]: "You", [RAVI]: "Ravi" };
const name = (id: string) => names[id] ?? "Someone";

let clock = Date.UTC(2026, 9, 8, 2, 0);
let seq = 0;
const row = (profileId: string, kind: Row["kind"], body: string, gap = 1000): Row => {
  clock += gap;
  return { _id: `m${seq++}`, profileId, kind, body, createdAt: clock };
};
const ev = (who: string, body: string, gap?: number) => row(who, "event", body, gap);
const say = (who: string, body: string, gap?: number) => row(who, "chat", body, gap);

/** Each item as one readable line, so the expectations read like the panel does. */
function render(rows: Row[]) {
  return buildTimeline(rows, ME, name).map((item) => {
    if (item.type === "time") return "--";
    if (item.type === "chat") return `${item.mine ? ">" : "<"} ${item.bubbles.map((b) => b.body).join(" | ")}`;
    return item.lines
      .map((l) => `${name(l.profileId)} ${l.before}${l.title ?? ""}${l.after ?? ""}${l.alsoIn.map((s) => ` · ${s}`).join("")}`)
      .join(" / ");
  });
}

describe("party timeline", () => {
  test("the flooded party from the bug report reads as a conversation", () => {
    const rows = [
      ev(ME, "started the party"),
      ev(RAVI, "joined"),
      say(ME, "yo"),
      ev(ME, "suggested Bethlehem Kudumba Unit"),
      ev(ME, "left the party"),
      ev(RAVI, "is in for Bethlehem Kudumba Unit"),
      ev(ME, "held off on Bethlehem Kudumba Unit"),
      ev(RAVI, "suggested Bethlehem Kudumba Unit"),
      ev(ME, "suggested Drushyam"),
      ev(RAVI, "put on Bethlehem Kudumba Unit"),
      say(ME, "nga"),
      ev(ME, "lined up Ori Devuda..! for after this"),
    ];
    expect(render(rows)).toEqual([
      "--",
      "You started the party / Ravi joined",
      "> yo",
      "You suggested Drushyam / Ravi put on Bethlehem Kudumba Unit",
      "> nga",
      "You lined up Ori Devuda..! for after this",
    ]);
  });

  test("chat from one person groups until someone else talks, something happens, or five quiet minutes", () => {
    const rows = [
      say(RAVI, "ok"),
      say(RAVI, "starting"),
      say(ME, "go"),
      say(ME, "wait", 6 * 60_000),
      ev(RAVI, "put on Dune: Part Two"),
      say(RAVI, "here we go"),
    ];
    expect(render(rows)).toEqual(["--", "< ok | starting", "> go", "> wait", "Ravi put on Dune: Part Two", "< here we go"]);
  });

  test("a time label marks the start and every long pause", () => {
    const rows = [say(ME, "hi"), say(RAVI, "back in 20"), say(RAVI, "ok back", 20 * 60_000)];
    expect(render(rows)).toEqual(["--", "> hi", "< back in 20", "--", "< ok back"]);
  });

  test("an 'is in' joins the suggestion it answers, and flip-flops show only where someone landed", () => {
    const rows = [
      ev(RAVI, "suggested Past Lives"),
      ev(ME, "is in for Past Lives"),
      ev(RAVI, "suggested Drishyam"),
      ev(ME, "is in for Drishyam"),
      ev(ME, "held off on Drishyam"),
    ];
    expect(render(rows)).toEqual(["--", "Ravi suggested Past Lives · you’re in / Ravi suggested Drishyam / You held off on Drishyam"]);
  });

  test("leaving stops being news once that person is back, with the line that brought them back", () => {
    const rows = [ev(RAVI, "left the party"), ev(RAVI, "is back"), say(RAVI, "wifi"), ev(ME, "left the party")];
    expect(render(rows)).toEqual(["--", "< wifi", "You left the party"]);
  });

  test("reactions float over the picture and stay out of the conversation", () => {
    expect(render([row(RAVI, "reaction", "😂"), say(RAVI, "lol")])).toEqual(["--", "< lol"]);
  });

  test("events read naturally for you and for others", () => {
    const line = (who: string, body: string) => {
      const a = parseEvent({ _id: "x", kind: "event", profileId: who, body, createdAt: 0 }, ME);
      return `${name(who)} ${a.before}${a.title ?? ""}${a.after ?? ""}`;
    };
    expect(line(ME, "is in for Dune")).toBe("You are in for Dune");
    expect(line(RAVI, "is in for Dune")).toBe("Ravi is in for Dune");
    expect(line(ME, "is back")).toBe("You are back");
    expect(line(ME, "wants to keep watching")).toBe("You want to keep watching");
    expect(line(RAVI, "added The Bear · S1 E2 to Up next")).toBe("Ravi lined up The Bear · S1 E2 for after this");
    expect(line(RAVI, "did something new")).toBe("Ravi did something new");
  });

  test("the header says who's here and what they're doing in one line", () => {
    const p = (name: string, status: Presence["status"], isMe = false): Presence => ({ id: name, name, isMe, status });
    expect(presenceLine([p("You", "here", true)])).toBe("Just you so far");
    expect(presenceLine([p("Ravi", "watching"), p("You", "watching", true)])).toBe("You and Ravi are watching");
    expect(presenceLine([p("You", "browsing", true), p("Ravi", "away")])).toBe("You’re browsing · Ravi is away");
    expect(presenceLine([p("You", "here", true), p("Ravi", "here"), p("Ana", "here")])).toBe("You, Ravi and Ana are here");
  });

  test("time labels say the day once it isn't today", () => {
    const now = new Date(2026, 9, 8, 22, 0).getTime();
    expect(timeLabel(new Date(2026, 9, 8, 21, 5).getTime(), now)).not.toMatch(/Yesterday|Mon|Tue|Wed/);
    expect(timeLabel(new Date(2026, 9, 7, 21, 5).getTime(), now)).toMatch(/^Yesterday /);
  });
});
