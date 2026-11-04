/**
 * A TV remote's D-pad (and a keyboard's arrows) moving focus to the nearest thing on screen in that direction, as
 * Android TV's own apps do: across a row of cards, down to the next row, over to the nav. Krida's Android app turns it
 * on (android.ts); a remote has no Tab and no pointer. The browser's own focus ring shows where you are, thicker here
 * (html[data-dpad] in styles.css).
 *
 * What already answers an arrow keeps it: a text field's caret, a slider (the timeline) left and right, a menu that
 * moves through its own items (it marks the key handled). In the player with nothing focused, arrows stay the
 * player's (seek and volume, keys.ts).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Rows that remember where focus was in them, so coming back to one lands on the card you left rather than the
 * nearest: Home's rails (`data-rail`, ui/rail.tsx), the nav, and anything marked `data-dpad-group`.
 */
const GROUP = "[data-rail], nav, [data-dpad-group]";

export type Direction = "up" | "down" | "left" | "right";
const DIRECTIONS: Partial<Record<string, Direction>> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

export function startDpad() {
  const last = new WeakMap<Element, HTMLElement>();
  addEventListener("focusin", (e) => {
    const group = e.target instanceof HTMLElement ? e.target.closest(GROUP) : null;
    if (group) last.set(group, e.target as HTMLElement);
  });
  addEventListener("keydown", (e) => {
    const direction = DIRECTIONS[e.key];
    if (!direction || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    document.documentElement.dataset.dpad = "";
    const active = document.activeElement;
    const from = active instanceof HTMLElement && active !== document.body && isShown(active) ? active : null;
    if (from && keepsArrow(from, direction)) return;
    if (!from && document.documentElement.hasAttribute("data-player")) return;
    const to = nextFocus(from, direction, last);
    if (!to) return;
    e.preventDefault();
    // Before keys.ts's own listener on window: an arrow that moves focus doesn't also seek.
    e.stopImmediatePropagation();
    to.focus({ preventScroll: true });
    const vertical = direction === "up" || direction === "down";
    to.scrollIntoView({ block: vertical ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
  });
  // A finger or a mouse puts the ring back to the web's.
  addEventListener("pointerdown", () => delete document.documentElement.dataset.dpad, { passive: true });
}

/** Whether `el` uses this arrow itself. */
function keepsArrow(el: HTMLElement, direction: Direction) {
  const across = direction === "left" || direction === "right";
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return !across;
  if (el instanceof HTMLInputElement) {
    if (el.type === "range") return across;
    return across && !["checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(el.type);
  }
  return across && el.getAttribute("role") === "slider";
}

/** On screen to a person: laid out, not hidden, see-through or inert. */
export function isShown(el: HTMLElement) {
  if (el.closest("[inert]")) return false;
  // A card's own buttons stay see-through until the card has focus: not a place to land.
  if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Where focus can go: inside the sheet or popup on top when there is one. */
function scope(): ParentNode {
  const open = [...document.querySelectorAll<HTMLElement>("dialog[open], [aria-modal='true']")].filter(isShown);
  return open.at(-1) ?? document;
}

/**
 * The nearest focusable thing from `from` in `direction`: the smallest gap that way, with a sideways miss counting
 * double, so going down from a card lands on the card under it in the next row rather than one further along that
 * row. Entering a row from outside lands where focus last was in it. With nothing focused, the first thing on
 * screen.
 */
function nextFocus(from: HTMLElement | null, direction: Direction, last?: WeakMap<Element, HTMLElement>) {
  const all = [...scope().querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el !== from && isShown(el));
  if (!from) {
    return all.find((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    });
  }
  // Not what contains focus, or what it contains (a card's own buttons are reached by Tab or its menu).
  const others = all.filter((el) => !el.contains(from) && !from.contains(el));
  const best = nearest(from.getBoundingClientRect(), others.map((el) => ({ item: el, box: el.getBoundingClientRect() })), direction);
  if (!best) return undefined;
  const group = best.closest(GROUP);
  const remembered = group && !group.contains(from) ? last?.get(group) : undefined;
  return remembered?.isConnected && isShown(remembered) ? remembered : best;
}

type Box = { left: number; top: number; right: number; bottom: number };

/** Of `options`, the one nearest `from` in `direction`: the smallest gap that way plus twice the sideways miss. */
export function nearest<T>(from: Box, options: { item: T; box: Box }[], direction: Direction): T | undefined {
  let best: { item: T; score: number } | undefined;
  for (const { item, box } of options) {
    const gap = gapOf(from, box, direction);
    if (gap === null) continue;
    const across = direction === "left" || direction === "right";
    const miss = across ? apart(from.top, from.bottom, box.top, box.bottom) : apart(from.left, from.right, box.left, box.right);
    const score = gap + 2 * miss;
    if (!best || score < best.score) best = { item, score };
  }
  return best?.item;
}

/** How far `c` lies beyond `f` in `direction`, or null when it isn't that way (a few pixels of overlap allowed). */
function gapOf(f: Box, c: Box, direction: Direction) {
  const SLACK = 4;
  switch (direction) {
    case "right":
      return c.left >= f.right - SLACK ? Math.max(0, c.left - f.right) : null;
    case "left":
      return c.right <= f.left + SLACK ? Math.max(0, f.left - c.right) : null;
    case "down":
      return c.top >= f.bottom - SLACK ? Math.max(0, c.top - f.bottom) : null;
    case "up":
      return c.bottom <= f.top + SLACK ? Math.max(0, f.top - c.bottom) : null;
  }
}

/** The distance between two spans on a line, 0 when they overlap. */
function apart(a1: number, a2: number, b1: number, b2: number) {
  return Math.max(0, b1 - a2, a1 - b2);
}
