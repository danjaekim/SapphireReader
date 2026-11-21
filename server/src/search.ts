import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";

type FetchLike = typeof fetch;

/** Which sources a request may use: ordinary ones, 18+ ones only, or both. */
export type Scope = "safe" | "adult" | "all";

export function inScope(s: EngineSource, scope: Scope): boolean {
  return (s.lang === "en" || s.lang === "all") && (scope === "all" || (scope === "adult" ? s.isNsfw : !s.isNsfw));
}

export interface EngineSource {
  id: string;
  name: string;
  lang: string;
  isNsfw: boolean;
}

/** Called once per source with how it answered, for health tracking. */
export type SourceReport = (source: EngineSource, r: { ok: boolean; ms: number; error?: string }) => void;

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

export const groupKey = normalizeTitle;

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

/**
 * Merges each source's list rank by rank (every site's #1, then every #2...), so each site's own
 * order is kept and no single site fills the page. Groups keep that order.
 */
export function interleaveGroups(lists: SourceHit[][]): SeriesGroup[] {
  const interleaved: SourceHit[] = [];
  for (let rank = 0; lists.some((l) => rank < l.length); rank++) {
    for (const l of lists) if (rank < l.length) interleaved.push(l[rank]);
  }
  const groups = groupHits(interleaved);
  const order = new Map<string, number>();
  interleaved.forEach((h, i) => {
    const k = normalizeTitle(h.title);
    if (!order.has(k)) order.set(k, i);
  });
  return groups.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
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
  opts: { fetchImpl?: FetchLike; scope?: Scope; timeoutMs?: number; onResult?: SourceReport; page?: number } = {},
): Promise<SearchResult> {
  const { fetchImpl, scope = "safe", timeoutMs = 8000, onResult, page = 1 } = opts;
  const all = await listSources(config, fetchImpl);
  // English and multi-language sources only; 18+ sources are used only when 18+ mode is unlocked.
  const sources = all.filter((s) => inScope(s, scope));

  const failed: SearchResult["failed"] = [];
  const results = await Promise.all(
    sources.map(async (source) => {
      const started = Date.now();
      try {
        const data = await engineQuery<{
          fetchSourceManga: { mangas: { id: number; title: string; thumbnailUrl: string | null }[] };
        }>(
          config,
          SEARCH_MUTATION,
          { input: { source: source.id, type: "SEARCH", page, query } },
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
        return [];
      }
    }),
  );

  return { groups: groupHits(results.flat()), failed, searched: sources.length };
}

const CHAPTERS_MUTATION = `
  mutation ($input: FetchChaptersInput!) {
    fetchChapters(input: $input) {
      chapters { id name chapterNumber uploadDate scanlator }
    }
  }`;

export interface ChapterInfo {
  id: number;
  name: string;
  /** -1 when the extension couldn't work out a number. */
  chapterNumber: number;
  uploadDate: string | null;
  scanlator: string | null;
}

/** Fetches the chapter list from the source site and returns it in reading order, oldest first. */
export async function fetchChapterList(
  config: Config,
  mangaId: number,
  fetchImpl?: FetchLike,
): Promise<ChapterInfo[]> {
  const data = await engineQuery<{
    fetchChapters: {
      chapters: {
        id: number;
        name: string;
        chapterNumber: number;
        uploadDate: string | number;
        scanlator: string | null;
      }[];
    };
  }>(config, CHAPTERS_MUTATION, { input: { mangaId } }, { fetchImpl, timeoutMs: 30000 });

  const chapters = data.fetchChapters.chapters.map<ChapterInfo>((c) => {
    const uploaded = Number(c.uploadDate);
    return {
      id: c.id,
      name: c.name,
      chapterNumber: c.chapterNumber,
      uploadDate: uploaded > 0 ? new Date(uploaded).toISOString() : null,
      scanlator: c.scanlator,
    };
  });
  return sortReadingOrder(chapters);
}

/**
 * Oldest first. Uses chapter numbers when every chapter has one, otherwise upload dates,
 * since extensions return -1 for chapters they couldn't number.
 */
export function sortReadingOrder(chapters: ChapterInfo[]): ChapterInfo[] {
  const allNumbered = chapters.every((c) => c.chapterNumber >= 0);
  const byDate = (a: ChapterInfo, b: ChapterInfo) =>
    (a.uploadDate ?? "").localeCompare(b.uploadDate ?? "") || a.id - b.id;
  return [...chapters].sort(
    allNumbered ? (a, b) => a.chapterNumber - b.chapterNumber || byDate(a, b) : byDate,
  );
}

export interface LatestChapter {
  chapterCount: number;
  latestNumber: number | null;
  latestUploadDate: string | null;
}

export function latestFromChapters(chapters: ChapterInfo[]): LatestChapter {
  const numbered = chapters.filter((c) => c.chapterNumber >= 0);
  if (numbered.length === 0) {
    return { chapterCount: chapters.length, latestNumber: null, latestUploadDate: null };
  }
  const latest = numbered.reduce((a, b) => (b.chapterNumber > a.chapterNumber ? b : a));
  return {
    chapterCount: chapters.length,
    latestNumber: latest.chapterNumber,
    latestUploadDate: latest.uploadDate,
  };
}

const MANGA_QUERY = `
  query ($id: Int!) {
    manga(id: $id) {
      id sourceId title thumbnailUrl author artist description genre status
    }
  }`;

// Search results only carry a title and cover. The engine fills in author, genres and
// description when asked to refresh the manga from its source.
const FETCH_MANGA_MUTATION = `
  mutation ($input: FetchMangaInput!) {
    fetchManga(input: $input) { manga { id } }
  }`;

export interface MangaDetails {
  id: number;
  sourceId: string;
  sourceName: string | null;
  title: string;
  author: string | null;
  artist: string | null;
  description: string | null;
  genre: string[];
  status: string;
}

let detailsHook: ((mangaId: number, tags: string[]) => void) | null = null;
/** Lets the app remember every series' tags it sees, to learn which tags are common and which are telling. */
export function onSeriesTags(hook: ((mangaId: number, tags: string[]) => void) | null): void {
  detailsHook = hook;
}

export async function fetchMangaDetails(
  config: Config,
  mangaId: number,
  fetchImpl?: FetchLike,
): Promise<MangaDetails> {
  // Best effort: if the refresh fails, fall back to whatever the engine already has.
  await engineQuery(config, FETCH_MANGA_MUTATION, { input: { id: mangaId } }, { fetchImpl }).catch(() => {});
  const [data, sources] = await Promise.all([
    engineQuery<{
      manga: Omit<MangaDetails, "sourceName" | "sourceId"> & { sourceId: string | number };
    }>(config, MANGA_QUERY, { id: mangaId }, { fetchImpl }),
    listSources(config, fetchImpl).catch(() => [] as EngineSource[]),
  ]);
  const { manga } = data;
  const sourceId = String(manga.sourceId);
  if (manga.genre?.length) detailsHook?.(manga.id, manga.genre);
  return {
    id: manga.id,
    sourceId,
    sourceName: sources.find((s) => s.id === sourceId)?.name ?? null,
    title: manga.title,
    author: manga.author,
    artist: manga.artist,
    description: manga.description,
    genre: manga.genre ?? [],
    status: manga.status,
  };
}

const PAGES_MUTATION = `
  mutation ($input: FetchChapterPagesInput!) {
    fetchChapterPages(input: $input) { pages }
  }`;

/**
 * Asks the engine for a chapter's page images and returns Sapphire URLs for them.
 * The engine's own page paths are checked against a strict pattern before use.
 */
export async function fetchPageUrls(
  config: Config,
  chapterId: number,
  fetchImpl?: FetchLike,
): Promise<string[]> {
  const data = await engineQuery<{ fetchChapterPages: { pages: string[] } }>(
    config,
    PAGES_MUTATION,
    { input: { chapterId } },
    { fetchImpl, timeoutMs: 45000 },
  );
  return data.fetchChapterPages.pages.map((page) => {
    const path = new URL(page, "http://engine").pathname;
    const m = /^\/api\/v1\/manga\/(\d+)\/chapter\/(\d+)\/page\/(\d+)$/.exec(path);
    if (!m) throw new Error(`unexpected page address from the engine: ${path}`);
    return `/api/read/${m[1]}/${m[2]}/${m[3]}`;
  });
}
