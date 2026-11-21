import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";
import { browseByGenres } from "./browse.js";
import {
  groupHits,
  listSources,
  inScope,
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
  const sources = (await listSources(config, fetchImpl)).filter((s) => inScope(s, scope));
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
  const interleaved: SourceHit[] = [];
  for (let rank = 0; lists.some((l) => rank < l.length); rank++) {
    for (const l of lists) if (rank < l.length) interleaved.push(l[rank]);
  }
  // Keep the interleaved order; groupHits would move multi-source series first, which is fine
  // for search but would bury "latest" ordering here.
  const groups = groupHits(interleaved);
  const order = new Map(interleaved.map((h, i) => [normalizeTitle(h.title), i]));
  groups.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  return { groups, failed, searched: sources.length };
}

/** Series like this one: the same top genres, minus the series itself. */
export async function similarTo(
  config: Config,
  title: string,
  genres: string[],
  opts: { fetchImpl?: FetchLike; onResult?: SourceReport; scope?: Scope } = {},
): Promise<SeriesGroup[]> {
  if (genres.length === 0) return [];
  const self = normalizeTitle(title);
  const picks = genres.slice(0, 2);
  const result = await browseByGenres(config, picks, opts);
  return result.groups.filter((g) => g.key !== self).slice(0, 30);
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
  const results = await Promise.all(queries.map((q) => browseByGenres(config, q, opts).catch(() => null)));
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
