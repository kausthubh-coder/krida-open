// What every settings section is built from: groups of rows, fields, switches and selects.
import { cx, Toggle } from "../../ui/ui";
import { Select } from "../../ui/select";

/** A setting's name and what it does, at the left of its row. */
function RowText({ label, hint, htmlFor, badge }: { label: string; hint?: string; htmlFor?: string; badge?: string }) {
  const Label = htmlFor ? "label" : "span";
  return (
    <span className="min-w-0 flex-1">
      <Label htmlFor={htmlFor} className="block text-body font-medium">
        {label}
        {/* A setting still being tried out says so beside its name. */}
        {badge && (
          <span className="fill-quiet ml-2 inline-flex h-5 items-center rounded-full bg-white/8 px-2 align-[1px] text-caption font-medium text-fg-muted">
            {badge}
          </span>
        )}
      </Label>
      {hint && <span className="block max-w-[60ch] text-body text-fg-faint">{hint}</span>}
    </span>
  );
}

export function Switch({
  label,
  hint,
  badge,
  checked,
  onChange,
}: { label: string; hint?: string; badge?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4">
      <RowText label={label} hint={hint} badge={badge} />
      <Toggle checked={checked} onChange={onChange} />
    </label>
  );
}

/** A choice from a list, at the right of its row; under the name on a phone. */
export function SelectRow({
  id,
  label,
  hint,
  ...select
}: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="flex min-h-12 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <RowText label={label} hint={hint} htmlFor={id} />
      <span className="sm:w-56">
        <Select id={id} {...select} />
      </span>
    </div>
  );
}

/** Settings that belong together: one surface, a hairline between each row. */
export function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-line rounded-sheet bg-surface shadow-raised *:px-5 *:py-4 [&:empty]:hidden">
      {children}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-body font-medium">
        {label}
      </label>
      {children}
      {/* Fields that can fail keep their error line reserved, so nothing below jumps. */}
      {(hint || error !== undefined) && (
        <p className={cx("min-h-5 text-body", error ? "text-danger" : "text-fg-faint")}>{error || hint}</p>
      )}
    </div>
  );
}

