import { describe, expect, test } from "vitest";
import { trailerIds, youtubeId } from "../src/features/trailers/trailers";

describe("youtubeId", () => {
  test("reads the id from every YouTube link shape", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=U2Qp5pL3ovA")).toBe("U2Qp5pL3ovA");
    expect(youtubeId("https://youtube.com/watch?v=_YUzQa_1RCE&t=4")).toBe("_YUzQa_1RCE");
    expect(youtubeId("https://m.youtube.com/watch?v=Way9Dexny3w")).toBe("Way9Dexny3w");
    expect(youtubeId("https://youtu.be/U2Qp5pL3ovA")).toBe("U2Qp5pL3ovA");
    expect(youtubeId("https://www.youtube-nocookie.com/embed/U2Qp5pL3ovA")).toBe("U2Qp5pL3ovA");
    expect(youtubeId("https://www.youtube.com/shorts/U2Qp5pL3ovA")).toBe("U2Qp5pL3ovA");
  });

  test("rejects other sites and malformed ids", () => {
    expect(youtubeId("https://vimeo.com/123456789")).toBeNull();
    expect(youtubeId("https://evil.example/watch?v=U2Qp5pL3ovA")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(youtubeId("https://www.youtube.com/watch?v=U2Qp5pL3ovA%22onload")).toBeNull();
    expect(youtubeId("not a url")).toBeNull();
  });
});

describe("trailerIds", () => {
  test("puts trailers before teasers, keeps Cinemeta's order and drops duplicates", () => {
    const ids = trailerIds(
      {
        trailers: [
          { source: "TeaserAAAAA", type: "Teaser" },
          { source: "U2Qp5pL3ovA", type: "Trailer" },
          { source: "_YUzQa_1RCE", type: "Trailer" },
        ],
        trailerStreams: [{ title: "Dune: Part Two", ytId: "U2Qp5pL3ovA" }],
      },
      "https://www.youtube.com/watch?v=Way9Dexny3w",
    );
    expect(ids).toEqual(["U2Qp5pL3ovA", "_YUzQa_1RCE", "TeaserAAAAA", "Way9Dexny3w"]);
  });

  test("falls back to MDBList and ignores anything that isn't a YouTube id", () => {
    expect(trailerIds({ trailers: [{ source: "<script>", type: "Trailer" }] }, "https://youtu.be/Way9Dexny3w")).toEqual([
      "Way9Dexny3w",
    ]);
    expect(trailerIds({}, null)).toEqual([]);
    expect(trailerIds({}, "https://vimeo.com/1")).toEqual([]);
  });
});
