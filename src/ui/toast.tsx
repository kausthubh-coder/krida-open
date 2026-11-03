import type { ReactNode } from "react";
import { Glass } from "bubli";
import { toast as sonner, type ExternalToast } from "sonner";

type Options = Omit<ExternalToast, "description" | "action" | "cancel"> & {
  description?: ReactNode;
  action?: { label: ReactNode; onClick: () => void };
  cancel?: { label: ReactNode; onClick: () => void };
};

function BubbleToast({ id, tone, title, options }: { id: string | number; tone?: "error"; title: ReactNode; options: Options }) {
  const { description, action, cancel } = options;
  const close = () => sonner.dismiss(id);
  return (
    <Glass
      name="toast"
      preset="panel"
      look="frosted"
      family="toast"
      bend
      variant="bar"
      material={{ radius: 22 }}
      onBubble={(bubble: { body: { sweep: () => void } }) => bubble.body.sweep()}
      className="bubble-panel flex w-full items-center gap-3 rounded-[22px] px-4 py-3 text-body sm:w-[356px]"
    >
      <div className="min-w-0 flex-1">
        <p className={tone === "error" ? "font-medium text-danger" : "font-medium text-fg"}>{title}</p>
        {description && <p className="mt-0.5 text-caption text-fg-muted">{description}</p>}
      </div>
      {cancel && (
        <button
          onClick={() => {
            cancel.onClick();
            close();
          }}
          className="shrink-0 rounded-full px-3 py-1.5 text-caption font-medium text-fg-muted hover:bg-white/10 hover:text-fg"
        >
          {cancel.label}
        </button>
      )}
      {action && (
        <button
          onClick={() => {
            action.onClick();
            close();
          }}
          className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-caption font-semibold text-on-accent hover:bg-accent-hover"
        >
          {action.label}
        </button>
      )}
    </Glass>
  );
}

const show = (tone: "error" | undefined, title: ReactNode, options: Options = {}) => {
  const { description: _description, action: _action, cancel: _cancel, ...rest } = options;
  return sonner.custom((id) => <BubbleToast id={id} tone={tone} title={title} options={options} />, rest);
};

/** Sonner's API, with every toast drawn as a bubble. */
export const toast = Object.assign((title: ReactNode, options?: Options) => show(undefined, title, options), {
  error: (title: ReactNode, options?: Options) => show("error", title, options),
  success: (title: ReactNode, options?: Options) => show(undefined, title, options),
  dismiss: sonner.dismiss,
  custom: sonner.custom,
});
