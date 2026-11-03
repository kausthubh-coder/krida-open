// More like this, at the bottom of a title page.
import { useEffect, useState } from "react";
import { moreLike, type RecItem } from "../../data/api";
import { art, type Meta } from "../../data/cinemeta";
import { PosterCard } from "../../ui/posterCard";
import { itemMeta, scoreSource } from "../../ui/scores";
import { Rail } from "../../ui/rail";
import { CardActions } from "./actions";
import { CardMenu } from "./cardMenu";

/** The closest titles to this one, scored the same way as your picks. */
export function MoreLikeThis({ meta }: { meta: Meta }) {
  const [items, setItems] = useState<RecItem[] | null>(() => similarCache.get(meta.id) ?? null);
  useEffect(() => {
    if (similarCache.has(meta.id)) return;
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
  }, [meta.id, meta.type]);
  if (!items || items.length < 4) return null;
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
