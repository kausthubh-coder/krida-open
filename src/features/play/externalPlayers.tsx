import { CopyIcon, DownloadSimpleIcon, ArrowSquareOutIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { toast } from "../../ui/toast";
import { Button, cx, Spinner } from "../../ui/ui";
import { m3u, platformOf, playerApps, playlistName } from "./playerLinks";
import type { useFileLink } from "./fileLink";

/**
 * Hands a file to another player: the apps this device opens links in (VLC and Infuse on an iPhone, VLC or any app on
 * Android, IINA and Infuse on a Mac), its link to copy, and a playlist any player opens. The link plays from the
 * account's debrid service, so it's for this person's own players, not for sharing.
 */
export function ExternalPlayers({ url, title, className }: { url: string; title: string; className?: string }) {
  const apps = playerApps(url, platformOf(navigator.userAgent, navigator.maxTouchPoints));
  const copy = () =>
    navigator.clipboard.writeText(url).then(
      () => toast("Link copied", { description: "Paste it into VLC, mpv or any player that opens a network link." }),
      () => toast.error("Couldn’t copy the link."),
    );
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([m3u(url, title)], { type: "audio/x-mpegurl" }));
    a.download = playlistName(title);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  return (
    <div className={cx("flex flex-wrap gap-2", className)}>
      {apps.map((app) => (
        <Button key={app.name} icon={<ArrowSquareOutIcon />} onClick={() => (location.href = app.href)}>
          Open in {app.name}
        </Button>
      ))}
      <Button icon={<CopyIcon />} onClick={() => void copy()}>
        Copy link
      </Button>
      <Button icon={<DownloadSimpleIcon />} onClick={download}>
        Download playlist
      </Button>
    </div>
  );
}

/** Asking for the link, a reason it couldn't be had, or the players to open it in. */
export function ExternalPlayersFor({ link, title, className }: { link: ReturnType<typeof useFileLink>; title: string; className?: string }) {
  if (link.loading)
    return (
      <p className={cx("flex items-center gap-2 text-body text-fg-muted", className)}>
        <Spinner className="size-4" /> Getting the file’s link…
      </p>
    );
  if (link.error)
    return (
      <div className={cx("flex flex-wrap items-center gap-3", className)}>
        <p className="flex items-center gap-2 text-body text-fg-muted">
          <WarningCircleIcon className="shrink-0" /> {link.error}
        </p>
        <Button variant="ghost" onClick={link.load}>
          Try again
        </Button>
      </div>
    );
  return link.url ? <ExternalPlayers url={link.url} title={title} className={className} /> : null;
}
