import type { Material } from "bubli/engine";

/** The one white action: a solid body with the film only on its rim. */
export const WHITE: Partial<Material> = { tint: "oklch(0.97 0.004 60)", opacity: 1, iridescence: 0.7, oilCoverage: 0.5, clearCenter: 1, reflectivity: 1.6 };
/** On artwork or video: a little body under the film, so a label holds on a bright frame. */
export const ON_PICTURE: Partial<Material> = { tint: "oklch(0.14 0.006 60)", opacity: 0.34 };
/** A quiet control on the page: the bars' dark body, since a white one reads as a grey slab on Krida's black. */
export const QUIET: Partial<Material> = ON_PICTURE;
