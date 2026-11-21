import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";

type FetchLike = typeof fetch;

export interface EngineSource {
  id: string;
  name: string;
  lang: string;
  isNsfw: boolean;
}

export interface SourceHit {
  mangaId: number;
  sourceId: string;
  sourceName: string;
  title: string;
  thumbnailUrl: string | null;
}

export interface SeriesGroup {
  key: string;
  title: string;
  hits: SourceHit[];
}

export interface SearchResult {
  groups: SeriesGroup[];
  /** Sources that failed or timed out, so the UI can say results may be incomplete. */
  failed: { sourceName: string; error: string }[];
  searched: number;
}

/** Lowercases and strips punctuation and spacing so "Solo Leveling!" matches "solo leveling". */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function groupHits(hits: SourceHit[]): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>();
  for (const hit of hits) {
    const key = normalizeTitle(hit.title);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.hits.push(hit);
    else groups.set(key, { key, title: hit.title, hits: [hit] });
  }
  // Series found on more sources come first; ties keep each source's own ranking.
  return [...groups.values()].sort((a, b) => b.hits.length - a.hits.length);
}

const SOURCES_QUERY = `{ sources { nodes { id name lang isNsfw } } }`;

export async function listSources(config: Config, fetchImpl?: FetchLike): Promise<EngineSource[]> {
  const data = await engineQuery<{ sources: { nodes: EngineSource[] } }>(
    config,
    SOURCES_QUERY,
    {},
    { fetchImpl },
  );
  return data.sources.nodes;
}

const SEARCH_MUTATION = `
  mutation ($input: FetchSourceMangaInput!) {
    fetchSourceManga(input: $input) {
      mangas { id title thumbnailUrl }
    }
  }`;

export async function searchAll(
  config: Config,
  query: string,
  opts: { fetchImpl?: FetchLike; includeNsfw?: boolean; timeoutMs?: number } = {},
): Promise<SearchResult> {
  const { fetchImpl, includeNsfw = false, timeoutMs = 8000 } = opts;
  const all = await listSources(config, fetchImpl);
  // English and multi-language sources only; 18+ sources stay out until 18+ mode exists.
  const sources = all.filter((s) => (s.lang === "en" || s.lang === "all") && (includeNsfw || !s.isNsfw));

  const failed: SearchResult["failed"] = [];
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const data = await engineQuery<{
          fetchSourceManga: { mangas: { id: number; title: string; thumbnailUrl: string | null }[] };
        }>(
          config,
          SEARCH_MUTATION,
          { input: { source: source.id, type: "SEARCH", page: 1, query } },
          { fetchImpl, timeoutMs },
        );
        return data.fetchSourceManga.mangas.map<SourceHit>((m) => ({
          mangaId: m.id,
          sourceId: source.id,
          sourceName: source.name,
          title: m.title,
          thumbnailUrl: m.thumbnailUrl,
        }));
      } catch (err) {
        failed.push({
          sourceName: source.name,
          error: err instanceof Error ? err.message : "unknown error",
        });
        return [];
      }
    }),
  );

  return { groups: groupHits(results.flat()), failed, searched: sources.length };
}

const CHAPTERS_MUTATION = `
  mutation ($input: FetchChaptersInput!) {
    fetchChapters(input: $input) {
      chapters { chapterNumber uploadDate }
    }
  }`;

export interface LatestChapter {
  chapterCount: number;
  latestNumber: number | null;
  latestUploadDate: string | null;
}

/** Fetches the chapter list from the source and returns the highest chapter number. */
export async function latestChapter(
  config: Config,
  mangaId: number,
  fetchImpl?: FetchLike,
): Promise<LatestChapter> {
  const data = await engineQuery<{
    fetchChapters: { chapters: { chapterNumber: number; uploadDate: string | number }[] };
  }>(config, CHAPTERS_MUTATION, { input: { mangaId } }, { fetchImpl, timeoutMs: 30000 });

  const chapters = data.fetchChapters.chapters;
  // Extensions report chapterNumber -1 when they can't parse a number; ignore those.
  const numbered = chapters.filter((c) => c.chapterNumber >= 0);
  if (numbered.length === 0) {
    return { chapterCount: chapters.length, latestNumber: null, latestUploadDate: null };
  }
  const latest = numbered.reduce((a, b) => (b.chapterNumber > a.chapterNumber ? b : a));
  const uploaded = Number(latest.uploadDate);
  return {
    chapterCount: chapters.length,
    latestNumber: latest.chapterNumber,
    latestUploadDate: uploaded > 0 ? new Date(uploaded).toISOString() : null,
  };
}
