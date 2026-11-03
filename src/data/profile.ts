import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { mergePrefs } from "../../convex/lib/prefs";

/** profiles.update that shows the change at once. Send `prefsPatch` with only what changed: the server merges it
 * into the latest settings, so a second switch flipped before the first is saved doesn't undo it. */
export function useUpdateProfile() {
  return useMutation(api.profiles.update).withOptimisticUpdate((store, args) => {
    const me = store.getQuery(api.profiles.me, { token: args.token });
    if (!me) return;
    store.setQuery(
      api.profiles.me,
      { token: args.token },
      {
        ...me,
        ...(args.hue !== undefined ? { hue: args.hue } : {}),
        prefs: args.prefsPatch ? mergePrefs(args.prefs ?? me.prefs, args.prefsPatch) : (args.prefs ?? me.prefs),
      },
    );
  });
}
