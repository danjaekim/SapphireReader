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
export async function ratingsFor(store: Store, titles: string[], fetchImpl?: FetchLike): Promise<Map<string, AnilistMeta>> {
  const keys = [...new Set(titles.map(normalizeTitle).filter(Boolean))];
  const known = store.anilistMeta(keys);
  const now = Date.now();
  const stale = keys.filter((k) => {
    const m = known.get(k);
    if (!m) return true;
    return now - Date.parse(m.fetchedAt) > (m.anilistId === null ? MISS_MS : FRESH_MS);
  });
  const titleFor = new Map(titles.map((t) => [normalizeTitle(t), t]));
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    const query = `query (${batch.map((_, j) => `$t${j}: String`).join(", ")}) {
      ${batch.map((_, j) => `m${j}: Media(search: $t${j}, type: MANGA) { id averageScore meanScore popularity bannerImage }`).join("\n")}
    }`;
    const variables = Object.fromEntries(batch.map((k, j) => [`t${j}`, titleFor.get(k) ?? k]));
    try {
      // A title AniList can't find makes that alias null (with an error), not the whole answer.
      const data = await anilistLoose(query, variables, fetchImpl);
      batch.forEach((k, j) => {
        const m = data[`m${j}`];
        const meta: AnilistMeta = m
          ? { anilistId: m.id, score: m.averageScore ?? m.meanScore ?? null, popularity: m.popularity ?? null, banner: m.bannerImage ?? null }
          : { anilistId: null, score: null, popularity: null, banner: null };
        store.putAnilistMeta(k, meta);
        known.set(k, { ...meta, fetchedAt: new Date().toISOString() });
      });
    } catch {
      break; // AniList is busy or down; use what we have.
    }
  }
  return new Map([...known].map(([k, v]) => [k, { anilistId: v.anilistId, score: v.score, popularity: v.popularity, banner: v.banner ?? null }]));
}

type MediaHit = { id: number; averageScore: number | null; meanScore: number | null; popularity: number | null; bannerImage?: string | null } | null;

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
  const meta = await ratingsFor(store, groups.slice(0, 60).map((g) => g.title), fetchImpl).catch(() => new Map<string, AnilistMeta>());
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
