import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

/**
 * Stand-ins for a stream addon (and the AIOStreams older commits ask), TorBox and IntroDB, so a walk can press Play on a
 * local backend without real keys.
 * Answers are fixed: three sources for any title, a one-minute test video as HLS (and as the MKV file behind it, for
 * the timeline's preview), an intro from 0:02 to 0:12 and credits from 0:50. Profiles reach the addon by having it
 * installed (seed.ts); the backend reaches the rest through TORBOX_API_URL and INTRODB_API_URL (and AIOSTREAMS_URL, for
 * older commits); /api/frame does through the same TORBOX_ variables.
 */
export type Providers = { url: string; env: Record<string, string>; stop: () => Promise<void> };

/**
 * A one-minute test picture with a tone, cut into HLS segments, and the same as an MKV file, made once in `dir`.
 * Beside them, letterbox.mkv: a minute and a half of a 2.39:1 film stored in a 1080p frame with black bars built in,
 * as many 4K files are, for the app's trimming of them (scripts/e2e-desktop.ts). It opens with a logo on black; from
 * 0:12 a shot lit only across its middle, between dark sky and ground, in a film's shape (2.76:1); then a fade in from
 * 0:26. It's bright from 0:30, apart from a dark scene from 1:10 to 1:16.
 */
export function testVideo(dir: string) {
  mkdirSync(dir, { recursive: true });
  const make = (out: string, args: string[]) => {
    if (existsSync(join(dir, out))) return;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, join(dir, out)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg couldn't make the test video (is it installed?): ${r.stderr ?? r.error}`);
  };
  const test = [
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=60",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "48",
    "-c:a", "aac", "-b:a", "64k",
  ];
  make("playlist.m3u8", [...test, "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod", "-hls_segment_filename", join(dir, "seg%02d.ts")]);
  make("test.mkv", [...test, "-f", "matroska"]);
  make("letterbox.mkv", [
    "-f", "lavfi", "-i", "testsrc2=size=1920x804:rate=24:duration=90",
    "-f", "lavfi", "-i", "testsrc2=size=1920x696:rate=24:duration=90",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=90",
    "-filter_complex", [
      "[0:v]drawbox=color=black@0.85:t=fill:enable='between(t,70,76)',fade=t=in:st=26:d=4[film]",
      "[1:v]eq=brightness=-0.15[middle]",
      "[film][middle]overlay=0:54:enable='between(t,12,26)'[scene]",
      "[scene]drawbox=x=840:y=362:w=240:h=80:color=gray:t=fill:enable='lt(t,12)'[opening]",
      "[opening]pad=1920:1080:0:138:black[v]",
    ].join(";"),
    "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-g", "48",
    "-c:a", "aac", "-b:a", "64k", "-f", "matroska",
  ]);
}

const SOURCES = [
  { name: "[TB+] AIOStreams 1080p", description: "Test.Movie.2026.1080p.WEB-DL.x264-KRIDA\n💾 1.2 GB 👤 120 🌐 English", size: 1_200_000_000 },
  { name: "[TB+] AIOStreams 720p", description: "Test.Movie.2026.720p.WEB-DL.x264-KRIDA\n💾 700 MB 👤 80 🌐 English", size: 700_000_000 },
  { name: "[TB+] AIOStreams 2160p", description: "Test.Movie.2026.2160p.WEB-DL.HDR.x265-KRIDA\n💾 8 GB 👤 40 🌐 English", size: 8_000_000_000 },
];

/** The stand-in as a Stremio stream addon, at `{base}/addon`: what the seeded QA profiles have installed. */
const ADDON_MANIFEST = {
  id: "krida.regress.streams", name: "Stand-in streams", version: "1.0.0", description: "Three test copies of any title.",
  types: ["movie", "series"], resources: ["stream"], idPrefixes: ["tt", "kitsu"], catalogs: [],
};
export const standInAddon = (base: string) => `${base}/addon`;

/**
 * A stand-in for an addon set up with another debrid service (Torrentio or Comet with Real-Debrid): each link redirects
 * to the file itself, as the service's download link. Two copies of any film or episode: a 1080p MKV (test.mkv, here)
 * and a 480p MP4, Night of the Living Dead (1968, public domain) from the Internet Archive. Nothing installs it: scripts
 * that play another service's files (scripts/e2e-direct.ts) add it, at `{base}/direct`.
 */
export const standInDirectAddon = (base: string) => `${base}/direct`;
const DIRECT_MANIFEST = {
  id: "krida.regress.direct", name: "Stand-in debrid", version: "1.0.0", description: "Direct links, as a debrid service gives them.",
  types: ["movie", "series"], resources: ["stream"], idPrefixes: ["tt"], catalogs: [],
};
/**
 * A stand-in subtitle addon at `{base}/subs`, with Spanish subtitles only for any film: a line every two seconds of the
 * one-minute test video. Nothing installs it; scripts that check how subtitles are picked and drawn add it
 * (scripts/e2e-playback-settings.ts).
 */
export const standInSubtitles = (base: string) => `${base}/subs`;
const SUBS_MANIFEST = {
  id: "krida.regress.subs", name: "Stand-in subtitles", version: "1.0.0", description: "Spanish subtitles for any film.",
  types: ["movie"], resources: ["subtitles"], idPrefixes: ["tt"], catalogs: [],
};
const srtTime = (s: number) => `00:00:${String(s).padStart(2, "0")},000`;
const SPANISH = Array.from({ length: 29 }, (_, i) => `${i + 1}\n${srtTime(i * 2 + 1)} --> ${srtTime(i * 2 + 2)}\n¿Dónde está el barco? Línea ${i + 1}.\n`).join("\n");

export const PUBLIC_DOMAIN_MP4 = "https://archive.org/download/night_of_the_living_dead_dvd/Night.mp4";
const DIRECT_SOURCES = [
  { name: "[RD+] Torrentio\n1080p", description: "Test.Movie.2026.1080p.WEB-DL.DTS.x264-KRIDA.mkv\n💾 1.2 GB ⚙️ Stand-in", file: "Test.Movie.2026.1080p.WEB-DL.DTS.x264-KRIDA.mkv", size: 1_200_000_000, to: "mkv" },
  { name: "[RD+] Torrentio\n480p", description: "Night.of.the.Living.Dead.1968.480p.WEB.AAC.x264-KRIDA.mp4\n💾 596 MB ⚙️ Stand-in", file: "Night.of.the.Living.Dead.1968.480p.WEB.AAC.x264-KRIDA.mp4", size: 596_399_542, to: "mp4" },
];

/**
 * A fault an e2e script asks for by writing its name here (scripts/e2e-play-errors.ts), read on every list request:
 * "rate-limit" (a 429 from the addon; AIOStreams' way is an HTTP 200 whose only stream is the problem), "down" (a 502), or
 * "broken-links" (sources whose links answer 404). No file, no fault.
 */
export const FAULT_FILE = join(import.meta.dirname, "../../.qa/aio-fault");
const fault = () => (existsSync(FAULT_FILE) ? readFileSync(FAULT_FILE, "utf8").trim() : "");
const problem = (title: string, description: string) => ({
  name: title, description, externalUrl: "https://github.com/Viren070/AIOStreams",
  streamData: { type: "error", error: { title, description } },
});

/** What a backend needs to use the stand-ins at `base`. */
export const providerEnv = (base: string) => ({
  AIOSTREAMS_URL: base, AIOSTREAMS_UUID: "test", AIOSTREAMS_PASSWORD: "test",
  TORBOX_API_KEY: "test", TORBOX_API_URL: `${base}/v1/api`, INTRODB_API_URL: base,
});

export async function startProviders(mediaDir: string): Promise<Providers> {
  testVideo(mediaDir);
  let base = "";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname;
    if (path === "/api/v1/user") return json({ data: { encryptedPassword: "test" } });
    if (path === "/addon/manifest.json") return json(ADDON_MANIFEST);
    if (path === "/direct/manifest.json") return json(DIRECT_MANIFEST);
    if (path === "/subs/manifest.json") return json(SUBS_MANIFEST);
    if (/^\/subs\/subtitles\/movie\/[^/]+(\/[^/]+)?\.json$/.test(path))
      return json({ subtitles: [{ id: "standin-spa", url: `${base}/subs/spa.srt`, lang: "spa" }] });
    if (path === "/subs/spa.srt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
      return res.end(SPANISH);
    }
    if (/^\/direct\/stream\/(movie|series)\/.+\.json$/.test(path))
      return json({ streams: DIRECT_SOURCES.map((s) => ({ name: s.name, description: s.description, url: `${base}/resolve/${s.to}`, behaviorHints: { filename: s.file, videoSize: s.size, bingeGroup: `standin|${s.to}` } })) });
    // What the debrid service does with the addon's link: a redirect to the file.
    if (path === "/resolve/mkv") {
      res.writeHead(302, { location: `${base}/file/test.mkv` });
      return res.end();
    }
    if (path === "/resolve/mp4") {
      res.writeHead(302, { location: PUBLIC_DOMAIN_MP4 });
      return res.end();
    }
    // The stand-in stream addon (QA profiles have it installed), and the AIOStreams a commit from before addons asks.
    const addon = /^\/addon\/stream\/(movie|series)\/.+\.json$/.test(path);
    if (addon || /^\/stremio\/[^/]+\/[^/]+\/stream\/(movie|series)\/.+\.json$/.test(path)) {
      const now = fault();
      if (now === "rate-limit" && addon) {
        res.writeHead(429, { "content-type": "application/json" });
        return res.end("{}");
      }
      if (now === "rate-limit") return json({ streams: [problem("[❌] AIOStreams", "Rate Limit Exceeded")] });
      if (now === "down") {
        res.writeHead(502);
        return res.end("Bad gateway");
      }
      const link = now === "broken-links" ? "gone" : "play";
      return json({ streams: SOURCES.map((s, i) => ({ ...s, url: `${base}/${link}/${i + 1}`, behaviorHints: { filename: `${s.description.split("\n")[0]}.mkv`, videoSize: s.size } })) });
    }
    const play = /^\/play\/(\d+)$/.exec(path);
    if (play) {
      // What a real source does: redirect until the URL names a TorBox torrent and file.
      res.writeHead(302, { location: `https://api.torbox.app/v1/api/torrents/requestdl?torrent_id=${play[1]}&file_id=1` });
      return res.end();
    }
    if (path === "/v1/api/stream/createstream")
      return json({ success: true, data: {
        presigned_token: `test-${url.searchParams.get("id")}`, domain: base, size: 1_200_000_000,
        metadata: { video: { duration: "00:01:00", width: 640, height: 360, codec: "h264" }, audios: [{ language: "eng", title: "English", codec: "aac", channels: 2 }], subtitles: [{ language: "eng", title: "English", codec: "subrip" }, { language: "eng", title: "SDH", codec: "subrip" }, { language: "spa", title: "Forced", codec: "subrip" }] },
      } });
    // The account's torrents hold one file, the size every stand-in stream reports. Its link reads test.mkv, apart
    // from the 2160p source's (torrent 3, which the app picks), whose film has black bars built in.
    if (path === "/v1/api/torrents/mylist") return json({ success: true, data: [{ id: 1, files: [{ id: 1, size: 1_200_000_000 }] }] });
    if (path === "/v1/api/torrents/requestdl")
      return json({ success: true, data: `${base}/dld/${url.searchParams.get("torrent_id")}?token=${url.searchParams.get("token")}` });
    const dld = /^\/dld\/(\d+)$/.exec(path);
    const direct = path === "/file/test.mkv";
    if ((dld && url.searchParams.get("token") === "test") || direct) {
      const mkv = readFileSync(join(mediaDir, dld?.[1] === "3" ? "letterbox.mkv" : "test.mkv"));
      const type = direct ? "video/x-matroska" : "application/octet-stream";
      const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "") ?? [];
      if (from === undefined) {
        res.writeHead(200, { "content-type": type, "access-control-allow-origin": "*" });
        return res.end(mkv);
      }
      const start = Number(from);
      const end = Math.min(to ? Number(to) : mkv.length - 1, mkv.length - 1);
      if (start >= mkv.length) {
        res.writeHead(416, { "content-range": `bytes */${mkv.length}` });
        return res.end();
      }
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${mkv.length}`, "access-control-allow-origin": "*" });
      return res.end(mkv.subarray(start, end + 1));
    }
    if (path.startsWith("/v1/api/")) return json({ success: true, data: [] });
    if (path === "/segments") return json({ intro: { start_sec: 2, end_sec: 12 }, recap: null, outro: { start_sec: 50, end_sec: 58 } });
    const file = /^\/stream\/[^/]+\/null\/null\/\d+\/(playlist\.m3u8|seg\d+\.ts)$/.exec(path)?.[1];
    if (file && existsSync(join(mediaDir, file))) {
      res.writeHead(200, { "content-type": file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t", "access-control-allow-origin": "*" });
      return res.end(readFileSync(join(mediaDir, file)));
    }
    res.writeHead(404, { "access-control-allow-origin": "*" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: base,
    env: providerEnv(base),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
