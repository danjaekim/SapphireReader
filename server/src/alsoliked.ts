import type { Config } from "./config.js";
import { ratingsFor } from "./ratings.js";
import { normalizeTitle, searchAll, type Scope, type SeriesGroup, type SourceReport } from "./search.js";
import type { Store } from "./store.js";
import { anilist } from "./tracker.js";

type FetchLike = typeof fetch;

/** A series AniList readers recommend, before it's been found on your sources. */
export interface AnilistRec {
  id: number;
  titles: string[];
  adult: boolean;
  rating: number;
}

const RECS_TTL = 7 * 24 * 3600 * 1000;
const MATCH_TTL = 7 * 24 * 3600 * 1000;
/** How many of your series get a row, and how many of each one's recommendations are looked up. */
const SEEDS = 3;
const PER_SEED = 8;

type RecsAnswer = Record<string, { recommendations: { nodes: { rating: number; mediaRecommendation: { id: number; isAdult: boolean | null; synonyms: string[] | null; title: { romaji: string | null; english: string | null; native: string | null } } | null }[] } } | null>;

/**
 * AniList's community recommendations ("readers of this also liked") for several series in one
 * request, best rated first. Remembered for a week per series.
 */
export async function anilistRecommendations(store: Store, ids: number[], fetchImpl?: FetchLike): Promise<Map<number, AnilistRec[]>> {
  const out = new Map<number, AnilistRec[]>();
  const todo: number[] = [];
  for (const id of ids) {
    try {
      const c = JSON.parse(store.getSetting(`anilist_recs.${id}`) ?? "null") as { at: number; recs: AnilistRec[] } | null;
      if (c && Date.now() - c.at < RECS_TTL) out.set(id, c.recs);
      else todo.push(id);
    } catch {
      todo.push(id);
    }
  }
  if (todo.length === 0) return out;
  const query = `query (${todo.map((_, i) => `$i${i}: Int`).join(", ")}) {
    ${todo
      .map(
        (_, i) => `m${i}: Media(id: $i${i}, type: MANGA) { recommendations(sort: RATING_DESC, perPage: 15) { nodes { rating mediaRecommendation { id isAdult synonyms title { romaji english native } } } } }`,
      )
      .join("\n")}
  }`;
  try {
    const data = await anilist<RecsAnswer>(query, Object.fromEntries(todo.map((id, i) => [`i${i}`, id])), null, fetchImpl);
    todo.forEach((id, i) => {
      const nodes = data[`m${i}`]?.recommendations.nodes ?? [];
      const recs = nodes
        .filter((n) => n.mediaRecommendation && n.rating > 0)
        .map((n) => {
          const m = n.mediaRecommendation!;
          const titles = [m.title.english, m.title.romaji, ...(m.synonyms ?? []), m.title.native].filter((t): t is string => !!t && t.trim().length > 0);
          return { id: m.id, titles: [...new Set(titles)], adult: m.isAdult === true, rating: n.rating };
        })
        .filter((r) => r.titles.length > 0);
      store.setSetting(`anilist_recs.${id}`, JSON.stringify({ at: Date.now(), recs }));
      out.set(id, recs);
    });
  } catch {
    // AniList is busy or down: rows from it just don't show this time.
  }
  return out;
}

/**
 * Finds an AniList series on your sources: searches its English (or romaji) name and keeps the
 * result whose title matches one of its names exactly (after normalizing), so a near miss never
 * stands in for it. Remembered for a week, misses included.
 */
async function findOnSources(
  config: Config,
  store: Store,
  rec: AnilistRec,
  opts: { fetchImpl?: FetchLike; scope: Scope; onResult?: SourceReport },
): Promise<SeriesGroup | null> {
  const key = `anilist_match.${opts.scope}.${rec.id}`;
  try {
    const c = JSON.parse(store.getSetting(key) ?? "null") as { at: number; group: SeriesGroup | null } | null;
    if (c && Date.now() - c.at < MATCH_TTL) return c.group;
  } catch {
    // Look it up again.
  }
  const names = new Set(rec.titles.map(normalizeTitle).filter(Boolean));
  let group: SeriesGroup | null = null;
  // Latin-script names search best on English sites; try the first two.
  for (const q of rec.titles.filter((t) => /[a-z]/i.test(t)).slice(0, 2)) {
    const res = await searchAll(config, q, { fetchImpl: opts.fetchImpl, scope: opts.scope, onResult: opts.onResult, timeoutMs: 8000 }).catch(() => null);
    group = res?.groups.find((g) => names.has(g.key) || g.hits.some((h) => names.has(normalizeTitle(h.title)))) ?? null;
    if (group) break;
  }
  store.setSetting(key, JSON.stringify({ at: Date.now(), group }));
  return group;
}

export interface AlsoLikedRow {
  from: string;
  groups: SeriesGroup[];
}

/**
 * "Readers of X also liked": for the series you like most (read lately counts most), AniList's
 * community recommendations that are on your sources and not already yours.
 */
export async function alsoLiked(
  config: Config,
  store: Store,
  liked: { mangaId: number; title: string; weight: number }[],
  opts: { fetchImpl?: FetchLike; scope: Scope; onResult?: SourceReport; skip: (g: SeriesGroup) => boolean },
): Promise<AlsoLikedRow[]> {
  const top = [...liked].sort((a, b) => b.weight - a.weight).slice(0, SEEDS * 2);
  const meta = await ratingsFor(store, top.map((t) => t.title), opts.fetchImpl, {}, false).catch(() => new Map());
  const seeds = top
    .map((t) => ({ ...t, anilistId: meta.get(normalizeTitle(t.title))?.anilistId as number | null | undefined }))
    .filter((t): t is typeof t & { anilistId: number } => typeof t.anilistId === "number")
    .slice(0, SEEDS);
  if (seeds.length === 0) return [];
  const recs = await anilistRecommendations(store, seeds.map((s) => s.anilistId), opts.fetchImpl);
  const shown = new Set<string>();
  const rows: AlsoLikedRow[] = [];
  for (const seed of seeds) {
    const wanted = (recs.get(seed.anilistId) ?? []).filter((r) => opts.scope === "adult" || !r.adult).slice(0, PER_SEED);
    const found: SeriesGroup[] = [];
    // A few at a time: each one searches every source.
    for (let i = 0; i < wanted.length; i += 3) {
      const batch = await Promise.all(wanted.slice(i, i + 3).map((r) => findOnSources(config, store, r, opts).catch(() => null)));
      for (const g of batch) {
        if (!g || shown.has(g.key) || opts.skip(g)) continue;
        shown.add(g.key);
        found.push(g);
      }
    }
    if (found.length > 0) rows.push({ from: seed.title, groups: found });
  }
  return rows;
}
