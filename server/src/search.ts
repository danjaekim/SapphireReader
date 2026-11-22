import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";

type FetchLike = typeof fetch;

/** Which sources a request may use: ordinary ones, 18+ ones only, or both. */
export type Scope = "safe" | "adult" | "all";

export function inScope(s: EngineSource, scope: Scope): boolean {
  return (s.lang === "en" || s.lang === "all") && (scope === "all" || (scope === "adult" ? s.isNsfw : !s.isNsfw));
}

/**
 * Sources to search for a scope. The same site can be installed twice under one name (say an
 * English and a multi-language build); asking both just shows the same site twice, so keep one,
 * preferring English.
 */
export function scopedSources(all: EngineSource[], scope: Scope, only?: (s: EngineSource) => boolean): EngineSource[] {
  const best = new Map<string, EngineSource>();
  for (const s of all.filter((x) => inScope(x, scope) && (!only || only(x)))) {
    const key = s.name.trim().toLowerCase();
    const have = best.get(key);
    if (!have || (have.lang !== "en" && s.lang === "en")) best.set(key, s);
  }
  return [...best.values()];
}

/** Sources Dan has marked 18+ (or not) by hand, overriding what the extension says. */
let adultOverrides: Record<string, boolean> = {};
export function setAdultOverrides(map: Record<string, boolean>): void {
  adultOverrides = { ...map };
}
export const adultOverrideFor = (id: string): boolean | null => (id in adultOverrides ? adultOverrides[id] : null);

export interface EngineSource {
  id: string;
  name: string;
  lang: string;
  isNsfw: boolean;
  /** What the extension itself says, before any manual override. */
  flaggedNsfw?: boolean;
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
  /** For a merged series: the series whose cover to show (its primary listing). */
  cover?: number;
}

export interface SearchResult {
  groups: SeriesGroup[];
  /** Sources that failed or timed out, so the UI can say results may be incomplete. */
  failed: { sourceName: string; error: string }[];
  searched: number;
}

/**
 * Titles you merged by hand: a raw key that should count as another one. Set from the store at start
 * and whenever a merge changes, so every comparison of titles (grouping search results, "Also on",
 * carrying reading across sources, your library) treats them as one series.
 */
let titleAliases = new Map<string, string>();
/** How each merged series is shown: its primary listing's name and series id (for the cover). */
let titlePrimaries = new Map<string, { title: string; mangaId: number | null; descMangaId?: number | null }>();
export function setTitleAliases(map: Map<string, string>, primaries: Map<string, { title: string; mangaId: number | null; descMangaId?: number | null }> = new Map()): void {
  titleAliases = map;
  titlePrimaries = primaries;
}

/** The name to show for a title: a merged series' primary name, else the title itself. */
export function displayTitle(title: string): string {
  return titlePrimaries.get(normalizeTitle(title))?.title ?? title;
}

/** The series whose cover a merged series is shown with (its primary listing), or null. */
export function primaryCover(title: string): number | null {
  return titlePrimaries.get(normalizeTitle(title))?.mangaId ?? null;
}

/** The series whose description a merged series is shown with, if one was chosen. */
export function primaryDescription(title: string): number | null {
  return titlePrimaries.get(normalizeTitle(title))?.descMangaId ?? null;
}

/** The normalized key a title is matched by, with merges applied. */
export function normalizeTitle(title: string): string {
  const key = rawTitleKey(title);
  return titleAliases.get(key) ?? key;
}

/**
 * The normalized key of the title as written, ignoring merges: lowercased, punctuation and spacing
 * stripped, so "Solo Leveling!" matches "solo leveling".
 */
export function rawTitleKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const groupKey = normalizeTitle;

/** Titles of series seen in recent results, so a cover can be swapped for a merged series' primary one. */
const seenTitles = new Map<number, string>();
export function seenTitle(mangaId: number): string | null {
  return seenTitles.get(mangaId) ?? null;
}

export function groupHits(hits: SourceHit[]): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>();
  for (const hit of hits) {
    seenTitles.set(hit.mangaId, hit.title);
    if (seenTitles.size > 20000) seenTitles.delete(seenTitles.keys().next().value!);
    const key = normalizeTitle(hit.title);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.hits.push(hit);
    else {
      // A merged series shows as its primary listing (name and cover).
      const primary = titlePrimaries.get(key);
      groups.set(key, primary ? { key, title: primary.title, hits: [hit], ...(primary.mangaId !== null ? { cover: primary.mangaId } : {}) } : { key, title: hit.title, hits: [hit] });
    }
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

/**
 * How well a title matches what was typed: the whole title (100), the title starting with it (80),
 * the words together somewhere in it (60), every word somewhere (40), or some of the words (under 30).
 * Words count only whole ("set" doesn't match "Sets" or "Sima"), ignoring case and punctuation.
 */
export function titleMatch(title: string, query: string): number {
  const q = rawTitleKey(query);
  const t = rawTitleKey(title);
  if (!q || !t) return 0;
  if (t === q) return 100;
  const padded = ` ${t} `;
  if (padded.startsWith(` ${q} `)) return 80;
  if (padded.includes(` ${q} `)) return 60;
  const words = q.split(" ");
  const have = new Set(t.split(" "));
  const found = words.filter((w) => have.has(w)).length;
  if (found === words.length) return 40;
  return Math.round((30 * found) / words.length);
}

/**
 * Orders search results by how well their names match the query, then by how many sources have
 * them, then by the sites' own order. Sites often return loose matches (a word in the description,
 * a similar spelling) ahead of the real one, and one site's whole list would otherwise come first.
 */
export function rankByQuery(groups: SeriesGroup[], query: string): SeriesGroup[] {
  const score = new Map(groups.map((g) => [g.key, Math.max(titleMatch(g.title, query), ...g.hits.map((h) => titleMatch(h.title, query)))]));
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => score.get(b.g.key)! - score.get(a.g.key)! || b.g.hits.length - a.g.hits.length || a.i - b.i)
    .map((x) => x.g);
}

const SOURCES_QUERY = `{ sources { nodes { id name lang isNsfw } } }`;

export async function listSources(config: Config, fetchImpl?: FetchLike): Promise<EngineSource[]> {
  const data = await engineQuery<{ sources: { nodes: EngineSource[] } }>(
    config,
    SOURCES_QUERY,
    {},
    { fetchImpl },
  );
  return data.sources.nodes.map((n) => ({ ...n, flaggedNsfw: n.isNsfw, isNsfw: id_in(adultOverrides, n.id) ? adultOverrides[n.id] : n.isNsfw }));
}
const id_in = (o: Record<string, boolean>, id: string) => Object.prototype.hasOwnProperty.call(o, id);

const SEARCH_MUTATION = `
  mutation ($input: FetchSourceMangaInput!) {
    fetchSourceManga(input: $input) {
      mangas { id title thumbnailUrl }
    }
  }`;

export async function searchAll(
  config: Config,
  query: string,
  opts: { fetchImpl?: FetchLike; scope?: Scope; timeoutMs?: number; onResult?: SourceReport; page?: number; only?: (s: EngineSource) => boolean } = {},
): Promise<SearchResult> {
  const { fetchImpl, scope = "safe", timeoutMs = 8000, onResult, page = 1, only } = opts;
  const all = await listSources(config, fetchImpl);
  // English and multi-language sources only; 18+ sources are used only when 18+ mode is unlocked.
  const sources = scopedSources(all, scope, only);

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

  return { groups: rankByQuery(interleaveGroups(results), query), failed, searched: sources.length };
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
