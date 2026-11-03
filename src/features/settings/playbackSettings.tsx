// Settings → Playback's sources and subtitles: words to hide sources by, and how Krida draws subtitles.
import { useState } from "react";
import { useAuthed } from "../../data/session";
import { useUpdateProfile } from "../../data/profile";
import { inputClass } from "../../ui/select";
import { Button } from "../../ui/ui";
import { Field, SelectRow } from "./settingsParts";

/** Words that hide a source, saved when the person says so, not on every key. */
export function SourceFilterField() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  const saved = me.prefs.sourceFilter ?? "";
  const [text, setText] = useState(saved);
  const dirty = text.trim() !== saved;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) void update({ token, prefsPatch: { sourceFilter: text.trim() || null } });
      }}
    >
      <Field
        label="Hide sources containing"
        htmlFor="sourceFilter"
        hint="Words separated by |, like CAM|TS|HDCAM. Any listing with one of them as a whole word, in any case, is left out of the list and never played."
      >
        <div className="flex gap-2">
          <input
            id="sourceFilter"
            value={text}
            maxLength={300}
            placeholder="CAM|TS|HDCAM"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            className={inputClass}
          />
          {dirty && (
            <Button type="submit" variant="primary" className="h-11">
              Save
            </Button>
          )}
        </div>
      </Field>
    </form>
  );
}

/** How subtitles Krida draws look, with a line drawn that way to see it. */
export function SubtitleLook() {
  const { token, me } = useAuthed();
  const update = useUpdateProfile();
  const { subtitleSize, subtitleColor, subtitleEdge } = me.prefs;
  return (
    <>
      <div className="relative grid aspect-[21/9] place-items-end overflow-hidden rounded-card bg-linear-to-br from-white/25 via-white/8 to-black/60 img-outline">
        <p className="w-full px-4 pb-4 text-center">
          <span className="subtitle-cue inline-block text-white" data-size={subtitleSize} data-color={subtitleColor} data-edge={subtitleEdge}>
            We’re going to need a bigger boat.
          </span>
        </p>
      </div>
      <SelectRow
        id="subtitleSize"
        label="Size"
        value={subtitleSize ?? "medium"}
        onChange={(v) => void update({ token, prefsPatch: { subtitleSize: v as "small" | "medium" | "large" | "huge" } })}
        options={[
          { value: "small", label: "Small" },
          { value: "medium", label: "Medium" },
          { value: "large", label: "Large" },
          { value: "huge", label: "Extra large" },
        ]}
      />
      <SelectRow
        id="subtitleColor"
        label="Text colour"
        value={subtitleColor ?? "white"}
        onChange={(v) => void update({ token, prefsPatch: { subtitleColor: v as "white" | "yellow" | "cyan" } })}
        options={[
          { value: "white", label: "White" },
          { value: "yellow", label: "Yellow" },
          { value: "cyan", label: "Cyan" },
        ]}
      />
      <SelectRow
        id="subtitleEdge"
        label="Edge"
        hint="What keeps them readable over a bright picture."
        value={subtitleEdge ?? "shadow"}
        onChange={(v) => void update({ token, prefsPatch: { subtitleEdge: v as "shadow" | "outline" | "box" } })}
        options={[
          { value: "shadow", label: "Shadow" },
          { value: "outline", label: "Outline" },
          { value: "box", label: "Dark box" },
        ]}
      />
      <p className="text-body text-fg-faint">
        For subtitles Krida draws: OpenSubtitles and your subtitle addons, everywhere. A file’s own tracks, which only Krida
        for Mac and Windows shows, keep mpv’s look for now.
      </p>
    </>
  );
}
