// Design system inventory. Paste into the browser console (or run through your
// browser tool's evaluate) on each screen you audit. It walks every visible
// element and counts the distinct values the page actually uses, so system
// drift (13px next to 14px, five greys, three radii) shows up as numbers.
// Read-only: it changes nothing on the page, and needs no profile or backend of its own.
// Usage: page.evaluate(readFileSync("scripts/inventory.js", "utf8")), as scripts/audit-settings.mjs does.
(() => {
  const count = (map, key) => {
    if (key == null || key === "") return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const sorted = (map, limit = 40) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([value, uses]) => ({ value, uses }));
  const px = (value) => Math.round(parseFloat(value) * 10) / 10;

  const fontSizes = new Map();
  const fontWeights = new Map();
  const fontFamilies = new Map();
  const lineHeights = new Map();
  const letterSpacings = new Map();
  const textColors = new Map();
  const backgrounds = new Map();
  const borderColors = new Map();
  const radii = new Map();
  const shadows = new Map();
  const gaps = new Map();
  const paddings = new Map();
  const margins = new Map();
  const transitions = new Map();
  const easings = new Map();

  const hasOwnText = (el) =>
    [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0,
    );

  for (const el of document.body.querySelectorAll("*")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0")
      continue;

    if (hasOwnText(el)) {
      count(fontSizes, `${px(s.fontSize)}px`);
      count(fontWeights, s.fontWeight);
      count(fontFamilies, s.fontFamily.split(",")[0].replace(/["']/g, "").trim());
      count(
        lineHeights,
        s.lineHeight === "normal"
          ? "normal"
          : `${Math.round((parseFloat(s.lineHeight) / parseFloat(s.fontSize)) * 100) / 100}`,
      );
      if (s.letterSpacing !== "normal") count(letterSpacings, s.letterSpacing);
      count(textColors, s.color);
    }

    if (s.backgroundColor !== "rgba(0, 0, 0, 0)") count(backgrounds, s.backgroundColor);
    if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none")
      count(borderColors, `${s.borderTopWidth} ${s.borderTopColor}`);
    if (s.borderTopLeftRadius !== "0px")
      count(
        radii,
        parseFloat(s.borderTopLeftRadius) >= 999 ? "full" : s.borderTopLeftRadius,
      );
    if (s.boxShadow !== "none") count(shadows, s.boxShadow);

    for (const g of [s.rowGap, s.columnGap])
      if (g && g !== "normal" && g !== "0px") count(gaps, `${px(g)}px`);
    for (const p of [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft])
      if (p !== "0px") count(paddings, `${px(p)}px`);
    for (const m of [s.marginTop, s.marginBottom])
      if (m !== "0px" && m !== "auto") count(margins, `${px(m)}px`);

    if (s.transitionDuration && s.transitionDuration !== "0s") {
      count(transitions, `${s.transitionProperty} ${s.transitionDuration}`);
      count(easings, s.transitionTimingFunction);
    }
  }

  const spacing = new Map();
  for (const m of [gaps, paddings, margins])
    for (const [k, v] of m) spacing.set(k, (spacing.get(k) ?? 0) + v);

  const report = {
    url: location.href,
    viewport: `${innerWidth}x${innerHeight}`,
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    distinct: {
      fontSizes: fontSizes.size,
      fontWeights: fontWeights.size,
      fontFamilies: fontFamilies.size,
      textColors: textColors.size,
      backgrounds: backgrounds.size,
      radii: radii.size,
      shadows: shadows.size,
      spacingValues: spacing.size,
      easings: easings.size,
    },
    fontSizes: sorted(fontSizes),
    fontWeights: sorted(fontWeights),
    fontFamilies: sorted(fontFamilies),
    lineHeights: sorted(lineHeights),
    letterSpacings: sorted(letterSpacings),
    textColors: sorted(textColors),
    backgrounds: sorted(backgrounds),
    borders: sorted(borderColors),
    radii: sorted(radii),
    shadows: sorted(shadows, 15),
    spacing: sorted(spacing, 60),
    transitions: sorted(transitions, 25),
    easings: sorted(easings),
    horizontalOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
  return JSON.stringify(report, null, 2);
})();
