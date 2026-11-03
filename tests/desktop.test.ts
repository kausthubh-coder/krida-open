/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { desktopAtLeast, desktopName, type DesktopApp } from "../src/data/desktop";
import type { FrameLight } from "../src/features/player/bars";
import { MpvVideo, mpvDebands, mpvFits, mpvLiftsSubtitles, mpvTrims, mpvWarms, type MpvMessage } from "../src/features/player/desktop";
import type { Fit } from "../src/features/player/touch";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the desktop app's file link", () => {
  async function fixture() {
    vi.stubEnv("TORBOX_API_URL", "https://torbox.test/v1/api");
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      asked.push(String(url));
      return Response.json({ success: true, data: "https://cdn.test/dld/7/3?token=key" });
    }));
    const t = convexTest(schema, modules);
    const token = "desktop-token";
    const guest = "guest-token";
    const streamId = await t.run(async (ctx) => {
      const profile = async (name: string, accountId: Id<"accounts">, session: string) => {
        const profileId = await ctx.db.insert("profiles", {
          name, hue: 145, passwordHash: "unused", salt: "unused", order: 0, failedAttempts: 0, prefs: { audioLang: "eng", sounds: false }, accountId,
        });
        await ctx.db.insert("sessions", { profileId, tokenHash: await sha256(session), createdAt: Date.now() });
      };
      const accountId = await ctx.db.insert("accounts", { name: "Desktop", createdAt: Date.now() });
      await ctx.db.insert("accountKeys", { accountId, debrid: { service: "torbox", key: "key" }, updatedAt: Date.now() });
      await profile("Desktop test", accountId, token);
      // In someone else's party: a profile of another account, with a TorBox key of its own.
      const otherId = await ctx.db.insert("accounts", { name: "Other", createdAt: Date.now() });
      await ctx.db.insert("accountKeys", { accountId: otherId, debrid: { service: "torbox", key: "other-key" }, updatedAt: Date.now() });
      await profile("Guest", otherId, guest);
      return await ctx.db.insert("streams", {
        torrentId: 7, fileId: 3, presignedToken: "p", domain: "https://cdn.test", audios: [], createdAt: Date.now(), accountId,
      });
    });
    return { t, token, guest, streamId, asked };
  }

  test("is TorBox's download link for the stream's file", async () => {
    const { t, token, streamId, asked } = await fixture();
    expect(await t.action(api.desktop.fileLink, { token, streamId })).toBe("https://cdn.test/dld/7/3?token=key");
    expect(asked).toEqual([
      "https://torbox.test/v1/api/torrents/requestdl?token=key&torrent_id=7&file_id=3&zip_link=false&redirect=false",
    ]);
  });

  test("needs a signed-in profile", async () => {
    const { t, streamId, asked } = await fixture();
    await expect(t.action(api.desktop.fileLink, { token: "wrong", streamId })).rejects.toThrow("Sign in to continue");
    expect(asked).toEqual([]);
  });

  test("carries the key of the stream's account, so another account's profile doesn't get it", async () => {
    const { t, guest, streamId, asked } = await fixture();
    expect(await t.action(api.desktop.fileLink, { token: guest, streamId })).toBe(null);
    expect(asked).toEqual([]);
  });

  test("is null for a stream that's gone", async () => {
    const { t, token, streamId } = await fixture();
    await t.run(async (ctx) => await ctx.db.delete(streamId));
    expect(await t.action(api.desktop.fileLink, { token, streamId })).toBe(null);
  });
});

describe("mpv as a <video>", () => {
  /**
   * An MpvVideo on a fake app and a fake clock: `calls` is what it asked mpv, `say` is mpv talking back, and `light`
   * is how lit mpv says each frame it's asked about is.
   */
  function player(light: () => FrameLight | Promise<FrameLight> = () => Promise.reject(new Error("no picture"))) {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    let handler: (event: { payload: MpvMessage }) => void = () => {};
    const app: DesktopApp = {
      core: {
        invoke: async <T>(command: string, args?: Record<string, unknown>) => {
          calls.push([command, args]);
          return (command === "mpv_frame_light" ? await light() : undefined) as T;
        },
      },
      event: {
        listen: async <T>(_event: string, h: (event: { payload: T }) => void) => {
          handler = h as unknown as typeof handler;
          return () => {};
        },
      },
    };
    let now = 0;
    const video = new MpvVideo(app, () => now);
    const events: string[] = [];
    for (const type of ["play", "pause", "playing", "waiting", "seeking", "seeked", "canplay", "loadedmetadata", "ended", "volumechange", "error"])
      video.addEventListener(type, () => events.push(type));
    return {
      video,
      calls,
      events,
      say: (m: MpvMessage) => handler({ payload: m }),
      wait: (ms: number) => (now += ms),
      attach: async () => {
        video.attach();
        await Promise.resolve();
      },
    };
  }

  /** Loaded at `start` and showing its first picture, paused. */
  async function loaded(start = 0) {
    const p = player();
    await p.attach();
    await p.video.load("https://cdn.test/film.mkv", { start, aid: 2, title: "Film" });
    p.say({ event: "file-loaded", time: null });
    p.say({ name: "duration", value: 3600, time: null });
    p.say({ event: "playback-restart", time: start });
    p.calls.length = 0;
    p.events.length = 0;
    return p;
  }

  test("loads the file paused, from where the room is, on the chosen audio track", async () => {
    const p = player();
    await p.video.load("https://cdn.test/film.mkv", { start: 61.5, aid: 2, title: "Film" });
    expect(p.calls).toEqual([["mpv_load", { url: "https://cdn.test/film.mkv", start: 61.5, paused: true, aid: 2, title: "Film" }]]);
    expect(p.video.currentTime).toBe(61.5);
    expect(p.video.readyState).toBe(0);
  });

  test("is ready to play once the first picture is up", async () => {
    const p = await loaded(10);
    expect(p.video.readyState).toBe(4);
    expect(p.video.duration).toBe(3600);
    expect(p.video.paused).toBe(true);
  });

  test("plays at once, as the element does, and counts time on between mpv's reports", async () => {
    const p = await loaded(10);
    await p.video.play();
    expect(p.video.paused).toBe(false);
    expect(p.events).toEqual(["play", "playing"]);
    expect(p.calls).toEqual([["mpv_set", { name: "pause", value: false }]]);
    p.wait(500);
    expect(p.video.currentTime).toBe(10.5);
    p.say({ name: "time-pos", value: 10.6, time: 10.6 });
    p.wait(250);
    expect(p.video.currentTime).toBe(10.85);
  });

  test("stops counting when paused, and counts at the playback rate", async () => {
    const p = await loaded(0);
    await p.video.play();
    p.video.playbackRate = 1.05;
    expect(p.calls.at(-1)).toEqual(["mpv_set", { name: "speed", value: 1.05 }]);
    p.wait(1000);
    expect(p.video.currentTime).toBeCloseTo(1.05, 6);
    p.video.pause();
    p.wait(5000);
    expect(p.video.currentTime).toBeCloseTo(1.05, 6);
    expect(p.events).toEqual(["play", "playing", "pause"]);
  });

  test("a seek goes to mpv, and its old position is ignored until the seek lands", async () => {
    const p = await loaded(0);
    await p.video.play();
    p.video.currentTime = 600;
    expect(p.calls.at(-1)).toEqual(["mpv_seek", { time: 600 }]);
    expect(p.video.seeking).toBe(true);
    p.say({ name: "time-pos", value: 0.4, time: 0.4 });
    p.wait(1000);
    expect(p.video.currentTime).toBe(600);
    p.say({ event: "playback-restart", time: 600.02 });
    expect(p.video.seeking).toBe(false);
    p.wait(1000);
    expect(p.video.currentTime).toBeCloseTo(601.02, 6);
    expect(p.events).toEqual(["play", "playing", "seeking", "seeked", "canplay", "playing"]);
  });

  test("buffering holds the time and says so, then carries on", async () => {
    const p = await loaded(0);
    await p.video.play();
    p.wait(2000);
    p.say({ name: "paused-for-cache", value: true, time: 2 });
    expect(p.video.readyState).toBe(2);
    p.wait(3000);
    expect(p.video.currentTime).toBe(2);
    p.say({ name: "paused-for-cache", value: false, time: 2 });
    p.wait(1000);
    expect(p.video.currentTime).toBe(3);
    expect(p.events).toEqual(["play", "playing", "waiting", "canplay", "playing"]);
  });

  test("someone pausing mpv's own way reaches the player", async () => {
    const p = await loaded(0);
    await p.video.play();
    p.say({ name: "pause", value: true, time: 4 });
    expect(p.video.paused).toBe(true);
    expect(p.video.currentTime).toBe(4);
    expect(p.events).toEqual(["play", "playing", "pause"]);
  });

  test("the end of the file pauses and ends", async () => {
    const p = await loaded(3590);
    await p.video.play();
    p.say({ name: "eof-reached", value: true, time: 3600 });
    expect([p.video.ended, p.video.paused]).toEqual([true, true]);
    expect(p.events).toEqual(["play", "playing", "pause", "ended"]);
  });

  test("volume and mute go to mpv in its units", async () => {
    const p = await loaded(0);
    p.video.volume = 0.5;
    p.video.muted = true;
    expect(p.calls).toEqual([
      ["mpv_set", { name: "volume", value: 50 }],
      ["mpv_set", { name: "mute", value: true }],
    ]);
    expect(p.events).toEqual(["volumechange", "volumechange"]);
    // mpv confirming what was set changes nothing.
    p.say({ name: "volume", value: 50, time: 0 });
    expect(p.events).toEqual(["volumechange", "volumechange"]);
  });

  test("a file that fails, or mpv closing, is an error", async () => {
    const p = await loaded(0);
    p.say({ event: "end-file", reason: "stop", time: 0 });
    p.say({ event: "end-file", reason: "error", time: 0 });
    p.say({ event: "exit" });
    expect(p.events).toEqual(["error", "error"]);
  });

  test("an audio switch changes the track in place", async () => {
    const p = await loaded(0);
    p.video.setAudio(3);
    expect(p.calls).toEqual([["mpv_set", { name: "aid", value: 3 }]]);
  });

  test("the file's own subtitles show by track and timing, and turn off with no track", async () => {
    const p = await loaded(0);
    p.video.setSubtitles(2, -1.5);
    p.video.setSubtitles(null, 0);
    expect(p.calls).toEqual([
      ["mpv_set", { name: "sid", value: 2 }],
      ["mpv_set", { name: "sub-delay", value: -1.5 }],
      ["mpv_set", { name: "sid", value: "no" }],
      ["mpv_set", { name: "sub-delay", value: 0 }],
    ]);
  });

  test("each way of fitting the picture sets mpv's zoom, shape and scaling", async () => {
    const p = await loaded(0);
    const asked = (fit: Fit) => {
      p.calls.length = 0;
      p.video.setFit(fit);
      return p.calls.map(([, args]) => [args!.name, args!.value]);
    };
    expect(asked("crop")).toEqual([["panscan", 1], ["keepaspect", true], ["video-unscaled", "no"]]);
    expect(asked("stretch")).toEqual([["panscan", 0], ["keepaspect", false], ["video-unscaled", "no"]]);
    expect(asked("original")).toEqual([["panscan", 0], ["keepaspect", true], ["video-unscaled", "yes"]]);
    expect(asked("fit")).toEqual([["panscan", 0], ["keepaspect", true], ["video-unscaled", "no"]]);
  });

  test("a file loaded into an mpv started afresh gets the chosen fit again", async () => {
    const p = await loaded(0);
    p.video.setFit("crop");
    p.calls.length = 0;
    await p.video.load("https://cdn.test/film.mkv", { start: 30, aid: 2, title: "Film" });
    expect(p.calls).toEqual([
      ["mpv_load", { url: "https://cdn.test/film.mkv", start: 30, paused: true, aid: 2, title: "Film" }],
      ["mpv_set", { name: "panscan", value: 1 }],
      ["mpv_set", { name: "keepaspect", value: true }],
      ["mpv_set", { name: "video-unscaled", value: "no" }],
    ]);
  });

  test("the file's own subtitles rise with the controls, by the page's lift in mpv's 720-line units, and stay up on a new file", async () => {
    const p = await loaded(0);
    vi.stubGlobal("window", { innerHeight: 720 });
    p.video.liftSubtitles(144);
    vi.stubGlobal("window", { innerHeight: 1440 });
    p.video.liftSubtitles(144);
    p.video.liftSubtitles(0);
    expect(p.calls.slice(-3)).toEqual([
      ["mpv_set", { name: "sub-margin-y", value: 166 }],
      ["mpv_set", { name: "sub-margin-y", value: 94 }],
      ["mpv_set", { name: "sub-margin-y", value: 22 }],
    ]);
    p.video.liftSubtitles(144);
    p.calls.length = 0;
    await p.video.load("https://cdn.test/film.mkv", { start: 0, aid: 1, title: "Film" });
    expect(p.calls).toEqual([
      ["mpv_load", { url: "https://cdn.test/film.mkv", start: 0, paused: true, aid: 1, title: "Film" }],
      ["mpv_set", { name: "sub-margin-y", value: 94 }],
    ]);
  });

  test("banding is evened out unless switched off, and a file loaded after that keeps it off", async () => {
    const p = await loaded(0);
    p.video.setDeband(false);
    expect(p.calls.at(-1)).toEqual(["mpv_set", { name: "deband", value: false }]);
    p.calls.length = 0;
    await p.video.load("https://cdn.test/film.mkv", { start: 0, aid: 1, title: "Film" });
    expect(p.calls).toEqual([
      ["mpv_load", { url: "https://cdn.test/film.mkv", start: 0, paused: true, aid: 1, title: "Film" }],
      ["mpv_set", { name: "deband", value: false }],
    ]);
  });

  describe("black bars built into the film", () => {
    /** How mpv reads a frame of a 2.39:1 film in a 1080p frame, 69 of its 540 rows black above and below. */
    const widescreen = (lit: number): FrameLight => ({
      width: 960,
      height: 540,
      rows: Array.from({ length: 540 }, (_, i) => (i >= 69 && i < 471 ? lit : 0)),
      cols: Array.from({ length: 960 }, () => (lit * 402) / 540),
    });

    /** The 1920x1080 film `film` playing from `start` with trimming on. */
    async function trimming(light: () => FrameLight | Promise<FrameLight>, { start = 0, film = "stream-1" } = {}) {
      const p = player(light);
      await p.attach();
      p.video.setTrim(true);
      await p.video.load("https://cdn.test/film.mkv", { start, aid: 2, title: "Film", film });
      p.say({ event: "file-loaded", time: null });
      p.say({ name: "width", value: 1920, time: null });
      p.say({ name: "height", value: 1080, time: null });
      p.say({ event: "playback-restart", time: start });
      await p.video.play();
      return p;
    }
    /** mpv reporting each quarter second of the film from `from` to before `to`, and the reads they ask for. */
    async function plays(p: ReturnType<typeof player>, from: number, to: number) {
      for (let t = from; t < to; t += 0.25) {
        p.say({ name: "time-pos", value: t, time: t });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    const reads = (p: ReturnType<typeof player>) => p.calls.filter(([command]) => command === "mpv_frame_light");
    const crops = (p: ReturnType<typeof player>) =>
      p.calls.filter(([, args]) => args?.name === "file-local-options/video-crop").map(([, args]) => args!.value);

    test("reads the picture every 2 seconds of film while it plays, and trims once the bars have held for 20 seconds of it", async () => {
      const p = await trimming(() => widescreen(0.8));
      expect(p.video.bars).toBe("looking");
      await plays(p, 0, 6);
      expect(reads(p)).toEqual([
        ["mpv_frame_light", { level: 24 }],
        ["mpv_frame_light", { level: 24 }],
        ["mpv_frame_light", { level: 24 }],
      ]);
      expect(crops(p)).toEqual([]);
      await plays(p, 6, 20);
      expect([reads(p).length, crops(p)]).toEqual([10, []]);
      await plays(p, 20, 22);
      expect([reads(p).length, crops(p), p.video.bars]).toEqual([11, ["1920x804+0+138"], "trimmed"]);
    });

    test("doesn't read the picture while paused", async () => {
      const p = await trimming(() => widescreen(0.8));
      p.video.pause();
      p.say({ name: "pause", value: true, time: 0 });
      await plays(p, 0, 10);
      expect(reads(p)).toEqual([]);
    });

    test("a dark opening isn't trimmed, and the bright film after it is once four of its frames agree", async () => {
      let lit = 0.05;
      const p = await trimming(() => widescreen(lit));
      await plays(p, 0, 20);
      expect([crops(p), p.video.bars]).toEqual([[], "looking"]);
      lit = 0.8;
      await plays(p, 20, 26);
      expect([crops(p), p.video.bars]).toEqual([[], "looking"]);
      await plays(p, 26, 28);
      expect([crops(p), p.video.bars]).toEqual([["1920x804+0+138"], "trimmed"]);
    });

    test("a film with no bars is left whole after one look", async () => {
      const whole: FrameLight = { width: 960, height: 540, rows: Array(540).fill(0.8), cols: Array(960).fill(0.8) };
      const p = await trimming(() => whole);
      await plays(p, 0, 10);
      expect([reads(p).length, crops(p), p.video.bars]).toEqual([1, [], "none"]);
    });

    test("after five reads fail in a row it stops asking and leaves the film whole, unsure", async () => {
      const p = await trimming(() => Promise.reject(new Error("mpv's pipe didn't answer")));
      await plays(p, 0, 20);
      expect([reads(p).length, crops(p), p.video.bars]).toEqual([5, [], "unsure"]);
    });

    test("reads that fail and then succeed go on to trim", async () => {
      let fails = 4;
      const p = await trimming(() => (fails-- > 0 ? Promise.reject(new Error("no picture yet")) : widescreen(0.8)));
      await plays(p, 0, 30);
      expect([reads(p).length, crops(p)]).toEqual([15, ["1920x804+0+138"]]);
    });

    test("switched off, the picture gets its bars back; on again, it's trimmed without reading it again", async () => {
      const p = await trimming(() => widescreen(0.8));
      await plays(p, 0, 22);
      const changes: string[] = [];
      p.video.addEventListener("barschange", () => changes.push(p.video.bars));
      p.video.setTrim(false);
      p.video.setTrim(true);
      await plays(p, 22, 26);
      expect(crops(p)).toEqual(["1920x804+0+138", "", "1920x804+0+138"]);
      expect(reads(p)).toHaveLength(11);
      expect(changes).toEqual(["off", "trimmed"]);
    });

    test("switched off, it never reads the picture", async () => {
      const p = await trimming(() => widescreen(0.8));
      p.video.setTrim(false);
      await plays(p, 0, 10);
      expect([reads(p), crops(p)]).toEqual([[], []]);
    });

    test("the same film loaded again is trimmed as it loads; another film starts over", async () => {
      const p = await trimming(() => widescreen(0.8));
      await plays(p, 0, 22);
      p.calls.length = 0;
      await p.video.load("https://cdn.test/fresh-link.mkv", { start: 22, aid: 2, title: "Film", film: "stream-1" });
      // mpv may report the new file's size before it says the file is loaded: a crop then would go to the old file.
      p.say({ name: "width", value: 1920, time: null });
      p.say({ name: "height", value: 1080, time: null });
      expect(crops(p)).toEqual([]);
      p.say({ event: "file-loaded", time: null });
      expect([crops(p), reads(p)]).toEqual([["1920x804+0+138"], []]);
      p.calls.length = 0;
      await p.video.load("https://cdn.test/other.mkv", { start: 0, aid: 2, title: "Other", film: "stream-2" });
      p.say({ event: "file-loaded", time: null });
      expect([crops(p), p.video.bars]).toEqual([[], "looking"]);
    });

    test("a frame read before another film loads says nothing about it", async () => {
      let late: (frame: FrameLight) => void = () => {};
      let lit = 0;
      const p = await trimming(() => (lit ? widescreen(lit) : new Promise<FrameLight>((r) => (late = r))));
      await plays(p, 0, 0.5);
      await p.video.load("https://cdn.test/other.mkv", { start: 0, aid: 2, title: "Other", film: "stream-2" });
      p.say({ event: "file-loaded", time: null });
      p.say({ event: "playback-restart", time: 0 });
      await p.video.play();
      late(widescreen(0.8));
      lit = 0.8;
      // Had the late frame counted, the tenth of this film's would trim.
      await plays(p, 0, 20);
      expect(crops(p)).toEqual([]);
      await plays(p, 20, 22);
      expect(crops(p)).toEqual(["1920x804+0+138"]);
    });
  });
});

describe("the app's version", () => {
  const at = (version: string | null) => vi.stubGlobal("window", version ? { kridaDesktop: { version } } : {});

  test("gives the Picture menu to 0.1.1 and later, whose mpv takes the fit", () => {
    const fits = (version: string | null) => {
      at(version);
      return mpvFits();
    };
    expect([fits("0.1.0"), fits("0.1.1"), fits("0.1.10"), fits("0.2.0"), fits("1.0.0"), fits(null)]).toEqual([false, true, true, true, true, false]);
  });

  test("trims black bars from 0.1.2, whose mpv reads the picture and takes the crop", () => {
    const trims = (version: string | null) => {
      at(version);
      return mpvTrims();
    };
    expect([trims("0.1.1"), trims("0.1.2"), trims("0.2.0"), trims(null)]).toEqual([false, true, true, false]);
  });

  test("debands from 0.1.3, whose mpv takes the switch", () => {
    const debands = (version: string | null) => {
      at(version);
      return mpvDebands();
    };
    expect([debands("0.1.2"), debands("0.1.3"), debands("0.2.0"), debands(null)]).toEqual([false, true, true, false]);
  });

  test("is Krida for Mac on a Mac, and Krida for Windows otherwise, older apps that don't say included", () => {
    const named = (platform?: string) => {
      vi.stubGlobal("window", { kridaDesktop: { version: "0.1.3", platform } });
      return desktopName();
    };
    expect([named("macos"), named("windows"), named(undefined)]).toEqual(["Krida for Mac", "Krida for Windows", "Krida for Windows"]);
  });

  test("starts mpv as the player opens from 0.1.5, the first app with the call for it", () => {
    const warms = (version: string | null) => {
      at(version);
      return mpvWarms();
    };
    expect([warms("0.1.4"), warms("0.1.5"), warms("0.2.0"), warms(null)]).toEqual([false, true, true, false]);
  });

  test("lifts the file's own subtitles from 0.1.6, which lets the page set their margin", () => {
    const lifts = (version: string | null) => {
      at(version);
      return mpvLiftsSubtitles();
    };
    expect([lifts("0.1.5"), lifts("0.1.6"), lifts("0.2.0"), lifts(null)]).toEqual([false, true, true, false]);
  });

  test("compares part by part, so 0.10 is after 0.9", () => {
    at("0.10.0");
    expect([desktopAtLeast("0.9.9"), desktopAtLeast("0.10.0"), desktopAtLeast("0.10.1")]).toEqual([true, true, false]);
  });
});
