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
  /** A line to show under the count, e.g. which sources were left out. */
  note?: string;
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

export interface Progress {
  chapterId: number;
  chapterNumber: number;
  chapterName: string;
  pageIndex: number;
  pageOffset: number;
  updatedAt: string;
}

export interface SeriesData {
  manga: MangaDetails;
  adult?: boolean;
  chapters: ChapterInfo[]; // oldest first
  latest: LatestChapter;
  inLibrary: boolean;
  progress: Progress | null;
  readChapterIds: number[];
}

export interface LibraryItem {
  mangaId: number;
  sourceId: string;
  sourceName: string | null;
  title: string;
  progress: Progress | null;
  latestNumber: number | null;
  chapterCount: number;
  unread: number | null;
}

async function send(method: string, url: string, body?: unknown, keepalive = false) {
  const res = await fetch(url, {
    method,
    keepalive,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((out as { error?: string }).error ?? `Request failed (${res.status})`);
  return out;
}

export const library = () => getJson<{ items: LibraryItem[] }>("/api/library");
export const refreshLibrary = () => send("POST", "/api/library/refresh") as Promise<{ items: LibraryItem[]; failed: number[] }>;
export const addToLibrary = (id: number, sourceId: string, sourceName: string | null, title: string) =>
  send("PUT", `/api/library/${id}`, { sourceId, sourceName, title });
export const removeFromLibrary = (id: number) => send("DELETE", `/api/library/${id}`);
export interface ProgressInput {
  chapterId: number;
  chapterNumber: number;
  chapterName: string;
  pageIndex: number;
  pageOffset: number;
  finished?: boolean;
}
export const saveProgress = (id: number, p: ProgressInput, keepalive = false) =>
  send("PUT", `/api/progress/${id}`, p, keepalive);

export const series = (mangaId: number) => getJson<SeriesData>(`/api/manga/${mangaId}`);
export const chapterPages = (chapterId: number) =>
  getJson<{ pages: string[] }>(`/api/chapters/${chapterId}/pages`);

export interface BrowseResult extends SearchResult {
  skipped: string[];
}
export type GenreScope = "safe" | "adult";
const scopeQs = (scope?: GenreScope) => (scope ? `&scope=${scope}` : "");
export const browse = (genres: string[], q: string, page = 1, scope?: GenreScope, seed?: string) =>
  getJson<BrowseResult>(`/api/browse?genres=${encodeURIComponent(genres.join(","))}&q=${encodeURIComponent(q)}&page=${page}${scopeQs(scope)}${seed ? `&seed=${encodeURIComponent(seed)}` : ""}`);
export const genreList = (scope?: GenreScope) =>
  getJson<{ genres: { name: string; sources: number }[] }>(`/api/genres?${scopeQs(scope).slice(1)}`);

export interface ExtensionInfo {
  pkgName: string;
  name: string;
  lang: string;
  versionName: string;
  isInstalled: boolean;
  hasUpdate: boolean;
}
export const extensions = () => getJson<{ extensions: ExtensionInfo[] }>("/api/extensions");
export const refreshExtensionList = () =>
  send("POST", "/api/extensions/refresh") as Promise<{ extensions: ExtensionInfo[] }>;
export const changeExtension = (pkg: string, action: "install" | "update" | "uninstall") =>
  send("POST", `/api/extensions/${pkg}/${action}`) as Promise<{ extension: ExtensionInfo }>;

export const discoverList = (sort: "popular" | "latest", adult = false, page = 1) =>
  getJson<SearchResult>(`/api/discover?sort=${sort}${adult ? "&adult=1" : ""}&page=${page}`);
export const forYou = (adult = false) =>
  getJson<{ groups: SeriesGroup[]; because: string[] }>(`/api/for-you${adult ? "?adult=1" : ""}`);

export interface AdultState {
  pinSet: boolean;
  unlocked: boolean;
}
export const adultState = () => getJson<AdultState>("/api/adult");
export const setAdultPin = (pin: string, currentPin?: string) =>
  send("POST", "/api/adult/pin", { pin, currentPin }) as Promise<AdultState>;
export const unlockAdult = (pin: string) => send("POST", "/api/adult/unlock", { pin }) as Promise<AdultState>;
export const lockAdult = () => send("POST", "/api/adult/lock") as Promise<AdultState>;
export const similar = (mangaId: number) => getJson<{ groups: SeriesGroup[] }>(`/api/manga/${mangaId}/similar`);

export const search = (q: string, page = 1) => getJson<SearchResult>(`/api/search?q=${encodeURIComponent(q)}&page=${page}`);
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

export interface SourceHealth {
  okCount: number;
  failCount: number;
  avgMs: number | null;
  lastOk: string | null;
  lastFail: string | null;
  lastError: string | null;
}
export interface SourceRow {
  id: string;
  name: string;
  lang: string;
  isNsfw: boolean;
  health: SourceHealth | null;
}
export const sources = () => getJson<{ sources: SourceRow[] }>("/api/sources");
export const checkSources = () => send("POST", "/api/sources/check");

export interface Alternative {
  mangaId: number;
  sourceName: string;
  chapterCount: number;
  latestNumber: number | null;
}
export const alternatives = (mangaId: number) => getJson<{ alternatives: Alternative[] }>(`/api/manga/${mangaId}/alternatives`);

export interface TrackerLink {
  mediaId: number;
  title: string;
  syncedProgress: number;
}
export interface TrackerMatch {
  mediaId: number;
  title: string;
  chapters: number | null;
  status: string | null;
  cover: string | null;
}
export interface TrackerState {
  anilist: { connected: boolean; user: string | null };
}
export const trackers = () => getJson<TrackerState>("/api/trackers");
export const connectAnilist = (token: string) => send("PUT", "/api/trackers/anilist", { token }) as Promise<TrackerState>;
export const disconnectAnilist = () => send("DELETE", "/api/trackers/anilist") as Promise<TrackerState>;
export const anilistMatches = (q: string) =>
  getJson<{ matches: TrackerMatch[] }>(`/api/trackers/anilist/search?q=${encodeURIComponent(q)}`);
export const tracking = (mangaId: number) => getJson<{ anilist: TrackerLink | null }>(`/api/manga/${mangaId}/tracking`);
export const linkAnilist = (mangaId: number, mediaId: number, title: string) =>
  send("PUT", `/api/manga/${mangaId}/tracking`, { mediaId, title }) as Promise<{ anilist: TrackerLink | null }>;
export const unlinkAnilist = (mangaId: number) => send("DELETE", `/api/manga/${mangaId}/tracking`);

export interface DownloadRow {
  chapterId: number;
  mangaId: number;
  mangaTitle: string;
  sourceName: string | null;
  adult: boolean;
  chapterName: string;
  chapterNumber: number;
  status: "queued" | "downloading" | "done" | "failed";
  pages: number;
  bytes: number;
  error: string | null;
}
export interface DownloadState {
  chapterId: number;
  status: DownloadRow["status"];
  error: string | null;
}
export const downloads = () => getJson<{ items: DownloadRow[]; totalBytes: number }>("/api/downloads");
export const seriesDownloads = (mangaId: number) => getJson<{ items: DownloadState[] }>(`/api/manga/${mangaId}/downloads`);
export const removeDownload = (chapterId: number) => send("DELETE", `/api/downloads/${chapterId}`);
export const removeSeriesDownloads = (mangaId: number) => send("DELETE", `/api/downloads/series/${mangaId}`);

/** Queues chapters on the NAS (in batches the server accepts). */
export async function queueDownloads(
  manga: { id: number; title: string; sourceId: string; sourceName: string | null },
  chapters: { id: number; name: string; chapterNumber: number }[],
): Promise<number> {
  let queued = 0;
  for (let i = 0; i < chapters.length; i += 400) {
    const batch = chapters.slice(i, i + 400).map((c) => ({ id: c.id, name: c.name, number: c.chapterNumber }));
    const r = (await send("POST", "/api/downloads", {
      mangaId: manga.id,
      title: manga.title,
      sourceId: manga.sourceId,
      sourceName: manga.sourceName,
      chapters: batch,
    })) as { queued: number };
    queued += r.queued;
  }
  return queued;
}

export interface UpdateRow {
  mangaId: number;
  title: string;
  sourceName: string | null;
  adult: boolean;
  latestNumber: number;
  newCount: number;
  caughtUp: boolean;
  detectedAt: string;
}
export const updatesFeed = () => getJson<{ items: UpdateRow[]; lastCheckedAt: string | null }>("/api/updates");
export interface HomeData {
  libraryCount: number;
  continueReading: LibraryItem[];
  newChapters: UpdateRow[];
  lastCheckedAt: string | null;
  alertsOn: boolean;
}
export const homeData = () => getJson<HomeData>("/api/home");
export interface GenreSupport {
  id: string;
  name: string;
  genres: number;
  filters: string[];
  error?: string;
}
export const genreSupport = () => getJson<{ sources: GenreSupport[] }>("/api/sources/genres");
