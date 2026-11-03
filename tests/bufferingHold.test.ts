import { describe, expect, test } from "vitest";
import type { Member } from "../src/features/party";
import type { Playback } from "../src/features/player/playbackSync";
import { bufferingHold, holdStep, playerMarks, ranInto, stageOf } from "../src/features/player/together";

const member = (id: string, fields: Partial<Member> = {}) =>
  ({ _id: id, name: id, isMe: false, watching: true, buffering: false, ...fields }) as Member;

test("watching alone, a stall still holds the room's clock, but nobody is said to be waiting", () => {
  const { holdFor, iLead, together } = bufferingHold([member("me", { isMe: true })], "me", true);
  // Holding stops the clock where the picture stalled, so it doesn't jump ahead once it loads.
  expect(holdFor.map((x) => x._id)).toEqual(["me"]);
  expect(iLead).toBe(true);
  expect(together).toBe(false);
});

test("a friend who is only browsing doesn't make it a watch together", () => {
  const online = [member("me", { isMe: true }), member("ravi", { watching: false, buffering: true })];
  const { holdFor, together } = bufferingHold(online, "me", true);
  expect(holdFor.map((x) => x._id)).toEqual(["me"]);
  expect(together).toBe(false);
});

test("in a party, my stall holds the room and the other viewer leads", () => {
  const me = member("a-me", { isMe: true });
  const ravi = member("b-ravi");
  const { holdFor, iLead, together } = bufferingHold([me, ravi], "a-me", true);
  expect(holdFor.map((x) => x._id)).toEqual(["a-me"]);
  expect(iLead).toBe(false);
  expect(together).toBe(true);
});

test("in a party, their stall holds the room and I lead", () => {
  const me = member("a-me", { isMe: true });
  const ravi = member("b-ravi", { buffering: true });
  const { holdFor, iLead } = bufferingHold([me, ravi], "a-me", false);
  expect(holdFor.map((x) => x._id)).toEqual(["b-ravi"]);
  expect(iLead).toBe(true);
});

const playback = (fields: Partial<Playback>): Playback => ({ playing: true, position: 600, anchorAt: 1_000_000, seq: 5, ...fields });

test("someone stalls: the leader holds the room after 2.5 seconds", () => {
  expect(holdStep(playback({ action: "play" }), 1, 1_000_000, true)).toEqual({ send: "wait", delay: 2500 });
});

test("everyone has caught up: the leader starts the room again 0.6 seconds later", () => {
  expect(holdStep(playback({ action: "wait", playing: false }), 0, 1_005_000, true)).toEqual({ send: "resume", delay: 600 });
});

test("someone is still loading 5 seconds into a hold: the party moves on at 20 seconds", () => {
  expect(holdStep(playback({ action: "wait", playing: false }), 1, 1_005_000, true)).toEqual({ send: "move on", delay: 15_000 });
});

test("after moving on, the same bad connection doesn't hold the party again for 30 seconds", () => {
  // 1 second after moving on, they stall again.
  expect(holdStep(playback({ action: "move on" }), 1, 1_001_000, true)).toEqual({ send: "wait", delay: 29_000 });
});

test("alone, the hold lasts as long as the stall: moving on would jump past what hasn't loaded", () => {
  expect(holdStep(playback({ action: "wait", playing: false }), 1, 1_060_000, false)).toBe(null);
  expect(holdStep(playback({ action: "wait", playing: false }), 0, 1_060_000, false)).toEqual({ send: "resume", delay: 600 });
});

test("nothing to do while playing with no one stalled, or paused by someone", () => {
  expect(holdStep(playback({ action: "play" }), 0, 1_000_000, true)).toBe(null);
  expect(holdStep(playback({ action: "pause", playing: false }), 1, 1_000_000, true)).toBe(null);
});

const intro = { start: 2, end: 12 };

test("playback running into the intro skips it", () => {
  expect(ranInto(intro, 1.5, 2.5, false)).toBe(true);
});

test("opening a title that starts inside its intro skips it", () => {
  expect(ranInto(intro, null, 2.5, true)).toBe(true);
});

test("a reload or a join in the middle of the intro doesn't skip it for everyone", () => {
  expect(ranInto(intro, null, 6, false)).toBe(false);
});

test("playing on inside the intro, once it's started, doesn't skip it", () => {
  expect(ranInto(intro, 5.5, 6, false)).toBe(false);
});

describe("the player's time, held between marks", () => {
  const intro = { start: 2, end: 12 };
  const outro = { start: 1380, end: 1440 };
  const duration = 1450;
  const marks = playerMarks([intro, undefined, outro], duration);
  /** Every check the player makes of its time: the skip buttons, the next episode's warm-up, Up next. */
  const checks = (t: number) => [
    t >= intro.start && t < intro.end - 1,
    t >= outro.start && t < outro.end - 1,
    t < 60,
    t >= outro.start,
    duration - t < 40,
  ];

  test("are the marks: each part's start and last second, a minute in, and 40 seconds before the end", () => {
    expect(marks).toEqual([2, 11, 1380, 1439, 60, 1410.001]);
  });

  test("answer every check as the true time does, through a whole film played at 4 updates a second", () => {
    let held = 0;
    let changes = 0;
    const wrong: number[] = [];
    for (let i = 0; i <= duration * 4; i++) {
      const t = i / 4;
      if (stageOf(marks, held) !== stageOf(marks, t)) {
        held = t;
        changes++;
      }
      if (JSON.stringify(checks(held)) !== JSON.stringify(checks(t))) wrong.push(t);
    }
    // Six redraws in 24 minutes, where half-second steps made 2,900.
    expect([wrong, changes]).toEqual([[], 6]);
  });
});
