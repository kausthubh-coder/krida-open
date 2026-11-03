import { useState } from "react";
import { cx } from "./ui";
import { art as artUrls } from "../data/cinemeta";
import { metahubRef, useArtFallback, type ArtLookup } from "./artFallback";

/**
 * The surface missing art falls back to: the page's neutral, a step lighter at the top, so a card without a
 * picture still reads as a card. For boxes that set their own text over it.
 */
export const ART_FALLBACK = "bg-[linear-gradient(160deg_in_oklch,oklch(0.23_0.009_60),oklch(0.17_0.006_60))]";

/**
 * An image that never leaves a grey hole. A Metahub image that fails (it has nothing for many regional
 * films) is replaced by TMDB's; `titleId` asks TMDB when there's no image at all. When neither has one,
 * `fallbackTitle` is set on a neutral surface instead. TMDB is searched by `lookup` (else `fallbackTitle`), for
 * titles it has no IMDb link for.
 */
export function Art({
  src,
  alt,
  fallbackTitle,
  lookup,
  titleId,
  className,
  imgClassName,
  eager,
  onLoad,
}: {
  src?: string;
  alt: string;
  fallbackTitle?: string;
  lookup?: ArtLookup;
  titleId?: string;
  className?: string;
  imgClassName?: string;
  eager?: boolean;
  /** Called once an image (the first choice or its fallback) has loaded. */
  onLoad?: () => void;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string>();
  const ref = metahubRef(src) ?? (!src && titleId?.startsWith("tt") ? { kind: "poster" as const, id: titleId } : null);
  const fallback = useArtFallback(ref, !src || failed.includes(src), lookup ?? { name: fallbackTitle });
  const current = [src, fallback].find((u): u is string => !!u && !failed.includes(u));
  const showImage = !!current;
  // Callers may position the frame themselves (a full-bleed backdrop); don't fight their classes.
  const positioned = /(^|\s)(absolute|fixed)(\s|$)/.test(className ?? "");
  const painted = /(^|\s)bg-/.test(className ?? "");
  return (
    <div className={cx(!positioned && "relative", "overflow-hidden", !painted && "bg-surface", className)}>
      {showImage && (
        <img
          key={current}
          src={current}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onLoad={() => {
            setLoaded(current);
            onLoad?.();
          }}
          onError={() => setFailed((f) => [...f, current])}
          className={cx(
            "absolute inset-0 size-full object-cover transition-opacity duration-300",
            loaded === current ? "opacity-100" : "opacity-0",
            imgClassName,
          )}
        />
      )}
      {!showImage && fallbackTitle && (
        <div className={cx("absolute inset-0 grid place-items-center p-3", ART_FALLBACK)}>
          <span className="line-clamp-4 text-center font-display text-subhead text-fg-muted">{fallbackTitle}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The title logo when one exists, set in the display face when it doesn't. It's the page's heading on hero
 * and title pages; a card passes `as` so the page keeps one h1.
 */
export function TitleArt({
  imdbId,
  name,
  logo,
  size = "hero",
  as: Heading = "h1",
}: {
  imdbId: string;
  name: string;
  logo?: string;
  size?: "hero" | "page" | "card" | "player";
  as?: "h1" | "h2" | "h3";
}) {
  const src = artUrls.logo(imdbId) ?? logo;
  const [failed, setFailed] = useState(false);
  if (failed || !src)
    return (
      <Heading
        className={cx(
          "font-display font-semibold text-fg",
          size === "hero" && "text-[length:clamp(2.25rem,1.5rem+3vw,3.5rem)] leading-[1.05] tracking-[-0.025em] short:text-display",
          size === "page" && "text-hero short:text-display",
          size === "card" && "line-clamp-2 text-display",
          size === "player" && "line-clamp-1 text-display md:text-hero",
        )}
      >
        {name}
      </Heading>
    );
  return (
    <Heading className="m-0">
      <img
        src={src}
        alt={name}
        onError={() => setFailed(true)}
        className={cx(
          "w-auto object-contain object-left drop-shadow-[0_2px_12px_oklch(0_0_0/0.5)]",
          size === "hero" && "max-h-[120px] max-w-[80%] md:max-h-[150px] short:max-h-[72px]",
          size === "page" && "max-h-[100px] max-w-[80%] md:max-h-[140px] short:max-h-[72px]",
          size === "card" && "max-h-12 max-w-[60%] md:max-h-16",
          size === "player" && "max-h-14 max-w-[min(70vw,480px)] md:max-h-20",
        )}
      />
    </Heading>
  );
}
