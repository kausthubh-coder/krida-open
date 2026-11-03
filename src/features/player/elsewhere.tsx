import { useAction } from "convex/react";
import type { ReactNode } from "react";
import { DesktopIcon, FilmStripIcon } from "@phosphor-icons/react";
import { api } from "../../../convex/_generated/api";
import { art } from "../../data/cinemeta";
import { openInDesktopApp, RELEASES_PAGE } from "../../data/desktop";
import { useAuthed } from "../../data/session";
import { episodeLabel } from "../../ui/format";
import { Art, TitleArt } from "../../ui/artwork";
import { toast } from "../../ui/toast";
import { Button } from "../../ui/ui";
import { ExternalPlayersFor, useFileLink } from "../play";
import type { RoomData } from "../party";
import { whyElsewhere, type ElsewhereWhy } from "./playsIn";

/**
 * No app took the link within a moment (not installed, older than 0.1.11, or the browser is still asking whether to
 * open it): the download, in a new tab, without claiming it failed.
 */
const offerDownload = () =>
  toast("Don’t have Krida for Mac or Windows?", {
    description: "It plays every file. Version 0.1.11 or later opens titles from here.",
    duration: 10_000,
    action: { label: "Download", onClick: () => void window.open(RELEASES_PAGE, "_blank", "noopener") },
  });

/**
 * A file the browser can't play (another debrid service's MKV, or sound no browser has): instead of a player that
 * fails, where it does play. The desktop app plays every file in mpv; this device's players take its link; or another
 * copy, perhaps an MP4, plays right here.
 */
export function PlayElsewhere({ room, why, topBar, onSources }: { room: RoomData; why: ElsewhereWhy; topBar: ReactNode; onSources: () => void }) {
  const { token } = useAuthed();
  const fileLink = useAction(api.desktop.fileLink);
  const stream = room.stream!;
  const m = room.media!;
  const title = m.episodeTitle ? `${m.name} · ${episodeLabel(m.season, m.episode)}` : m.name;
  const link = useFileLink(async () => {
    const url = await fileLink({ token, streamId: stream._id });
    if (!url) throw new Error("This file isn’t available anymore. Choose another source.");
    return url;
  }, why !== "account");
  return (
    <div className="relative isolate flex h-full flex-col">
      <Art
        src={m.background ?? art.backgroundLarge(m.imdbId)}
        alt=""
        eager
        className="absolute inset-0 -z-10 bg-page"
        imgClassName="scale-105 blur-2xl brightness-[0.35]"
      />
      {topBar}
      <div className="flex flex-1 flex-col items-center justify-center gap-8 overflow-y-auto px-6 pb-24 text-center">
        <div className="flex max-w-xl flex-col items-center gap-3">
          <TitleArt imdbId={m.imdbId} name={m.name} logo={m.logo} size="page" />
          {m.episodeTitle && <p className="text-subhead text-fg-muted">{`${episodeLabel(m.season, m.episode)} · ${m.episodeTitle}`}</p>}
        </div>
        <div className="flex max-w-lg flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-1.5">
            <h2 className="text-subhead font-medium text-fg">{why === "account" ? "This plays for the host only" : "This file plays outside the browser"}</h2>
            <p className="text-body text-pretty text-fg-muted">
              {whyElsewhere(why, stream)}
              {why !== "account" && " Krida for Mac and Windows plays every file, or open it in another player on this device."}
            </p>
          </div>
          {why !== "account" && <ExternalPlayersFor link={link} title={title} className="justify-center" />}
          <div className="flex flex-wrap justify-center gap-2">
            {why !== "account" && (
              <Button variant="ghost" icon={<DesktopIcon />} onClick={() => openInDesktopApp(`/title/${m.type}/${m.imdbId}`, offerDownload)}>
                Open in the desktop app
              </Button>
            )}
            <Button variant="ghost" icon={<FilmStripIcon />} onClick={onSources}>
              Choose another source
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
