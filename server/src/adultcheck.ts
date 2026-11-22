import { canonKey } from "./genres.js";
import { ratingsFor } from "./ratings.js";
import { normalizeTitle } from "./search.js";
import type { Store } from "./store.js";

type FetchLike = typeof fetch;

// Genre tags that mean adult content. "Mature" and "Ecchi" are left out: sites use them for violence and mild fan service.
const ADULT_TAGS = new Set(["adult", "hentai", "smut", "pornographic", "porn", "erotica", "18", "r18", "nsfw", "sexual content", "explicit"]);

export const tagsAreAdult = (tags: string[]): boolean => tags.some((t) => ADULT_TAGS.has(canonKey(t)) || ADULT_TAGS.has(t.trim().toLowerCase()));

export interface CheckItem {
  mangaId: number;
  title: string;
}

/**
 * Works out which of these series are adult, cheapest evidence first, and remembers each answer:
 * tags we've already seen, then AniList's adult flag (free: the ratings lookup is shared), and only
 * then the source site itself (one request per series, a few at a time).
 * `details` fetches a series' genres from its source.
 */
export async function classifyAdult(
  store: Store,
  items: CheckItem[],
  opts: { fetchImpl?: FetchLike; details: (mangaId: number) => Promise<string[]>; concurrency?: number },
): Promise<Map<number, boolean | null>> {
  const out = new Map<number, boolean | null>();
  const known = store.seriesAdult(items.map((i) => i.mangaId));
  const todo: CheckItem[] = [];
  for (const it of items) {
    // A title you marked 18+ is adult, whatever the sources say.
    if (store.adultMarked(it.title)) {
      out.set(it.mangaId, true);
      continue;
    }
    const k = known.get(it.mangaId);
    if (k !== undefined) {
      out.set(it.mangaId, k);
      continue;
    }
    const tags = store.seriesTags(it.mangaId);
    if (tags && tags.length > 0) {
      const a = tagsAreAdult(tags);
      store.putSeriesAdult(it.mangaId, a, "tags");
      out.set(it.mangaId, a);
    } else todo.push(it);
  }
  if (todo.length === 0) return out;

  // AniList: free, and an adult flag is decisive. A "not adult" answer is trusted too, to save requests.
  const meta = await ratingsFor(store, todo.map((t) => t.title), opts.fetchImpl, {}, false).catch(() => new Map());
  const needSite: CheckItem[] = [];
  for (const it of todo) {
    const am = meta.get(normalizeTitle(it.title));
    if (am && am.anilistId !== null && am.adult !== null && am.adult !== undefined) {
      store.putSeriesAdult(it.mangaId, am.adult, "anilist");
      out.set(it.mangaId, am.adult);
    } else needSite.push(it);
  }

  const queue = [...needSite];
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        try {
          const tags = await opts.details(it.mangaId);
          if (tags.length > 0) {
            store.recordSeriesTags(it.mangaId, tags);
            const a = tagsAreAdult(tags);
            store.putSeriesAdult(it.mangaId, a, "tags");
            out.set(it.mangaId, a);
          } else out.set(it.mangaId, null);
        } catch {
          out.set(it.mangaId, null);
        }
      }
    }),
  );
  return out;
}
