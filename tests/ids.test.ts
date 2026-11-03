import { expect, test } from "vitest";
import { isImdbId, isKitsuId, isTitleId } from "../shared/ids";

test("an IMDb id is tt and up to 10 digits", () => {
  expect(["tt0903747", "tt1", "tt1234567890", "tt12345678901", "tt", "TT0903747", "tt0903747 "].map(isImdbId))
    .toEqual([true, true, true, false, false, false, false]);
});

test("a Kitsu id is kitsu: and up to 8 digits", () => {
  expect(["kitsu:1376", "kitsu:12345678", "kitsu:123456789", "kitsu:", "mal:1376"].map(isKitsuId))
    .toEqual([true, true, false, false, false]);
});

test("a title id is either one, and nothing else", () => {
  expect(["tt0903747", "kitsu:1376", "tmdb:1396", "not-an-id", ""].map(isTitleId)).toEqual([true, true, false, false, false]);
});
