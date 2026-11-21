import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";
import { browseByGenres } from "./browse.js";
import { canonKey } from "./genres.js";
import {
  interleaveGroups,
  listSources,
  scopedSources,
  normalizeTitle,
  type EngineSource,
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
  opts: { fetchImpl?: FetchLike; scope?: Scope; onResult?: SourceReport; timeoutMs?: number; page?: number; only?: (s: EngineSource) => boolean } = {},
): Promise<SearchResult> {
  const { fetchImpl, scope = "safe", onResult, timeoutMs = 10000, page = 1, only } = opts;
  const sources = scopedSources(await listSources(config, fetchImpl), scope, only);
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

/** A series you like, and how strongly (more for ones you've read, and read lately). */
export interface LikedSeries {
  mangaId: number;
  title: string;
  tags: string[];
  weight: number;
}

/** One row of "For you": series with this mix of tags, because of the series you read with it. */
export interface Shelf {
  tags: string[];
  /** The series of yours that best shows this taste, for "Because you read …". */
  from: string;
  groups: SeriesGroup[];
}

const SHELVES = 5;
const PER_SHELF = 18;

/**
 * How much each tag says about your taste: the sum, over the series you like, of how much you like
 * that series times how telling the tag is (rare tags count for more than ones on everything).
 */
export function tasteWeights(liked: LikedSeries[], weight: (tag: string) => number, hidden: Set<string> = new Set()) {
  const out = new Map<string, { tag: string; w: number }>();
  for (const s of liked) {
    const seen = new Set<string>();
    for (const t of s.tags) {
      const k = canonKey(t);
      if (!k || FORMAT_TAGS.has(k) || hidden.has(k) || seen.has(k)) continue;
      seen.add(k);
      const e = out.get(k) ?? { tag: t, w: 0 };
      e.w += s.weight * weight(t);
      out.set(k, e);
    }
  }
  return out;
}

/**
 * The mixes of tags to look for. Each series you like votes for the pair of its tags that best
 * describe it (telling for that series and part of your overall taste), so "Murim + Regression"
 * from one series and "Romance + Villainess" from another become separate rows instead of one
 * blend. Rows that would repeat a tag too often are skipped, so the page covers more of your taste.
 */
export function planShelves(liked: LikedSeries[], weight: (tag: string) => number, hidden: Set<string> = new Set()): { tags: string[]; from: string }[] {
  const taste = tasteWeights(liked, weight, hidden);
  const combos = new Map<string, { tags: string[]; score: number; from: { title: string; w: number } }>();
  for (const s of liked) {
    const own = [...new Set(s.tags.map(canonKey))]
      .filter((k) => taste.has(k))
      .map((k) => ({ k, tag: taste.get(k)!.tag, w: weight(taste.get(k)!.tag) * Math.sqrt(taste.get(k)!.w) }))
      .sort((a, b) => b.w - a.w);
    if (own.length === 0) continue;
    // The series' best pair, and its next-best, so a series with several sides can seed more than one row.
    const picks = own.length === 1 ? [[own[0]]] : [[own[0], own[1]], ...(own.length > 2 ? [[own[0], own[2]]] : [])];
    picks.forEach((pick, i) => {
      const key = pick.map((p) => p.k).sort().join("+");
      const vote = s.weight * (i === 0 ? 1 : 0.6) * pick.reduce((n, p) => n + p.w, 0);
      const c = combos.get(key) ?? { tags: pick.map((p) => p.tag), score: 0, from: { title: s.title, w: 0 } };
      c.score += vote;
      if (vote > c.from.w) c.from = { title: s.title, w: vote };
      combos.set(key, c);
    });
  }
  const ranked = [...combos.values()].sort((a, b) => b.score - a.score);
  const used = new Map<string, number>();
  const chosen: { tags: string[]; from: string }[] = [];
  for (const c of ranked) {
    if (chosen.length >= SHELVES) break;
    const keys = c.tags.map(canonKey);
    if (keys.some((k) => (used.get(k) ?? 0) >= 2)) continue;
    if (chosen.some((x) => x.tags.map(canonKey).sort().join("+") === keys.slice().sort().join("+"))) continue;
    keys.forEach((k) => used.set(k, (used.get(k) ?? 0) + 1));
    chosen.push({ tags: c.tags, from: c.from.title });
  }
  return chosen;
}

/**
 * "For you": a row per mix of tags you like (see planShelves). Each row's candidates are ranked by
 * how much of your taste their full tag list covers (when Sapphire has seen it), and a series shows
 * up in one row only.
 */
export async function recommendShelves(
  config: Config,
  liked: LikedSeries[],
  ownTitles: string[],
  opts: { fetchImpl?: FetchLike; onResult?: SourceReport; scope?: Scope; knowledge?: TagKnowledge; hidden?: Set<string> } = {},
): Promise<{ shelves: Shelf[]; groups: SeriesGroup[]; because: string[] }> {
  const { knowledge = plainKnowledge, hidden = new Set<string>(), ...browseOpts } = opts;
  const plan = planShelves(liked, knowledge.weight, hidden);
  const taste = tasteWeights(liked, knowledge.weight, hidden);
  const because = [...taste.values()].sort((a, b) => b.w - a.w).slice(0, 3).map((t) => t.tag);
  if (plan.length === 0) return { shelves: [], groups: [], because: [] };
  const own = new Set(ownTitles.map(normalizeTitle));
  const ownIds = new Set(liked.map((l) => l.mangaId));
  const results = await Promise.all(plan.map((p) => browseByGenres(config, p.tags, { ...browseOpts, strict: true, timeoutMs: 9000 }).catch(() => null)));

  const fit = (g: SeriesGroup, fallback: string[]) => {
    const known = g.hits.map((h) => knowledge.tagsOf(h.mangaId)).find((t) => t !== null);
    const keys = new Set((known ?? fallback).map(canonKey));
    if ([...keys].some((k) => hidden.has(k))) return -1;
    let total = 0;
    for (const k of keys) total += taste.get(k)?.w ?? 0;
    return total;
  };
  const taken = new Set<string>();
  const shelves: Shelf[] = [];
  // Rows take turns picking, so the first row doesn't claim every series that fits several.
  const pools = results.map((r, i) =>
    (r?.groups ?? [])
      .filter((g) => !own.has(g.key) && !g.hits.some((h) => ownIds.has(h.mangaId)))
      .map((g, rank) => ({ g, s: fit(g, plan[i].tags), rank }))
      .filter((x) => x.s >= 0)
      // Fit first, then the site's own order (its popularity) as the tie-break.
      .sort((a, b) => b.s - a.s || a.rank - b.rank),
  );
  const rows: SeriesGroup[][] = plan.map(() => []);
  for (let round = 0; round < PER_SHELF; round++) {
    pools.forEach((pool, i) => {
      while (pool.length > 0) {
        const next = pool.shift()!;
        if (taken.has(next.g.key)) continue;
        taken.add(next.g.key);
        rows[i].push(next.g);
        break;
      }
    });
  }
  plan.forEach((p, i) => {
    if (rows[i].length > 0) shelves.push({ tags: p.tags, from: p.from, groups: rows[i] });
  });
  // One flat list too (the home page shows a single row): the rows' picks, taking turns.
  const groups: SeriesGroup[] = [];
  for (let i = 0; groups.length < 40; i++) {
    let any = false;
    for (const s of shelves) if (s.groups[i]) { groups.push(s.groups[i]); any = true; }
    if (!any) break;
  }
  return { shelves, groups, because };
}
