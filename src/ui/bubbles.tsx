import { useState, type ReactNode } from "react";
import { BubliFlat, BubliProvider, BubliTheme, Glass, type BubbleFamily, type BubbleTune } from "bubli";
import { browserBend } from "bubli/engine";
import { useBubbleGlass } from "./surfaces";

/**
 * A body you read through. Firefox's frost isn't a given (it goes with software rendering), and the page's text would
 * then read straight through the panel's, so there the body carries it alone.
 */
function readable(opacity: number) {
  return browserBend() === "moz" ? Math.max(opacity, 0.9) : opacity;
}

/**
 * Krida's fit of bubli (vendor/bubli-*.tgz): the numbers that make its bubbles look like Krida's. Everything else lives in
 * the --bubli-* tokens in styles.css, so that menus portalled out of this tree see them too. Colour stays the artwork's:
 * a white accent, neutral bodies, and the film's rim as the only other colour on screen.
 */
const tune = (): BubbleTune => ({
  dark: {
    // Floats over artwork all the time, so it stays thin and leans on the frost and the rim to hold its icons.
    bar: { opacity: 0.34, frost: 16, iridescence: 1.5, reflectivity: 1.6, clearCenter: 0.78, bevel: 13, wobble: 0.35, filmMoves: false },
    // Things you read: thicker, so a poster behind one never fights its text.
    menu: { opacity: readable(0.74), frost: 26, iridescence: 1.3, reflectivity: 1.5, clearCenter: 0.86, wobble: 0.45, filmMoves: false },
    sheet: { opacity: readable(0.8), frost: 30, iridescence: 1.1, reflectivity: 1.4, clearCenter: 0.9, wobble: 0.3, filmMoves: false },
    toast: { opacity: readable(0.72), frost: 22, iridescence: 1.3, reflectivity: 1.5, clearCenter: 0.86, wobble: 0.45, filmMoves: false },
    dialog: { opacity: readable(0.9), frost: 30, iridescence: 1, reflectivity: 1.4, clearCenter: 0.9, wobble: 0.3, filmMoves: false },
  },
});

/** How much body a thin pane keeps: enough, with its frost, for text over a bright picture. */
const THIN_BODY = 0.5;

/**
 * A big panel you read, that stays put: a sheet's body, the Party panel, a card over the picture. A frosted bubble, whose
 * own controls are plain, since there's no bubble in a bubble. It fills what places it; `className` lays out what's inside.
 * `thin` lets the page show through: for something that sits beside what you're looking at rather than over it.
 */
export function Pane({ family = "sheet", radius = 28, thin = false, className, children }: { family?: BubbleFamily; radius?: number; thin?: boolean; className?: string; children: ReactNode }) {
  return (
    <Glass
      name="pane"
      look="frosted"
      preset="panel"
      // A family's dials would win over the thin body.
      family={thin ? undefined : family}
      bend={browserBend() !== "moz"}
      variant="bar"
      material={thin ? { radius, opacity: readable(THIN_BODY) } : { radius }}
      className={`bubble-panel flex min-h-0 w-full flex-1 flex-col${thin ? " bubble-thin" : ""}`}
      style={{ borderRadius: radius }}
    >
      <BubliFlat>
        <div className={className ?? "flex min-h-0 flex-1 flex-col overflow-hidden"} style={{ borderRadius: radius }}>
          {children}
        </div>
      </BubliFlat>
    </Glass>
  );
}

/** Wrap the app once. */
export function KridaBubbles({ children }: { children: ReactNode }) {
  const [bubbles] = useBubbleGlass();
  const [tuned] = useState(tune);
  return (
    <BubliProvider glass={bubbles ? "auto" : "plain"}>
      <BubliTheme theme="dark" surface="bubble" motion="default" tune={tuned} panelMaterial={{ tint: "oklch(0.17 0.008 60)" }}>
        {children}
      </BubliTheme>
    </BubliProvider>
  );
}
