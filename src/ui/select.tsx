// A choice from a list, and the text field it matches: Settings, See all's genres.
import { CaretDownIcon } from "@phosphor-icons/react";
import { cx } from "./ui";

// The same field as the Library's and Search's: 44px, a faint fill and a hairline edge that lights on focus.
export const inputClass =
  "h-11 w-full rounded-full fill-quiet bg-white/6 px-4 text-subhead text-fg placeholder:text-fg-faint ring-1 ring-line ring-inset hover:bg-white/8 focus:bg-white/8 focus:ring-white/25 focus-visible:outline-transparent";

export function Select({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <span className="relative block">
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cx(inputClass, "cursor-pointer appearance-none pr-10")}>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-overlay text-fg">
            {o.label}
          </option>
        ))}
      </select>
      <CaretDownIcon aria-hidden className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-[14px] text-fg-faint" />
    </span>
  );
}
