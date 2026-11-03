import { afterEach, describe, expect, test, vi } from "vitest";
import { imdbTrailers } from "../shared/imdb";

const link = (name: string, expires: number) => `https://imdb-video.media-imdb.com/${name}.mp4?Expires=${expires}&Signature=x`;
const expires = Math.floor(Date.now() / 1000) + 86_400;

afterEach(() => vi.unstubAllGlobals());

describe("IMDb trailers", () => {
  test("picks the trailer among a title's videos, MP4s smallest first, with when its links expire", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      expect(query).toContain('t0: title(id: "tt15239678")');
      expect(query).toContain('t1: title(id: "tt0000001")');
      expect(query).not.toContain("bad");
      return Response.json({
        data: {
          t0: {
            primaryVideos: {
              edges: [
                { node: { contentType: { id: "amzn1.imdb.video.contenttype.clip" }, playbackURLs: [{ url: link("clip", expires), videoDefinition: "DEF_720p", mimeType: "video/mp4" }] } },
                {
                  node: {
                    contentType: { id: "amzn1.imdb.video.contenttype.trailer" },
                    playbackURLs: [
                      { url: link("1080", expires), videoDefinition: "DEF_1080p", mimeType: "video/mp4" },
                      { url: link("auto", expires), videoDefinition: "DEF_AUTO", mimeType: "application/x-mpegurl" },
                      { url: link("480", expires - 60), videoDefinition: "DEF_480p", mimeType: "video/mp4" },
                    ],
                  },
                },
              ],
            },
          },
          // A title without a trailer.
          t1: { primaryVideos: { edges: [] } },
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const found = await imdbTrailers(["tt15239678", "tt0000001", 'bad") { x }']);
    expect(found).toEqual([
      { id: "tt15239678", files: [{ height: 480, url: link("480", expires - 60) }, { height: 1080, url: link("1080", expires) }], expires: (expires - 60) * 1000 },
      { id: "tt0000001", files: [], expires: expect.any(Number) },
    ]);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ "x-imdb-client-name": "imdb-web-next" });
  });

  test("leaves out titles IMDb didn't answer for, and fails when IMDb does", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: {} })));
    expect(await imdbTrailers(["tt15239678"])).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));
    await expect(imdbTrailers(["tt15239678"])).rejects.toThrow("403");
  });
});
