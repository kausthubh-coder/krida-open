export type Thumb = "down" | "up" | "love" | null;

export function scoreOf(row: { rating?: number | null; value: Thumb }) {
  return row.rating !== undefined ? row.rating : row.value === "love" ? 9 : row.value === "up" ? 7 : row.value === "down" ? 3 : null;
}

export function bandOf(rating: number | null): Thumb {
  return rating === null || rating === 5 ? null : rating >= 9 ? "love" : rating >= 6 ? "up" : "down";
}
