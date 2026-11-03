import { ButtonLink, EmptyState } from "../ui/ui";

export function NotFound() {
  return (
    <EmptyState
      className="min-h-[70dvh] pt-24"
      title="There’s nothing at this address"
      description="The link may be old, or the room it pointed to has ended."
      action={<ButtonLink to="/">Go home</ButtonLink>}
    />
  );
}
