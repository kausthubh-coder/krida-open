import { expect, test } from "vitest";
import { markSeen, seenAt } from "../src/features/party/unread";

const AT = Date.UTC(2026, 9, 20, 21, 0);

test("a party's chat seen for the first time counts from now: what came before isn't news", () => {
  expect(seenAt("first", AT)).toBe(AT);
});

test("a party button made anew between episodes still knows what you haven't read", () => {
  seenAt("episodes", AT);
  // The next episode's button mounts 40 minutes later; Ravi's message from minute 10 is still unread.
  expect(seenAt("episodes", AT + 40 * 60_000)).toBe(AT);
  markSeen("episodes", AT + 41 * 60_000);
  expect(seenAt("episodes", AT + 50 * 60_000)).toBe(AT + 41 * 60_000);
});

test("each party keeps its own", () => {
  markSeen("one", AT + 5000);
  expect(seenAt("two", AT + 9000)).toBe(AT + 9000);
  expect(seenAt("one", AT + 9000)).toBe(AT + 5000);
});

test("a clock measured again a little behind doesn't bring read messages back", () => {
  markSeen("drift", AT + 5000);
  markSeen("drift", AT + 4000);
  expect(seenAt("drift", AT + 6000)).toBe(AT + 5000);
});
