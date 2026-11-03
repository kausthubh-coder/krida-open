/** "Attack on Titan the Movie: The Last Attack" and "Attack on Titan: Crimson Bow and Arrow" are one franchise. */
export const franchise = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9: ]+/g, " ")
    .split(/:| the movie| movie | season \d| part \d| \d+(?:st|nd|rd|th) season/)[0]
    .replace(/\s+/g, " ")
    .trim();
