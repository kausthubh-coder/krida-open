import { expect, test } from "vitest";
import { NeedsKeyError, peekShared, prefetchShared } from "../src/data/api";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const HOUR = 60 * 60_000;

test("an answer refused for a missing key is asked again at once, so Home has its rows when onboarding ends", async () => {
  // Home's rows are warmed as the profile is made, before onboarding has saved the TMDB key.
  prefetchShared("rows-needs-key", () => Promise.reject(new NeedsKeyError("Add your TMDB key", "tmdb")), HOUR);
  await settle();
  expect(peekShared("rows-needs-key")).toBe(null);
  prefetchShared("rows-needs-key", () => Promise.resolve(["Trending movies this week"]), HOUR);
  await settle();
  expect(peekShared("rows-needs-key")).toEqual(["Trending movies this week"]);
});

test("any other failure waits a minute before asking again", async () => {
  prefetchShared("rows-down", () => Promise.reject(new Error("502")), HOUR);
  await settle();
  prefetchShared("rows-down", () => Promise.resolve(["Trending movies this week"]), HOUR);
  await settle();
  expect(peekShared("rows-down")).toBe(null);
});
