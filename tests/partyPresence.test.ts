import { describe, expect, test } from "vitest";
import { arrivals, names } from "../src/features/party/presence";

const AT = Date.UTC(2026, 9, 20, 21, 0);
const member = (_id: string, name: string, lastSeenAt = AT, isMe = false) => ({ _id, name, lastSeenAt, isMe });
const ids = (list: { _id: string }[]) => new Set(list.map((m) => m._id));

describe("who joined", () => {
  const me = member("me", "Maya", AT, true);
  const ravi = member("ravi", "Ravi");

  test("the first member list is who was already here", () => {
    expect(arrivals(null, [me, ravi])).toEqual([]);
  });

  test("a heartbeat that lapsed and came back isn't an arrival: Ravi locked his phone for a minute", () => {
    const before = [me, ravi];
    const after = [me, member("ravi", "Ravi", AT + 60_000)];
    expect(arrivals(ids(before), after)).toEqual([]);
  });

  test("someone new in the member list has arrived", () => {
    expect(arrivals(ids([me, ravi]), [me, ravi, member("ana", "Ana")])).toEqual(["Ana"]);
  });

  test("someone who left and joined again arrives again", () => {
    expect(arrivals(ids([me]), [me, ravi])).toEqual(["Ravi"]);
  });

  test("you never arrive in your own party", () => {
    expect(arrivals(ids([ravi]), [ravi, me])).toEqual([]);
  });
});

describe("a list of names in a sentence", () => {
  test("one other", () => {
    expect(names(["Ravi"])).toBe("Ravi");
  });
  test("two others", () => {
    expect(names(["Ravi", "Ana"])).toBe("Ravi and Ana");
  });
  test("three others get commas, not a chain of ands", () => {
    expect(names(["Ravi", "Ana", "Guest"])).toBe("Ravi, Ana and Guest");
  });
  test("nobody is an empty string, for the caller to word", () => {
    expect(names([])).toBe("");
  });
});
