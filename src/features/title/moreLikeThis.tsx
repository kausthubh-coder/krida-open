// More like this, at the bottom of a title page.
import { useEffect, useState } from "react";
import { moreLike, type RecItem } from "../../data/api";
import { art, type Meta } from "../../data/cinemeta";
import { PosterCard } from "../../ui/posterCard";
import { itemMeta, scoreSource } from "../../ui/scores";
import { Rail } from "../../ui/rail";
import { CardActions } from "./actions";
import { CardMenu } from "./cardMenu";
import { useNeedsTmdbKey } from "../../data/keys";
import { isTitleId } from "../../../shared/ids";

/**
 * The closest titles to this one, scored the same way as your picks, on TMDB: none without the account's key, or for a
 * title known only by an addon's own id.
 */
export function MoreLikeThis({ meta }: { meta: Meta }) {
  const needsKey = useNeedsTmdbKey();
  const asks = !needsKey && isTitleId(meta.id);
  const [items, setItems] = useState<RecItem[] | null>(() => similarCache.get(meta.id) ?? null);
  useEffect(() => {
    if (!asks || similarCache.has(meta.id)) return;
    let alive = true;
    moreLike(meta.id, meta.type).then(
      (r) => {
        similarCache.set(meta.id, r);
        if (alive) setItems(r);
      },
      () => alive && setItems([]),
    );
    return () => {
      alive = false;
    };
  }, [asks, meta.id, meta.type]);
  if (!asks || !items || items.length < 4) return null;
  return (
    <div className="mt-12">
      <Rail title="More like this">
        {items.map((item) => (
          <CardMenu key={item.id} item={item} to={`/title/${item.type}/${item.id}`}>
            <PosterCard
              to={`/title/${item.type}/${item.id}`}
              poster={item.poster ?? art.poster(item.id)}
              title={item.name}
              subtitle={itemMeta(item)}
              score={scoreSource(item)}
              actions={<CardActions item={item} />}
            />
          </CardMenu>
        ))}
      </Rail>
    </div>
  );
}

const similarCache = new Map<string, RecItem[]>();
