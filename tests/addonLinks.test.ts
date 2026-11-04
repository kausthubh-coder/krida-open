import { expect, test } from "vitest";
import { stremioPage } from "../shared/stremio";
import { playerApps } from "../src/features/play/playerLinks";

test("Stremio addon links open a prefilled review, and detail links open titles", () => {
  expect(stremioPage("stremio://torrentio.strem.fun/realdebrid=key/manifest.json")).toBe("/settings/addons?addon=https%3A%2F%2Ftorrentio.strem.fun%2Frealdebrid%3Dkey%2Fmanifest.json");
  expect(stremioPage("stremio:///detail/movie/tt1254207")).toBe("/title/movie/tt1254207");
  expect(stremioPage("stremio:///detail/series/kitsu%3A123")).toBe("/title/series/kitsu%3A123");
  expect(["https://evil.example", "stremio://evil.example/configure", "stremio://user:pass@evil.example/manifest.json", "stremio:///detail/movie", "invalid"].map(stremioPage)).toEqual([null, null, null, null, null]);
});

test("additional external players get exact links including query strings and encoded paths", () => {
  const url = "https://cdn.example/Film%20one.mkv?key=a%2Fb&file=2";
  expect(playerApps(url, "android").slice(1, 4)).toEqual([
    { name: "MX Player", href: "intent://cdn.example/Film%20one.mkv?key=a%2Fb&file=2#Intent;scheme=https;type=video/*;package=com.mxtech.videoplayer.ad;end" },
    { name: "MX Player Pro", href: "intent://cdn.example/Film%20one.mkv?key=a%2Fb&file=2#Intent;scheme=https;type=video/*;package=com.mxtech.videoplayer.pro;end" },
    { name: "Just Player", href: "intent://cdn.example/Film%20one.mkv?key=a%2Fb&file=2#Intent;scheme=https;type=video/*;package=com.brouken.player;end" },
  ]);
  expect(playerApps(url, "ios").slice(2)).toEqual([
    { name: "Outplayer", href: "outplayer://https://cdn.example/Film%20one.mkv?key=a%2Fb&file=2" },
    { name: "SenPlayer", href: "senplayer://x-callback-url/play?url=https%3A%2F%2Fcdn.example%2FFilm%2520one.mkv%3Fkey%3Da%252Fb%26file%3D2" },
  ]);
});

test("Android player intents keep an embedded URL in a signed file link", () => {
  expect(playerApps("https://cdn.example/film.mkv?redirect=https://origin.example/file", "android")[3]).toEqual({
    name: "Just Player",
    href: "intent://cdn.example/film.mkv?redirect=https://origin.example/file#Intent;scheme=https;type=video/*;package=com.brouken.player;end",
  });
});
