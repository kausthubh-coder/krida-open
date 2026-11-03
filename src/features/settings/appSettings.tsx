// Settings that only Krida's apps have: the version and its updates, in all three, and in Krida for Windows and Mac how
// mpv shows the picture. Kept on the device, beside the player's Picture menu, which changes the same things while a
// film plays.
import type { UpdateStatus } from "../../data/desktop";
import { type AppUpdate, useAppUpdate } from "../../ui/appUpdate";
import { Button } from "../../ui/ui";
import { FITS, mpvDebands, mpvFits, mpvTrims, useChosenFit, useDeband, useTrimBars, type Fit } from "../player";
import { Group, SelectRow, Switch } from "./settingsParts";

const STATUS: Record<UpdateStatus["state"], (version: string | null | undefined, app: AppUpdate) => string> = {
  off: () => "Updates are off in this build.",
  idle: () => "Looks for updates while it's open.",
  checking: () => "Looking for an update…",
  current: () => "Up to date.",
  downloading: (v) => `Downloading ${v ?? "an update"}…`,
  ready: (v, app) => `${v ?? "An update"} is ready. ${app.installHint}`,
  failed: (_, app) => (app.check ? "Couldn't reach the updates. Check again, or it tries in a few hours." : "Couldn't reach the updates. It tries again in a few hours."),
  manual: () => "This version can't update itself. Install the new one once, and it keeps itself up to date.",
};

export function AppSettings() {
  const update = useAppUpdate();
  const [fit, setFit] = useChosenFit();
  const [trimBars, setTrimBars] = useTrimBars();
  const [deband, setDeband] = useDeband();
  if (!update) return null;
  const { state, version } = update.status;
  const manualUrl = update.manualUrl;
  return (
    <Group>
      <div className="flex min-h-12 items-center justify-between gap-4">
        <span>
          <span className="block text-body font-medium">Version {update.version}</span>
          <span className="block text-body text-fg-faint" aria-live="polite">
            {STATUS[state](version, update)}
          </span>
        </span>
        {state === "ready" && (
          <Button variant="primary" onClick={update.install}>
            {update.installLabel}
          </Button>
        )}
        {update.check && (state === "idle" || state === "current" || state === "failed") && (
          <Button onClick={update.check}>Check for updates</Button>
        )}
        {state === "manual" && manualUrl && (
          <Button variant="primary" onClick={() => window.open(manualUrl, "_blank")}>
            Download
          </Button>
        )}
      </div>
      {mpvFits() && (
        <SelectRow
          id="fit"
          label="Picture"
          hint="How films fill the window. Press V while one plays to switch."
          value={fit}
          onChange={(v) => setFit(v as Fit)}
          options={FITS.map((x) => ({ value: x.fit, label: `${x.label}: ${x.hint.toLowerCase()}` }))}
        />
      )}
      {mpvTrims() && (
        <Switch
          label="Trim black bars"
          hint="Many widescreen films have black bands built in. Krida finds them as the film plays and trims them. Press B while one plays to switch."
          checked={trimBars}
          onChange={setTrimBars}
        />
      )}
      {mpvDebands() && (
        <Switch
          label="Smooth colour banding"
          hint="Evens out the stepped colour streaming leaves in skies and dark scenes, with a little more work for the graphics card."
          checked={deband}
          onChange={setDeband}
        />
      )}
    </Group>
  );
}
