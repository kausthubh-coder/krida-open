// Trailer on the title page: the button, YouTube actually playing (not refusing the embed), Escape and the close
// button returning focus, and the phone layout. Needs the QA app (npm run qa -- up) or a *-QA-* profile on dev.
// Usage: node scripts/e2e-trailer.mjs [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/trailer"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const DUNE = "/title/movie/tt15239678";
const br = await launchBrowser();
const { check, finish, watch } = checks();

async function open(width, height) {
  const page = await (await br.newContext({ viewport: { width, height } })).newPage();
  watch(page, `${width}px`);
  await signIn(page, base, profile);
  await page.goto(base + DUNE);
  await page.getByRole("button", { name: "Trailer", exact: true }).waitFor({ timeout: 30000 });
  return page;
}

/** Seconds YouTube's <video> has played, read from inside the embed. */
async function played(page) {
  const frame = page.frames().find((f) => f.url().includes("youtube-nocookie.com/embed/"));
  if (!frame) return { time: -1, error: "no embed" };
  return frame.evaluate(() => ({
    time: document.querySelector("video")?.currentTime ?? -1,
    error: document.querySelector(".ytp-error")?.textContent?.trim() ?? null,
  }));
}

// Desktop
{
  const page = await open(1280, 800);
  await page.screenshot({ path: `${outDir}/desktop-title.png` });
  const trailer = page.getByRole("button", { name: "Trailer", exact: true });
  await trailer.click();
  const dialog = page.getByRole("dialog", { name: "Dune: Part Two trailer" });
  await dialog.waitFor();
  const frame = dialog.locator("iframe");
  await frame.waitFor({ state: "attached" });
  check("embed sends a referrer", (await frame.getAttribute("referrerpolicy")) === "strict-origin-when-cross-origin");
  check("embed is youtube-nocookie with an id", /^https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{11}\?/.test((await frame.getAttribute("src")) ?? ""));
  let state = { time: -1, error: null };
  for (let i = 0; i < 20 && state.time <= 1; i++) {
    await page.waitForTimeout(1000);
    state = await played(page).catch(() => state);
    // Headless Chrome can block sound; start it the way a person would.
    if (i === 6 && state.time <= 0) await frame.click();
  }
  check("trailer plays", state.time > 1 && !state.error, JSON.stringify(state));
  check("no error shown", (await dialog.getByText("This trailer won’t play here").count()) === 0);
  await page.screenshot({ path: `${outDir}/desktop-trailer.png` });
  await dialog.getByRole("button", { name: "Close trailer" }).focus();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check("Escape closes and focus returns to Trailer", await trailer.evaluate((el) => el === document.activeElement));
  await trailer.click();
  await dialog.getByRole("button", { name: "Close trailer" }).click();
  await dialog.waitFor({ state: "detached" });
  check("Close button closes and focus returns", await trailer.evaluate((el) => el === document.activeElement));
  await page.close();
}

// Phone
{
  const page = await open(390, 844);
  const play = page.getByRole("button", { name: /^(Play|Resume)/ }).first();
  const trailer = page.getByRole("button", { name: "Trailer", exact: true });
  const [p, t] = [await play.boundingBox(), await trailer.boundingBox()];
  check("phone: Play and Trailer share the first row", !!p && !!t && Math.abs(p.y - t.y) < 2 && p.x < t.x);
  check("phone: row fits the screen", !!t && t.x + t.width <= 390 - 16 + 1);
  await trailer.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${outDir}/phone-title.png` });
  await trailer.click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${outDir}/phone-trailer.png` });
  await page.close();
}

await br.close();
finish();
