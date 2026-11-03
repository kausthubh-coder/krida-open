const YOUTUBE_ID = /^[\w-]{11}$/;

/** Whether `id` is shaped like a YouTube video id, so nothing else reaches an embed. */
export const isYoutubeId = (id: unknown): id is string => typeof id === "string" && YOUTUBE_ID.test(id);

/** The video id in a YouTube link (watch, youtu.be, embed or shorts), or null for anything else. */
export function youtubeId(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^(www|m)\./, "");
  const id =
    host === "youtu.be"
      ? parsed.pathname.slice(1)
      : host === "youtube.com" || host === "youtube-nocookie.com"
        ? (parsed.searchParams.get("v") ?? parsed.pathname.match(/^\/(?:embed|shorts)\/([^/]+)/)?.[1])
        : null;
  return isYoutubeId(id) ? id : null;
}
