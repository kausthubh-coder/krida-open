// What Play says when the stream addon or the sources fail, through the stand-in providers' faults
// (scripts/regress/providers.ts): a rate limit (once kept as "No sources found"), sources whose links are all broken,
// and the source sheet using the list from earlier while the addon is down.
// Runs on the QA app (`npm run qa -- up`). Usage: node scripts/e2e-play-errors.ts [outDir]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { launchBrowser } from "./lib/browser.ts";
import { checks, qaSession, signIn } from "./lib/qa.ts";
import { FAULT_FILE } from "./regress/providers.ts";

const out = process.argv[2] ?? ".artifacts/play-errors";
mkdirSync(out, { recursive: true });
const { movies } = JSON.parse(readFileSync(new URL("./regress/titles.json", import.meta.url), "utf8")) as Record<string, { id: string; name: string }[]>;
const s = qaSession();
const setFault = (name: string) => (name ? writeFileSync(FAULT_FILE, name) : rmSync(FAULT_FILE, { force: true }));

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const { check, finish } = checks(page);
try {
  await signIn(page, s.url, s.profiles[0]);

  /** Plays a movie with the stand-in addon in `fault`, and returns what the loading screen ends on. */
  const playFailing = async (fault: string, movie: { id: string; name: string }, shot: string) => {
    setFault(fault);
    await page.goto(`${s.url}/title/movie/${movie.id}`);
    await page.getByRole("heading", { name: movie.name, level: 1 }).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    // The error screen's first button is Refresh sources, or Play in a lower quality; this one is always there.
    await page.getByRole("button", { name: "Choose another source" }).waitFor({ timeout: 60_000 });
    await page.screenshot({ path: `${out}/${shot}.png` });
    return (await page.locator("main, body").first().innerText()).replace(/\s+/g, " ");
  };

  const busy = await playFailing("rate-limit", movies[5]!, "rate-limit");
  check("a rate limit says the addon is busy", busy.includes("This stream couldn’t start") && busy.includes("Stand-in streams is busy right now. Try again in a minute."), busy.slice(0, 200));
  check("and doesn't call it a title with no sources", !busy.includes("No sources found"));

  const broken = await playFailing("broken-links", movies[6]!, "broken-links");
  // Only copies at the picked quality are tried; a lower one waits for a person to choose it.
  check("broken links say what Krida tried, and offer a lower quality", broken.includes("That copy had a broken link.") && broken.includes("Play in 720p"), broken.slice(0, 200));

  // The sheet: sources found while the addon answered, then Refresh while it's down.
  setFault("");
  const movie = movies[7]!;
  await page.goto(`${s.url}/title/movie/${movie.id}`);
  await page.getByRole("heading", { name: movie.name, level: 1 }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Choose a source", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Choose a source" });
  await sheet.getByRole("button", { name: "Refresh" }).waitFor({ timeout: 60_000 });
  setFault("down");
  await sheet.getByRole("button", { name: "Refresh" }).click();
  // The list again (Refresh), or the sheet's error (Try again).
  await sheet.getByRole("button", { name: /^(Refresh|Try again)$/ }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/older-list.png` });
  const listed = (await sheet.innerText()).replace(/\s+/g, " ");
  check("the sheet keeps the sources found earlier, and says so", /Your addons aren’t answering\. Sources from \d+ min ago\./.test(listed) && listed.includes("1080p"), listed.slice(0, 200));
  writeFileSync(`${out}/older-list.aria.txt`, await sheet.ariaSnapshot());
} finally {
  setFault("");
  await browser.close();
}
finish();
