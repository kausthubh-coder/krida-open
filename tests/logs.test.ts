/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha256 } from "../convex/lib/auth";
import { scrub } from "../shared/logs";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/**/*.js", "!../convex/**/*.d.ts"]);
const token = "logs-session";
const report = { kind: "meta", message: "Answered 503: https://v3-cinemeta.strem.io/meta/movie/tt38915678.json", page: "/title/movie/tt38915678", platform: "web", build: "0f6571b" };

async function fixture() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("profiles", { name: "Logs test", hue: 1, passwordHash: "x", salt: "x", order: 0, failedAttempts: 0, prefs: { audioLang: "en", sounds: false } });
    await ctx.db.insert("sessions", { profileId: id, tokenHash: await sha256(token), createdAt: 0 });
  });
  return t;
}

describe("client logs", () => {
  test("a report is kept with the profile's name, and read back newest first", async () => {
    const t = await fixture();
    await t.mutation(api.logs.report, { token, ...report, detail: '{"status":503,"ms":812}' });
    await t.mutation(api.logs.report, { ...report, kind: "error", message: "Signed out" });
    const rows = await t.query(internal.logs.recent, {});
    expect(rows.map(({ at: _, ...row }) => row)).toEqual([
      { kind: "error", message: "Signed out", page: report.page, platform: "web", build: "0f6571b", detail: undefined, profile: undefined },
      { ...report, detail: '{"status":503,"ms":812}', profile: "Logs test" },
    ]);
    expect(await t.query(internal.logs.recent, { kind: "meta" })).toHaveLength(1);
  });

  test("tokens and keys in a report are never stored", async () => {
    const t = await fixture();
    await t.mutation(api.logs.report, {
      ...report,
      message: "https://krida.convex.site/hls/playlist.m3u8?s=abc&a=0&t=secret-token",
      detail: '{"x-krida-session":"secret-token","url":"/api/frame?size=1&ticket=abc123"}',
    });
    const [row] = await t.query(internal.logs.recent, {});
    expect(row.message).toBe("https://krida.convex.site/hls/playlist.m3u8?s=abc&a=0&t=<redacted>");
    expect(row.detail).toBe('{"x-krida-session":"<redacted>","url":"/api/frame?size=1&ticket=<redacted>"}');
  });

  test("past 60 reports a minute the rest are dropped", async () => {
    const t = await fixture();
    for (let i = 0; i < 65; i++) await t.mutation(api.logs.report, { ...report, message: `n${i}` });
    expect(await t.query(internal.logs.recent, { limit: 1000 })).toHaveLength(60);
  });

  test("rows go after 14 days", async () => {
    vi.useFakeTimers();
    try {
      const t = await fixture();
      vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
      await t.mutation(api.logs.report, { ...report, message: "old" });
      vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
      await t.mutation(api.logs.report, { ...report, message: "new" });
      vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
      await t.mutation(internal.logs.prune, {});
      expect((await t.query(internal.logs.recent, {})).map((r) => r.message)).toEqual(["new"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("scrub cuts to length after redacting", () => {
    expect(scrub("a?key=123456789&b=2", 12)).toBe("a?key=<redac");
  });

  test("scrub takes secrets out of what a session replay sends: JSON fields, OAuth codes, join links, headers", () => {
    expect(scrub('{"ticket":"abc.def","expires":5,"url":"https://w.dev"}')).toBe('{"ticket":"<redacted>","expires":5,"url":"https://w.dev"}');
    expect(scrub("/connect/simkl?code=9f8e7d&state=xyz")).toBe("/connect/simkl?code=<redacted>&state=<redacted>");
    expect(scrub("https://krida-open.vercel.app/join#code=ABCD-1234")).toBe("https://krida-open.vercel.app/join#code=<redacted>");
    expect(scrub('{"x-krida-session":"s3cr3t-tok","authorization":"Bearer abc.def-ghi"}')).toBe(
      '{"x-krida-session":"<redacted>","authorization":"Bearer <redacted>"}',
    );
    expect(scrub("https://x.convex.site/hls/1/index.m3u8?t=tok123&i=2")).toBe("https://x.convex.site/hls/1/index.m3u8?t=<redacted>&i=2");
  });
});
