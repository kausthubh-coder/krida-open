import type { Meta } from "../../../data/cinemeta";
import { episodeLabel } from "../../../ui/format";
import { playTarget, type ProgressItem } from "../../play";

export function playPlan(meta: Meta, progress: ProgressItem[] | undefined, simklNext?: { season: number; episode: number } | null) {
  const { video, row } = playTarget(meta, progress, simklNext);
  const resume = !!row && !row.finished;
  return {
    video,
    startAt: resume ? row.position : 0,
    label: `${resume ? "Resume" : "Play"}${video ? ` ${episodeLabel(video.season, video.episode)}` : ""}`,
  };
}
