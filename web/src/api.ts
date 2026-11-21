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
  failed: { sourceName: string; error: string }[];
  searched: number;
}

export interface LatestChapter {
  chapterCount: number;
  latestNumber: number | null;
  latestUploadDate: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

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

export interface ChapterInfo {
  id: number;
  name: string;
  chapterNumber: number;
  uploadDate: string | null;
  scanlator: string | null;
}

export interface SeriesData {
  manga: MangaDetails;
  chapters: ChapterInfo[]; // oldest first
  latest: LatestChapter;
}

export const series = (mangaId: number) => getJson<SeriesData>(`/api/manga/${mangaId}`);
export const chapterPages = (chapterId: number) =>
  getJson<{ pages: string[] }>(`/api/chapters/${chapterId}/pages`);

export const search = (q: string) => getJson<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`);
export const latest = (mangaId: number) => getJson<LatestChapter>(`/api/manga/${mangaId}/latest`);
export const thumbnailUrl = (mangaId: number) => `/api/manga/${mangaId}/thumbnail`;

/** Runs async jobs a few at a time so one search doesn't hit every site at once. */
export function createQueue(concurrency: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    if (running >= concurrency) return;
    const job = waiting.shift();
    if (job) job();
  };
  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            running--;
            next();
          });
      });
      next();
    });
  };
}
