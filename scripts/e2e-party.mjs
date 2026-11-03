// A watch party in two browsers (Chrome and Edge): start from a title, accept the invite, stay in sync through pause,
// seek and play, chat, and subtitles. Needs two *-QA-* profiles on the dev backend (real TorBox streams).
// Usage: KRIDA_QA_PASSWORD=… node scripts/e2e-party.mjs [base] [profileA] [profileB] [outDir] [titlePath]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, nameA, nameB, outDir = ".artifacts/party", titlePath = "/title/movie/tt15239678"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [pa, pb] = qaProfiles([nameA, nameB]);
// Beyond this the player itself seeks to catch up (src/features/player/playbackSync.ts), so the two are out of sync.
const DRIFT_S = 2.5;
await mkdir(outDir, { recursive: true });
const A = await launchBrowser();
const B = await launchBrowser({}, "msedge");
const mk = async (br, label) => {
  const page = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on("console", (m) => m.type() === "error" && !/favicon/.test(m.text()) && console.log(label, "console:", m.text().slice(0, 200)));
  return page;
};
const a = await mk(A, "A"), b = await mk(B, "B");
const { check, finish, watch } = checks();
watch(a, "A");
watch(b, "B");
await signIn(a, base, pa); await signIn(b, base, pb);
const t0 = Date.now(); const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const state = (page) => page.evaluate(() => { const v = document.querySelector("video"); if (!v) return null; const q = v.getVideoPlaybackQuality(); return { t: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState, w: v.videoWidth, h: v.videoHeight, frames: q.totalVideoFrames, audio: v.webkitAudioDecodedByteCount ?? null }; });
const drift = (sa, sb) => Math.abs(sa.t - sb.t);

await a.goto(base + titlePath); await a.getByRole("button", { name: "Watch together" }).click();
await a.getByRole("button", { name: /Start and invite/ }).click();
await a.waitForURL(/\/watch\//); console.log(secs(), "A in room", a.url().split("/watch/")[1]);
await a.waitForTimeout(800); await a.screenshot({ path: `${outDir}/party-preparing.png` });

await b.getByText(`${pa.name} invited you`).waitFor({ timeout: 20000 }); console.log(secs(), "B got invite toast");
await b.screenshot({ path: `${outDir}/party-invite-toast.png` });
await b.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Join", exact: true }).click(); await b.waitForURL(/\/watch\//); console.log(secs(), "B joined room");

for (const [label, page] of [["A", a], ["B", b]]) {
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 3; }, null, { timeout: 120000 });
  console.log(secs(), label, "video ready", JSON.stringify(await state(page)));
}
// If a browser blocked autoplay, the app shows a button for it.
for (const [label, page] of [["A", a], ["B", b]]) {
  const btn = page.getByRole("button", { name: /Join playback|Start watching/ });
  if (await btn.isVisible().catch(() => false)) { console.log(label, "autoplay was blocked, pressing", await btn.textContent()); await btn.click(); }
}
await a.waitForTimeout(6000);
let sa = await state(a), sb = await state(b);
check("both play", !sa.paused && !sb.paused, JSON.stringify({ A: sa, B: sb }));
check("in sync while playing", drift(sa, sb) < DRIFT_S, `drift ${drift(sa, sb).toFixed(2)} s`);
await a.screenshot({ path: `${outDir}/party-A-playing.png` }); await b.screenshot({ path: `${outDir}/party-B-playing.png` });

// A pauses with the keyboard
await a.mouse.move(640, 360); await a.keyboard.press("Space"); await a.waitForTimeout(2500);
sa = await state(a); sb = await state(b);
check("A's pause pauses both", sa.paused && sb.paused, JSON.stringify({ A: [sa.paused, sa.t], B: [sb.paused, sb.t] }));

// B seeks by clicking the seekbar at 40%
await b.mouse.move(640, 360); await b.waitForTimeout(200);
const bar = await b.getByRole("slider", { name: "Seek" }).boundingBox();
await b.mouse.click(bar.x + bar.width * 0.4, bar.y + bar.height / 2); await b.waitForTimeout(3000);
sa = await state(a); sb = await state(b);
check("B's seek moves both", drift(sa, sb) < DRIFT_S, JSON.stringify({ A: [sa.paused, sa.t], B: [sb.paused, sb.t] }));

// B resumes
await b.keyboard.press("Space"); await b.waitForTimeout(8000);
sa = await state(a); sb = await state(b);
check("B's play resumes both", !sa.paused && !sb.paused, JSON.stringify({ A: sa, B: sb }));
check("in sync after resuming", drift(sa, sb) < DRIFT_S, `drift ${drift(sa, sb).toFixed(2)} s`);

// Chat from B, seen by A
await b.mouse.move(620, 340); await b.mouse.move(640, 360); await b.waitForTimeout(150);
await b.getByRole("button", { name: "Chat" }).click();
await b.getByRole("textbox", { name: "Message" }).fill("this is so good"); await b.keyboard.press("Enter");
await a.mouse.move(620, 340); await a.mouse.move(600, 300); await a.waitForTimeout(150); await a.getByRole("button", { name: "Chat" }).click();
await a.getByText("this is so good").waitFor({ timeout: 10000 }); console.log(secs(), "A sees B's chat message");
await b.getByRole("button", { name: "React with Vine boom" }).click();
await a.waitForTimeout(600); await a.screenshot({ path: `${outDir}/party-A-chat.png` });
await a.keyboard.press("Escape"); await b.keyboard.press("Escape");

// Subtitles on A
await a.mouse.move(620, 340); await a.mouse.move(640, 360); await a.waitForTimeout(150); await a.getByRole("button", { name: "Subtitles (C)" }).click();
await a.getByRole("dialog", { name: "Subtitles" }).getByRole("button", { name: /^English/ }).first().click();
const cue = await a.waitForSelector(".subtitle-cue", { timeout: 90000 }).then(() => a.textContent(".subtitle-cue"), () => null);
check("a subtitle shows on A within 90 s", cue !== null, cue?.slice(0, 60) ?? "no cue");
await a.mouse.move(640, 300); await a.waitForTimeout(300); await a.screenshot({ path: `${outDir}/party-A-subs.png` });
sa = await state(a); sb = await state(b);
check("still in sync at the end", drift(sa, sb) < DRIFT_S, `drift ${drift(sa, sb).toFixed(2)} s, ${JSON.stringify({ A: sa, B: sb })}`);
await A.close(); await B.close();
finish();
