import { expect, test } from "vitest";
import { echoOf, pendingAfterSend } from "../src/features/player/playbackSync";

test("one action: the room's next state is ours coming back", () => {
  const pending = pendingAfterSend(0, 5);
  expect(pending).toBe(6);
  expect(echoOf(6, pending)).toBe("ours");
});

test("two quick skips: the first one coming back is passed, not followed, and the second is ours", () => {
  // Skip to 0:17, then to 0:27 before the room has answered the first.
  const pending = pendingAfterSend(pendingAfterSend(0, 5), 5);
  expect(pending).toBe(7);
  // Following the first would seek back to 0:17, and the second's return would seek to 0:27 again.
  expect(echoOf(6, pending)).toBe("passed");
  expect(echoOf(7, pending)).toBe("ours");
});

test("with nothing of ours on its way, a room state is someone else's", () => {
  expect(echoOf(6, 0)).toBe("theirs");
});

test("someone else's action landing in the place we expected ours is passed: ours, right behind it, wins", () => {
  // We skip (room at 5, so ours should come back as 6); their pause lands first, as 6.
  const pending = pendingAfterSend(0, 5);
  expect(echoOf(6, pending, false)).toBe("passed");
  expect(echoOf(7, pending, true)).toBe("ours");
});

test("someone else's action landing after ours is theirs to follow", () => {
  const pending = pendingAfterSend(0, 5);
  expect(echoOf(7, pending, false)).toBe("theirs");
});
