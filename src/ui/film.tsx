import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBubble, useBubli } from "bubli";
import type { Material } from "bubli/engine";
import { ON_PICTURE, QUIET } from "./materials";

function Canvas({ material }: { material: Partial<Material> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    host.current = canvas.current!.parentElement;
    host.current?.classList.add("bubli-glass");
  }, []);
  useBubble({ host, canvas, preset: "control", material });
  return <canvas ref={canvas} aria-hidden className="bubli-canvas" />;
}

/** Makes its parent a bubble, for a control that isn't one of ui.tsx's buttons. Put it first inside. */
export function Film({ material = QUIET }: { material?: Partial<Material> }) {
  const { mode } = useBubli();
  return mode.glass === "bubble" ? <Canvas material={material} /> : null;
}

// What the pointer is in. Home has hundreds of card buttons: one listener, and only the card it's in hears about it.
type Zones = { card: Element | null; rail: Element | null };
const lit: Zones = { card: null, rail: null };
const watchers = new Map<Element, Set<() => void>>();
const tell = (zone: Element | null) => zone && watchers.get(zone)?.forEach((listener) => listener());
let listening = false;
const move = (event: Event) => {
  const target = event.target instanceof Element ? event.target : null;
  for (const [key, selector] of [["card", "[data-card]"], ["rail", "[data-film-zone]"]] as const) {
    const zone = target?.closest(selector) ?? null;
    if (zone === lit[key]) continue;
    const old = lit[key];
    lit[key] = zone;
    tell(old);
    tell(zone);
  }
};
const watch = (zone: Element, listener: () => void) => {
  if (!listening) {
    listening = true;
    document.addEventListener("pointerover", move, { passive: true });
    document.addEventListener("focusin", move, { passive: true });
  }
  const set = watchers.get(zone) ?? new Set();
  set.add(listener);
  watchers.set(zone, set);
  return () => {
    set.delete(listener);
    if (!set.size) watchers.delete(zone);
  };
};

const NO_HOVER = "(hover: none)";

function WhenHovered({ material, shownOnTouch }: { material: Partial<Material>; shownOnTouch: boolean }) {
  const [zone, setZone] = useState<Element | null>(null);
  const here = useSyncExternalStore(
    (listener) => (zone ? watch(zone, listener) : () => {}),
    () => !!zone && (lit.card === zone || lit.rail === zone),
  );
  const always = shownOnTouch && matchMedia(NO_HOVER).matches;
  return (
    <>
      <span hidden ref={(el) => setZone(el?.closest("[data-card], [data-film-zone]") ?? null)} />
      {(here || always) && <Canvas material={material} />}
    </>
  );
}

/**
 * A bubble for a button that shows only while its card (or rail) is under the pointer. It exists only then, so a page of
 * cards holds none at rest. `shownOnTouch` is for one a touch screen keeps showing, which has no pointer to wait for.
 */
export function HoverFilm({ material = ON_PICTURE, shownOnTouch = false }: { material?: Partial<Material>; shownOnTouch?: boolean }) {
  const { mode } = useBubli();
  return mode.glass === "bubble" ? <WhenHovered material={material} shownOnTouch={shownOnTouch} /> : null;
}
