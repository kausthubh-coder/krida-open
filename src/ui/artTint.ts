import { useEffect } from "react";

/**
 * The page takes its colour from what's on screen: while a title's artwork leads the page (Home's featured
 * slide, a title page), `--art` on the page holds that artwork's colour, and the glow behind the page and the glass's
 * tint mix it in (styles.css). Krida's own controls stay black and white; the colour is the artwork's.
 *
 * The colour comes from a small copy of the image (a few KB), drawn into a 12×12 canvas. Hosts that don't allow
 * reading their pixels (Kitsu) leave the page neutral.
 */
const cache = new Map<string, string | null>();

/** The smallest copy the host serves: the colour of a 300px backdrop is the colour of the full one. */
function small(src: string) {
  return src
    .replace(/\/background\/(large|medium)\//, "/background/small/")
    .replace(/\/t\/p\/(original|w\d+)\//, "/t/p/w300/");
}

/** sRGB 0–255 to OKLCH, for a lightness and chroma that read the same whatever the hue. */
function toOklch(r: number, g: number, b: number) {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), H: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function sample(src: string) {
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 12;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, size, size);
        const d = ctx.getImageData(0, 0, size, size).data;
        // Colourful, lit pixels count most: a grey sky or a black border shouldn't wash the colour out.
        let r = 0;
        let g = 0;
        let b = 0;
        let total = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]);
          const min = Math.min(d[i], d[i + 1], d[i + 2]);
          const weight = ((max - min) / 255) * (max / 255) + 0.02;
          r += d[i] * weight;
          g += d[i + 1] * weight;
          b += d[i + 2] * weight;
          total += weight;
        }
        const { C, H } = toOklch(r / total, g / total, b / total);
        // One lightness for every title, and a chroma kept calm, so the glow is a mood, not a colour block.
        resolve(C < 0.02 ? null : `oklch(0.55 ${Math.min(0.14, C * 1.3).toFixed(3)} ${H.toFixed(1)})`);
      } catch {
        // The host doesn't let the page read its pixels.
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = small(src);
  });
}

/** Gives the page the colour of `src` while the calling component shows it. */
export function useArtTint(src: string | undefined) {
  useEffect(() => {
    if (!src) return;
    let live = true;
    const root = document.documentElement;
    const apply = (colour: string | null | undefined) => {
      if (!live) return;
      if (colour) root.style.setProperty("--art", colour);
      else root.style.removeProperty("--art");
    };
    if (cache.has(src)) apply(cache.get(src));
    else
      void sample(src).then((colour) => {
        cache.set(src, colour);
        apply(colour);
      });
    return () => {
      live = false;
      root.style.removeProperty("--art");
    };
  }, [src]);
}
