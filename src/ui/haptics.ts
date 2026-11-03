import { android, type Haptic } from "./android";

/**
 * A short tap of the phone's motor, for a gesture that took: a long press, a seek, a pinch snapping. In the Android
 * app it's the phone's own haptic for `kind`, crisper than a vibration and off when the phone's touch feedback is;
 * in Chrome on Android it's a vibration of `ms`. iPhones give pages no vibration, and there it does nothing.
 */
export const tick = (ms = 8, kind: Haptic = "tick") => {
  if (android) android.haptic(kind);
  else navigator.vibrate?.(ms);
};

/**
 * A slider passing one of its marks, as a dial clicks. Only in the Android app: a browser's vibration is too coarse
 * to repeat along a drag.
 */
export const detent = () => android?.haptic("detent");
