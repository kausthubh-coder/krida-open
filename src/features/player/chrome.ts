// The player's bubbles: the capsules of controls, and how each piece fades.
import { motion } from "motion/react";
import { barBubble } from "../../ui/barBubble";
import { Button, cx } from "../../ui/ui";

// The controls: two small capsules of glass, not a bar across the picture. Every button is 44px, touching, so
// there's no dead gap between targets. Narrow players use one capsule instead of two (`compact:`, PlayerControls).
/** A capsule's bubble. Bending what's under it costs a pass on every video frame, and a phone's GPU has the least to spare. */
export const capsuleBubble = () => barBubble("capsule", !matchMedia("(pointer: coarse)").matches);
export const CAPSULE = "bubble-bar relative flex shrink-0 items-center rounded-full p-1";
export const CAP = "size-11 hover:bg-white/14";
/** A menu's button while its menu is open: lit, like the selected tab. */
export const capOpen = (open: boolean) => cx("size-11", open ? "lens" : "hover:bg-white/14");
/**
 * Glass can't blur under an ancestor that is fading (it only sees the picture once the fade ends), so each piece
 * of glass fades itself. Once faded out it's hidden, so it stops blurring the video; it shows again at once.
 * Keeps `press`'s spring on release.
 */
export const fade = (shown: boolean) =>
  shown
    ? "opacity-100 [transition:opacity_200ms,transform_320ms_var(--ease-spring)]"
    : "invisible opacity-0 [transition:opacity_200ms,visibility_0s_200ms,transform_320ms_var(--ease-spring)]";
export const MotionButton = motion.create(Button);
