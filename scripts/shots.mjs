// Screenshots for design review: the sign-in screen, QA sign-in's wrong-password error, Home, search, a movie with its sources
// and Watch together sheets, a show and its episodes, the Library and Settings. Needs a *-QA-* profile on the dev
// backend (sources come from its addons there).
// Usage: KRIDA_QA_PASSWORD=… node scripts/shots.mjs [base] [profile] [outDir] [width] [height]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles } from "./lib/qa.ts";

const [baseArg, name, outDir = ".artifacts/shots", width = "1280", height = "800"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(outDir, { recursive: true });
const browser = await launchBrowser();
const page = await (await browser.newContext({ viewport: { width: +width, height: +height }, deviceScaleFactor: 1 })).newPage();
const { finish } = checks(page);
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
const shot = async (label) => { await page.waitForTimeout(900); await page.screenshot({ path: `${outDir}/${width}-${label}.png` }); console.log("shot", label); };
// Signs in by hand at /qa, not with signIn(): the signed-out screen and a wrong password on the way are shots.
await page.goto(base); await page.waitForSelector("text=Sign in to pick a profile"); await shot("gate");
await page.goto(base + "/qa"); await page.getByRole("textbox", { name: "QA profile" }).fill(profile.name);
await page.getByRole("textbox", { name: "Password" }).fill("nope"); await page.keyboard.press("Enter"); await page.waitForSelector("text=Wrong password"); await shot("gate-error");
await page.getByRole("textbox", { name: "Password" }).fill(profile.password); await page.keyboard.press("Enter");
await page.waitForSelector("text=What are we watching tonight", { timeout: 15000 }).catch(() => {}); await shot("home");
await page.goto(base + "/search?q=dune"); await page.waitForSelector("text=Dune: Part Two"); await shot("search");
await page.goto(base + "/title/movie/tt15239678"); await page.waitForSelector("text=Watch together"); await shot("title-movie");
await page.getByRole("button", { name: "Choose a source" }).click(); await page.waitForSelector("text=Choose a source");
await page.waitForSelector("text=Asking your addons", { state: "detached", timeout: 30000 }); await shot("sources");
await page.keyboard.press("Escape"); await page.waitForTimeout(300);
await page.getByRole("button", { name: "Watch together" }).click(); await shot("together");
await page.keyboard.press("Escape");
await page.goto(base + "/title/series/tt0903747"); await page.waitForSelector("text=Episodes"); await shot("title-series");
await page.mouse.wheel(0, 700); await shot("title-series-episodes");
await page.goto(base + "/library"); await page.waitForTimeout(500); await shot("library");
await page.goto(base + "/settings"); await page.waitForTimeout(500); await shot("settings");
console.log("console errors:", JSON.stringify(consoleErrors.slice(0, 10), null, 1));
await browser.close();
finish();
