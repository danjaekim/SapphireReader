// Keep in sync with server/src/genres.ts (same rules, so a chip and the genre list agree on what is the same genre).
/**
 * Sources name the same genre differently ("Sci-Fi", "Science Fiction", "Scifi"; "Martial Arts",
 * "Martial Art"). Sapphire matches genres by a canonical key so picking one genre applies to
 * every source that has any spelling of it.
 */
const norm = (s: string) =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Alternate spellings, keyed by normalized text, pointing at the name to show. */
const ALIASES: Record<string, string> = {
  "sci fi": "Sci-Fi",
  scifi: "Sci-Fi",
  "science fiction": "Sci-Fi",
  "slice of life": "Slice of Life",
  sol: "Slice of Life",
  shounen: "Shounen",
  shonen: "Shounen",
  shoujo: "Shoujo",
  shojo: "Shoujo",
  "shounen ai": "Shounen Ai",
  "shonen ai": "Shounen Ai",
  "shoujo ai": "Shoujo Ai",
  "shojo ai": "Shoujo Ai",
  romantic: "Romance",
  humor: "Comedy",
  comic: "Comedy",
  "super power": "Superpower",
  "super powers": "Superpower",
  superpowers: "Superpower",
  "super natural": "Supernatural",
  "martial art": "Martial Arts",
  "martial arts": "Martial Arts",
  "gender bender": "Gender Bender",
  "gender swap": "Gender Bender",
  genderswap: "Gender Bender",
  "school life": "School Life",
  school: "School Life",
  historical: "Historical",
  history: "Historical",
  sport: "Sports",
  isekai: "Isekai",
  "reincarnated": "Reincarnation",
  "regressor": "Regression",
  "time travel": "Time Travel",
  "psychological thriller": "Psychological",
  "full colour": "Full Color",
  "full colored": "Full Color",
  "official colored": "Full Color",
  "long strip": "Long Strip",
  webtoon: "Webtoon",
  webtoons: "Webtoon",
  "web comic": "Webtoon",
  "boys love": "Boys' Love",
  bl: "Boys' Love",
  yaoi: "Boys' Love",
  "girls love": "Girls' Love",
  gl: "Girls' Love",
  yuri: "Girls' Love",
  mature: "Mature",
  "adult": "Adult",
  smut: "Smut",
};

const singular = (n: string) => (n.length > 4 && n.endsWith("s") && !n.endsWith("ss") ? n.slice(0, -1) : n);

/** The label to show for a genre, whichever spelling a source used. */
export function canonLabel(name: string): string {
  const n = norm(name);
  return ALIASES[n] ?? ALIASES[singular(n)] ?? name.trim();
}

/** What two spellings of the same genre have in common. */
export function canonKey(name: string): string {
  return singular(norm(canonLabel(name)));
}
