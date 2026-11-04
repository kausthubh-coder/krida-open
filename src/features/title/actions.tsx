import { useContext } from "react";
import { useRate, useRating } from "../../data/mine";
import { CardPlace } from "../../ui/longPress";
import { RateMenu } from "./taste";
import { ListButton, StatusButton, type StatusItem } from "./watchStatus";
import { CardSuggest } from "../party";
import { isTitleId } from "../../../shared/ids";

export function CardActions({ item, undo }: { item: StatusItem; undo?: boolean }) {
  const rating = useRating(item.id);
  const rate = useRate();
  // In a long press's peek there's room to name each one, the way the title page does.
  const peek = useContext(CardPlace) === "peek";
  // Plan to watch, statuses and ratings are kept by IMDb or Kitsu id (they reach Simkl); an addon's own id has none.
  if (!isTitleId(item.id)) return <CardSuggest item={item} />;
  const onChange = (change: Parameters<typeof rate>[1]) => rate({ id: item.id, type: item.type, name: item.name, poster: item.poster }, change);
  if (peek)
    return <>
      <ListButton item={item} variant="secondary" />
      <RateMenu variant="secondary" item={item} value={rating ?? null} loading={rating === undefined} onChange={onChange} />
      <CardSuggest item={item} />
    </>;
  return <>
    <CardSuggest item={item} />
    <StatusButton item={item} size="sm" undo={undo} />
    <RateMenu size="sm" align="end" item={item} value={rating ?? null} loading={rating === undefined} onChange={onChange} />
  </>;
}
