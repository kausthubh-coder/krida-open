import { SPEEDS, speedLabel } from "./playback";
import { useId } from "react";
import { Select } from "../../ui/select";

export function SpeedChoice({ speed }: { speed: { speed: number; setSpeed: (speed: number) => void } | null }) {
  const id = useId();
  return speed ? (
    <div className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-body">
      <label htmlFor={id}>Speed</label>
      <Select id={id} value={String(speed.speed)} onChange={(s) => speed.setSpeed(Number(s))}
        options={SPEEDS.map((s) => ({ value: String(s), label: s === 1 ? "1× · Normal" : speedLabel(s) }))} />
    </div>
  ) : <p className="px-3 py-2 text-body text-fg-muted">Parties play at 1× to stay in sync.</p>;
}
