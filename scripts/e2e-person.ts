// Person pages: a title page's cast and director link to them, Search's person row opens one, each shows a row per job
// with posters that open their titles, a phone fits it, and a name nobody has says so.
// Needs /api's TMDB key, and the QA app (npm run qa -- up) or a *-QA-* profile on the dev backend.
// Usage: node scripts/e2e-person.ts [base] [profile] [outDir]
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./lib/browser.ts";
import { baseUrl, checks, qaProfiles, signIn } from "./lib/qa.ts";

const [baseArg, name, out = ".artifacts/person-verified"] = process.argv.slice(2);
const base = baseUrl(baseArg);
const [profile] = qaProfiles([name]);
await mkdir(out, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30_000);
  const { check, finish } = checks(page);
  await signIn(page, base, profile);
  const heading = (text: string) => page.getByRole("heading", { level: 1, name: text, exact: true });
  // Screenshots wait for the pictures on screen (ones past its edge load lazily, so never would).
  const pictures = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLImageElement>("main img")]
        .filter((i) => { const r = i.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; })
        .every((i) => i.complete));
  const overflows = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

  // Interstellar's director, from its credits.
  await page.goto(`${base}/title/movie/tt0816692`);
  await page.getByRole("link", { name: "Christopher Nolan", exact: true }).click();
  await heading("Christopher Nolan").waitFor();
  check("director link opens his page", /\/person\/Christopher%20Nolan\?title=tt0816692$/.test(page.url()), page.url());
  const facts = await page.locator("main header p").first().innerText();
  check("facts say his job and birth", facts.includes("Director") && facts.includes("Born 30 July 1970"), facts);
  const rows = await page.locator("main section h2").allInnerTexts();
  check("Director leads the rows", rows[0] === "Director" && rows.includes("Writer"), rows.join(", "));
  check("one-title side jobs are left out", !rows.includes("Actor"), rows.join(", "));
  await pictures();
  await page.screenshot({ path: `${out}/desktop-director.png` });

  await page.getByRole("link", { name: /^Inception/ }).first().click();
  await page.waitForURL(/\/title\/movie\/tt1375666$/);
  check("a poster opens its title", true);

  // An actor, from a show's cast: the show's credits pick the right person.
  await page.goto(`${base}/title/series/tt0903747`);
  await page.getByRole("link", { name: "Bryan Cranston", exact: true }).click();
  await heading("Bryan Cranston").waitFor();
  const first = page.locator("main section").first();
  check("Actor leads an actor's page", (await first.locator("h2").innerText()) === "Actor");
  check("cards say who they played", (await first.innerText()).includes("as Walter White"));

  // Search's person row.
  await page.goto(`${base}/search?q=tarantino`);
  await page.getByRole("link", { name: "See all", exact: true }).click();
  await heading("Quentin Tarantino").waitFor();
  check("Search's person row opens their page", /\/person\/138$/.test(page.url()), page.url());

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/person/525`);
  await heading("Christopher Nolan").waitFor();
  check("a phone has no sideways scroll", !(await overflows()));
  await pictures();
  await page.screenshot({ path: `${out}/phone-director.png` });

  await page.goto(`${base}/person/Zzqx%20Nobody`);
  await page.getByText("We couldn’t find this person", { exact: true }).waitFor();
  check("an unknown name says so", true);
  await finish();
} finally {
  await browser.close();
}
