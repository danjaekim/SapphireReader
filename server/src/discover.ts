import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";
import { browseByGenres } from "./browse.js";
import { canonKey } from "./genres.js";
import {
  interleaveGroups,
  listSources,
  scopedSources,
  normalizeTitle,
  type Scope,
  type SearchResult,
  type SeriesGroup,
  type SourceHit,
  type SourceReport,
} from "./search.js";

type FetchLike = typeof fetch;

const LIST_MUTATION = `
  mutation ($input: FetchSourceMangaInput!) {
    fetchSourceManga(input: $input) {
      mangas { id title thumbnailUrl }
    }
  }`;

export type DiscoverSort = "popular" | "latest";

/**
 * Each source's own popular or latest list, merged. Sources are interleaved rank by rank so
 * every site's top picks come first instead of one big site filling the page.
 */
export async function discover(
  config: Config,
  sort: DiscoverSort,
  opts: { fetchImpl?: FetchLike; scope?: Scope; onResult?: SourceReport; timeoutMs?: number; page?: number } = {},
): Promise<SearchResult> {
  const { fetchImpl, scope = "safe", onResult, timeoutMs = 10000, page = 1 } = opts;
  const sources = scopedSources(await listSources(config, fetchImpl), scope);
  const failed: SearchResult["failed"] = [];
  const lists = await Promise.all(
    sources.map(async (source) => {
      const started = Date.now();
      try {
        const data = await engineQuery<{
          fetchSourceManga: { mangas: { id: number; title: string; thumbnailUrl: string | null }[] };
        }>(
          config,
          LIST_MUTATION,
          { input: { source: source.id, type: sort === "latest" ? "LATEST" : "POPULAR", page } },
          { fetchImpl, timeoutMs },
        );
        onResult?.(source, { ok: true, ms: Date.now() - started });
        return data.fetchSourceManga.mangas.map<SourceHit>((m) => ({
          mangaId: m.id,
          sourceId: source.id,
          sourceName: source.name,
          title: m.title,
          thumbnailUrl: m.thumbnailUrl,
        }));
      } catch (err) {
        const error = err instanceof Error ? err.message : "unknown error";
        onResult?.(source, { ok: false, ms: Date.now() - started, error });
        failed.push({ sourceName: source.name, error });
        return [] as SourceHit[];
      }
    }),
  );
  // Keep each site's order; groupHits alone would move multi-source series first and bury "latest".
  return { groups: interleaveGroups(lists), failed, searched: sources.length };
}

/** Tags that describe the format, status or language, not the story; they make poor "similar to" seeds. */
const FORMAT_TAGS = new Set(
  [
    "manhwa", "manhua", "manga", "webtoon", "webtoons", "comic", "full color", "long strip", "adult", "mature",
    "ongoing", "completed", "hiatus", "oneshot", "one shot", "doujinshi", "web comic", "translated", "english",
    "japanese", "chinese", "korean", "rough translation", "full censorship", "mosaic censorship", "uncensored",
    "multi-work series", "artbook", "anthology",
  ].map(canonKey),
);

// Before Sapphire has seen enough series to learn which tags are common, these are known to be on a
// big share of everything, so they say little about what makes a series what it is.
const VERY_COMMON = new Set(
  [
    "action", "romance", "comedy", "drama", "fantasy", "adventure", "school life", "slice of life", "supernatural",
    "shounen", "seinen", "shoujo", "josei", "harem", "sole female", "sole male", "big breasts", "nakadashi",
    "blowjob", "group", "stockings", "schoolgirl uniform", "kissing",
  ].map(canonKey),
);

/** What Sapphire knows about tags: how telling each is, and the tags of series it has already seen. */
export interface TagKnowledge {
  weight(tag: string): number;
  tagsOf(mangaId: number): string[] | null;
}

/**
 * Turns "how many known series carry each tag" into how telling a tag is: a tag on nearly every
 * series (sites usually list those first, because they have the biggest counts) is worth little,
 * a rare one a lot. Falls back to a built-in list of common tags until enough series have been seen.
 */
export function tagWeights(stats: { total: number; counts: Map<string, number> }): (tag: string) => number {
  return (tag) => {
    const key = canonKey(tag);
    const fallback = VERY_COMMON.has(key) ? 0.4 : 1;
    if (stats.total < 30) return fallback;
    const count = stats.counts.get(key) ?? 0;
    const idf = Math.log((stats.total + 1) / (count + 1));
    return Math.max(0.02, idf / Math.log(stats.total + 1)) * (VERY_COMMON.has(key) ? 0.7 : 1);
  };
}

/** Similar shows a handful, not a feed. */
const LIMIT = 8;
/** Similar series hands back more than it needs, so the page can fill whole rows at any width. */
const SIMILAR_MAX = 24;

const plainKnowledge: TagKnowledge = { weight: tagWeights({ total: 0, counts: new Map() }), tagsOf: () => null };

/**
 * Series like this one. Its tags are ranked by how telling they are (rare tags first), the best few
 * are searched in pairs (and alone if that finds too little), and every candidate is scored by the
 * weight of the tags it shares with this series, using its full tag list when Sapphire has seen it.
 */
export async function similarTo(
  config: Config,
  title: string,
  genres: string[],
  opts: { fetchImpl?: FetchLike; onResult?: SourceReport; scope?: Scope; knowledge?: TagKnowledge; selfId?: number } = {},
): Promise<{ groups: SeriesGroup[]; basedOn: string[] }> {
  const { knowledge = plainKnowledge, selfId, ...browseOpts } = opts;
  const seen = new Set<string>();
  const tags = genres.filter((g) => {
    const k = canonKey(g);
    if (!k || FORMAT_TAGS.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Stable sort, so equally telling tags keep the site's order.
  const ranked = tags.map((t, i) => ({ t, w: knowledge.weight(t), i })).sort((a, b) => b.w - a.w || a.i - b.i);
  const seeds = ranked.slice(0, 3).map((r) => r.t);
  if (seeds.length === 0) return { groups: [], basedOn: [] };
  const own = new Map(ranked.map((r) => [canonKey(r.t), r.w]));
  const self = normalizeTitle(title);

  const candidates = new Map<string, { group: SeriesGroup; matched: Set<string>; hits: number; first: number }>();
  let order = 0;
  const run = async (queries: string[][]) => {
    const results = await Promise.all(
      queries.map((q) => browseByGenres(config, q, { ...browseOpts, strict: true, timeoutMs: 8000 }).catch(() => null)),
    );
    // A site that returns the same list for different genre picks is ignoring the filter (some
    // extensions' genre filters are broken), so its results say nothing about these tags.
    const perSource = new Map<string, string[]>();
    for (const r of results) {
      const ids = new Map<string, number[]>();
      for (const g of r?.groups ?? []) for (const h of g.hits) ids.set(h.sourceId, [...(ids.get(h.sourceId) ?? []), h.mangaId]);
      for (const [src, list] of ids) perSource.set(src, [...(perSource.get(src) ?? []), list.slice(0, 6).join(",")]);
    }
    const ignoring = new Set([...perSource].filter(([, lists]) => lists.length > 1 && new Set(lists).size === 1).map(([src]) => src));
    results.forEach((r, qi) => {
      for (const raw of r?.groups ?? []) {
        const hits = raw.hits.filter((h) => !ignoring.has(h.sourceId));
        if (hits.length === 0) continue;
        const g = { ...raw, hits };
        if (g.key === self || g.hits.some((h) => h.mangaId === selfId)) continue;
        const c = candidates.get(g.key) ?? { group: g, matched: new Set<string>(), hits: 0, first: order++ };
        for (const t of queries[qi]) c.matched.add(canonKey(t));
        c.hits++;
        candidates.set(g.key, c);
      }
    });
  };
  const pairs: string[][] = [];
  for (let a = 0; a < seeds.length; a++) for (let b = a + 1; b < seeds.length; b++) pairs.push([seeds[a], seeds[b]]);
  await run(pairs.length > 0 ? pairs : [[seeds[0]]]);
  if (candidates.size < LIMIT && pairs.length > 0) await run(seeds.slice(0, 2).map((t) => [t]));

  const score = (c: { group: SeriesGroup; matched: Set<string> }) => {
    const known = c.group.hits.map((h) => knowledge.tagsOf(h.mangaId)).find((t) => t !== null);
    const shared = known ? new Set(known.map(canonKey)) : c.matched;
    let total = 0;
    for (const k of shared) total += own.get(k) ?? 0;
    return total;
  };
  // Anything that shares none of this series' tags doesn't belong, whatever the site returned.
  const scored = [...candidates.values()].map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || b.c.hits - a.c.hits || a.c.first - b.c.first);
  return { groups: scored.slice(0, SIMILAR_MAX).map((x) => x.c.group), basedOn: seeds };
}

/** Picks to try for the "For you" page: your top genres on their own, then the top two together. */
export function recommendationQueries(profile: { genre: string }[]): string[][] {
  const top = profile.slice(0, 3).map((p) => p.genre);
  const queries: string[][] = [];
  if (top.length >= 2) queries.push([top[0], top[1]]);
  for (const g of top) queries.push([g]);
  return queries;
}

export async function recommendFor(
  config: Config,
  profile: { genre: string }[],
  ownTitles: string[],
  opts: { fetchImpl?: FetchLike; onResult?: SourceReport; scope?: Scope } = {},
): Promise<{ groups: SeriesGroup[]; because: string[] }> {
  const queries = recommendationQueries(profile);
  if (queries.length === 0) return { groups: [], because: [] };
  const own = new Set(ownTitles.map(normalizeTitle));
  const results = await Promise.all(queries.map((q) => browseByGenres(config, q, { ...opts, strict: true }).catch(() => null)));
  // Series that match the combined query come first, then each single-genre list in turn.
  const seen = new Set<string>();
  const merged: SeriesGroup[] = [];
  for (let rank = 0; merged.length < 40; rank++) {
    let any = false;
    for (const r of results) {
      const g = r?.groups[rank];
      if (!g) continue;
      any = true;
      if (own.has(g.key) || seen.has(g.key)) continue;
      seen.add(g.key);
      merged.push(g);
    }
    if (!any) break;
  }
  return { groups: merged, because: profile.slice(0, 3).map((p) => p.genre) };
}
