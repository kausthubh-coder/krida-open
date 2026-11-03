import { browserBend } from "bubli/engine";

/**
 * A bar's bubble: thin, so the picture passes under it. Firefox can only bend a live copy of the page, which washed a touched
 * bar out to grey, so there it's frosted by plain CSS instead (styles.css). On touch a bar over a playing video doesn't bend
 * either (`chrome.ts`): that costs a pass on every video frame.
 */
export const barBubble = (name = "bar", bend = true) =>
  ({ name, preset: "bar", look: "bar", bend: bend && browserBend() !== "moz", variant: "bar", material: { radius: 9999 } }) as const;
