import { anilist } from "./tracker.js";
import { normalizeTitle, type SeriesGroup } from "./search.js";
import type { AnilistMeta, Store } from "./store.js";

type FetchLike = typeof fetch;

/** Known for a month; a title AniList doesn't know is asked about again after a week. */
const FRESH_MS = 30 * 24 * 3600 * 1000;
const MISS_MS = 7 * 24 * 3600 * 1000;
const BATCH = 20;

/**
 * Looks up AniList's average score and popularity for many titles at once (one request per 20,
 * using aliases), remembering answers so each title is only asked about now and then.
 */
const MU_LOOKUPS_PER_CALL = 8;

export type RatingMeta = AnilistMeta & { mu?: number | null };

/** Asks AniList about several titles in one request; each answer is the best match or null. */
async function anilistBatch(titles: string[], fetchImpl?: FetchLike): Promise<(NonNullable<MediaHit> | null)[]> {
  const query = `query (${titles.map((_, j) => `$t${j}: String`).join(", ")}) {
    ${titles.map((_, j) => `m${j}: Media(search: $t${j}, type: MANGA) { id averageScore meanScore popularity bannerImage isAdult }`).join("\n")}
  }`;
  // A title AniList can't find makes that alias null (with an error), not the whole answer.
  const data = await anilistLoose(query, Object.fromEntries(titles.map((t, j) => [`t${j}`, t])), fetchImpl);
  return titles.map((_, j) => data[`m${j}`] ?? null);
}

const toMeta = (m: NonNullable<MediaHit> | null): AnilistMeta =>
  m ? { anilistId: m.id, score: m.averageScore ?? m.meanScore ?? null, popularity: m.popularity ?? null, banner: m.bannerImage ?? null, adult: m.isAdult ?? null } : { anilistId: null, score: null, popularity: null, banner: null, adult: null };

/** Other names worth trying on AniList: native-script names first (they match exactly), then the rest. */
function altCandidates(title: string, alts: string[] | undefined): string[] {
  const own = normalizeTitle(title);
  const list = (alts ?? []).filter((a) => a.length >= 2 && normalizeTitle(a) !== own);
  const native = list.filter((a) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(a));
  return [...new Set([...native, ...list])].slice(0, 3);
}

/**
 * MangaUpdates search (no account needed). Only an exact title match counts, so a near miss never
 * lends a series someone else's rating. Its "bayesian" rating is out of 10.
 */
async function mangaUpdatesRating(names: string[], fetchImpl: FetchLike = fetch): Promise<{ seriesId: number; score: number | null } | null> {
  const wanted = new Set(names.map(normalizeTitle).filter(Boolean));
  const res = await fetchImpl("https://api.mangaupdates.com/v1/series/search", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "sapphire" },
    body: JSON.stringify({ search: names[0], perpage: 10 }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`MangaUpdates answered ${res.status}`);
  const json = (await res.json()) as { results?: { hit_title?: string; record?: { series_id?: number; title?: string; bayesian_rating?: number | string | null } }[] };
  for (const r of json.results ?? []) {
    const rec = r.record;
    if (!rec?.series_id) continue;
    if (wanted.has(normalizeTitle(r.hit_title ?? "")) || wanted.has(normalizeTitle(rec.title ?? ""))) {
      const score = rec.bayesian_rating == null ? null : Number(rec.bayesian_rating);
      return { seriesId: rec.series_id, score: score && Number.isFinite(score) && score > 0 ? score : null };
    }
  }
  return null;
}

/**
 * Looks up ratings for many titles at once, remembering answers so each title is only asked about
 * now and then. AniList first (one request per 20, using aliases); titles it doesn't know are tried
 * again by their other names, and then on MangaUpdates.
 */
export async function ratingsFor(
  store: Store,
  titles: string[],
  fetchImpl?: FetchLike,
  alts: Record<string, string[]> = {},
  useMangaUpdates = true,
): Promise<Map<string, RatingMeta>> {
  const keys = [...new Set(titles.map(normalizeTitle).filter(Boolean))];
  const known = store.anilistMeta(keys);
  const now = Date.now();
  const stale = keys.filter((k) => {
    const m = known.get(k);
    if (!m) return true;
    return now - Date.parse(m.fetchedAt) > (m.anilistId === null ? MISS_MS : FRESH_MS);
  });
  const titleFor = new Map(titles.map((t) => [normalizeTitle(t), t]));
  const altsFor = (k: string) => altCandidates(titleFor.get(k) ?? k, alts[titleFor.get(k) ?? k]);
  const save = (k: string, meta: AnilistMeta) => {
    store.putAnilistMeta(k, meta);
    known.set(k, { ...meta, fetchedAt: new Date().toISOString() });
  };
  try {
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      const hits = await anilistBatch(batch.map((k) => titleFor.get(k) ?? k), fetchImpl);
      const missed: string[] = [];
      batch.forEach((k, j) => (hits[j] ? save(k, toMeta(hits[j])) : missed.push(k)));
      // Try the misses' other names (Korean/Japanese names match AniList's native titles well).
      const tries = missed.flatMap((k) => altsFor(k).map((a) => ({ k, a })));
      const found = new Set<string>();
      for (let t = 0; t < tries.length; t += BATCH) {
        const chunk = tries.slice(t, t + BATCH);
        const altHits = await anilistBatch(chunk.map((x) => x.a), fetchImpl);
        chunk.forEach((x, j) => {
          if (altHits[j] && !found.has(x.k)) {
            found.add(x.k);
            save(x.k, toMeta(altHits[j]));
          }
        });
      }
      for (const k of missed) if (!found.has(k)) save(k, toMeta(null));
    }
  } catch {
    /* AniList is busy or down; use what we have. */
  }

  // Still no score: ask MangaUpdates, a few titles per call so a big list doesn't hammer it.
  const noScore = useMangaUpdates ? keys.filter((k) => known.get(k)?.score == null) : [];
  const mu = store.muMeta(noScore);
  const muStale = noScore.filter((k) => {
    const m = mu.get(k);
    return !m || now - Date.parse(m.fetchedAt) > (m.seriesId === null ? MISS_MS : FRESH_MS);
  });
  const queue = muStale.slice(0, MU_LOOKUPS_PER_CALL);
  let down = false;
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let k = queue.shift(); k !== undefined && !down; k = queue.shift()) {
        try {
          const hit = await mangaUpdatesRating([titleFor.get(k) ?? k, ...(alts[titleFor.get(k) ?? k] ?? [])], fetchImpl);
          store.putMuMeta(k, hit?.seriesId ?? null, hit?.score ?? null);
          mu.set(k, { seriesId: hit?.seriesId ?? null, score: hit?.score ?? null, fetchedAt: new Date().toISOString() });
        } catch {
          down = true; // MangaUpdates is busy or down; try again another time.
        }
      }
    }),
  );

  return new Map(
    [...known].map(([k, v]) => [k, { anilistId: v.anilistId, score: v.score, popularity: v.popularity, banner: v.banner ?? null, mu: mu.get(k)?.score ?? null }]),
  );
}

type MediaHit = { id: number; averageScore: number | null; meanScore: number | null; popularity: number | null; bannerImage?: string | null; isAdult?: boolean | null } | null;

async function anilistLoose(query: string, variables: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<Record<string, MediaHit>> {
  const res = await fetchImpl("https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: Record<string, MediaHit> };
  if (!json.data) throw new Error(`AniList answered ${res.status}`);
  return json.data;
}

/**
 * Adds AniList score and popularity to result groups and, for "rating" or "popular", orders by them
 * (series AniList doesn't know keep their place after the ones it does).
 */
export async function rankByAnilist(
  store: Store,
  groups: SeriesGroup[],
  sort: "rating" | "popular" | null,
  fetchImpl?: FetchLike,
): Promise<(SeriesGroup & { score?: number | null; popularity?: number | null })[]> {
  const meta = await ratingsFor(store, groups.slice(0, 60).map((g) => g.title), fetchImpl, {}, false).catch(() => new Map<string, AnilistMeta>());
  const out = groups.map((g, i) => {
    const m = meta.get(g.key) ?? meta.get(normalizeTitle(g.title));
    return { ...g, score: m?.score ?? null, popularity: m?.popularity ?? null, i };
  });
  if (sort) {
    const val = (x: (typeof out)[number]) => (sort === "rating" ? x.score : x.popularity);
    out.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va == null && vb == null) return a.i - b.i;
      if (va == null) return 1;
      if (vb == null) return -1;
      return vb - va || a.i - b.i;
    });
  }
  return out.map(({ i: _i, ...g }) => g);
}

// Kept for typing of the shared helper.
void anilist;
