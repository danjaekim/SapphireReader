import { apiFetch, isOffline, queueProgress, supersede } from "./connection";
export interface SourceHit {
  mangaId: number;
  sourceId: string;
  sourceName: string;
  title: string;
  thumbnailUrl: string | null;
}

const sourceQs = (ids?: string[]) => (ids ?? []).map((id) => `&source=${encodeURIComponent(id)}`).join("");

export interface SeriesGroup {
  key: string;
  title: string;
  hits: SourceHit[];
  /** A merged series is shown with this series' cover (its primary listing). */
  cover?: number;
  /** AniList average score (0-100) and popularity, when sorting by them. */
  score?: number | null;
  popularity?: number | null;
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

/** Tells the server which device this is, so reading mode can differ between phone and desktop. */
function deviceId(): string {
  try {
    let id = localStorage.getItem("sapphire.device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("sapphire.device", id);
    }
    return id;
  } catch {
    return "";
  }
}
const deviceHeaders = (): Record<string, string> => {
  const id = deviceId();
  return id ? { "x-sapphire-device": id } : {};
};

export async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url, { headers: deviceHeaders() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; detail?: string };
    throw Object.assign(new Error(b.error ?? `Request failed (${res.status})`), { detail: b.detail });
  }
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

export interface ReaderPrefs {
  mode: "scroll" | "paged";
  direction: "ltr" | "rtl";
}
export type PrefsScope = "series" | "source" | "all";
export const setReaderPrefs = (mangaId: number, p: ReaderPrefs, scope: PrefsScope = "series") =>
  send("PUT", `/api/manga/${mangaId}/reader`, { ...p, scope }) as Promise<ReaderPrefs & { custom: boolean; level?: PrefsScope | "default" }>;

export interface SeriesData {
  manga: MangaDetails;
  /** The description split into story, other names and the site's own numbers. */
  about?: { body: string; altTitles: string[]; stats: { label: string; value: string }[]; facets?: { label: string; values: string[] }[]; tags?: string[]; info?: { author?: string; artist?: string; status?: string; year?: string } };
  adult?: boolean;
  /** On an 18+ source, so it can't be un-marked. */
  adultSource?: boolean;
  /** You marked this title 18+ yourself. */
  markedAdult?: boolean;
  /** You marked this title not 18+ (it's on an 18+ or mixed source). */
  markedSafe?: boolean;
  /** Other listings merged with this one (the main name first when this is the merged-in one). */
  mergedWith?: MergedName[];
  /** This listing's version label (Uncensored, Censored…), and the version the series stays on. */
  version?: string | null;
  preferredVersion?: string | null;
  /** This source's own name for the series (manga.title is the name it's shown under). */
  sourceTitle?: string;
  reader?: ReaderPrefs & { custom: boolean; level?: "series" | "source" | "default" };
  chapters: ChapterInfo[]; // oldest first
  latest: LatestChapter;
  inLibrary: boolean;
  /** ♥: counts toward For you, in the library or not. */
  liked?: boolean;
  progress: Progress | null;
  readChapterIds: number[];
  categories?: number[];
  /** The quick answer from what the engine saved last time; the live one replaces it. */
  saved?: boolean;
  /** Tags you picked as what this series is really about; Similar matches on them first. */
  primaryTags?: string[];
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
  categories: number[];
}

export interface HistoryItem {
  mangaId: number;
  title: string;
  sourceName: string | null;
  adult: boolean;
  inLibrary: boolean;
  progress: Progress;
}
export const history = () => getJson<{ items: HistoryItem[] }>("/api/history");
export const removeHistory = (mangaId: number) => send("DELETE", `/api/history/${mangaId}`);

export interface Category {
  id: number;
  name: string;
  count: number;
}
export const categories = () => getJson<{ categories: Category[] }>("/api/categories");
export const createCategory = (name: string) => send("POST", "/api/categories", { name }) as Promise<{ id: number; categories: Category[] }>;
export const renameCategory = (id: number, name: string) => send("PATCH", `/api/categories/${id}`, { name }) as Promise<{ categories: Category[] }>;
export const deleteCategory = (id: number) => send("DELETE", `/api/categories/${id}`) as Promise<{ categories: Category[] }>;
export const setSeriesCategories = (mangaId: number, ids: number[]) =>
  send("PUT", `/api/library/${mangaId}/categories`, { ids }) as Promise<{ categories: number[] }>;

export interface Automation {
  autoDownload: number;
  autoSwitch: boolean;
  autoDelete: boolean;
}
export const automation = () => getJson<Automation>("/api/settings/automation");
export const hiddenTags = () => getJson<{ tags: string[] }>("/api/settings/hidden-tags");
export const setHiddenTags = (tags: string[]) => send("PUT", "/api/settings/hidden-tags", { tags }) as Promise<{ tags: string[] }>;
export const favoriteTags = (adult = false) => getJson<{ tags: string[] }>(`/api/settings/favorite-tags${adult ? "?adult=1" : ""}`);
export const setFavoriteTags = (tags: string[], adult = false) =>
  send("PUT", `/api/settings/favorite-tags${adult ? "?adult=1" : ""}`, { tags }) as Promise<{ tags: string[] }>;
export const setAutomation = (a: Partial<Automation>) => send("PUT", "/api/settings/automation", a) as Promise<Automation>;

export async function send(method: string, url: string, body?: unknown, keepalive = false) {
  const res = await apiFetch(url, {
    method,
    keepalive,
    headers: { ...deviceHeaders(), ...(body ? { "content-type": "application/json" } : {}) },
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
/** Saves your place; while the NAS can't be reached, it waits on this device and is sent when it's back. */
export const saveProgress = (id: number, p: ProgressInput, keepalive = false) => {
  if (isOffline()) {
    queueProgress(id, p, deviceId());
    return Promise.resolve({ ok: true, queued: true });
  }
  supersede(id);
  return send("PUT", `/api/progress/${id}`, p, keepalive).catch((e: unknown) => {
    if (!isOffline()) throw e;
    queueProgress(id, p, deviceId());
    return { ok: true, queued: true };
  });
};

export const markChapters = (mangaId: number, chapterIds: number[], read: boolean) =>
  send("POST", `/api/manga/${mangaId}/read`, { chapterIds, read }) as Promise<{ readChapterIds: number[]; progress: Progress | null }>;
export const series = (mangaId: number) => getJson<SeriesData>(`/api/manga/${mangaId}`);
/** The series as the engine saved it last time: fast, no source site involved, may miss the newest chapters. */
export const seriesSaved = (mangaId: number) => getJson<SeriesData>(`/api/manga/${mangaId}/saved`);
export const chapterPages = (chapterId: number) =>
  getJson<{ pages: string[] }>(`/api/chapters/${chapterId}/pages`);

export interface BrowseResult extends SearchResult {
  skipped: string[];
  textFallback?: boolean;
  unsorted?: string[];
}
export type GenreScope = "safe" | "adult";
const scopeQs = (scope?: GenreScope) => (scope ? `&scope=${scope}` : "");
const sortQs = (sort?: string) => (sort && sort !== "relevance" ? `&sort=${sort}` : "");
export const browse = (genres: string[], q: string, page = 1, scope?: GenreScope, seed?: string, sort?: string, sourceIds?: string[]) =>
  getJson<BrowseResult>(`/api/browse?genres=${encodeURIComponent(genres.join(","))}&q=${encodeURIComponent(q)}&page=${page}${scopeQs(scope)}${seed ? `&seed=${encodeURIComponent(seed)}` : ""}${sortQs(sort)}${sourceQs(sourceIds)}`);
export const genreList = (scope?: GenreScope) =>
  getJson<{ genres: { name: string; sources: number }[] }>(`/api/genres?${scopeQs(scope).slice(1)}`);

export interface ExtensionInfo {
  pkgName: string;
  apkName?: string;
  isNsfw?: boolean;
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

export const discoverList = (sort: "popular" | "latest" | "rating" | "newest" | "az", adult = false, page = 1, sourceIds?: string[]) =>
  getJson<BrowseResult>(`/api/discover?sort=${sort}${adult ? "&adult=1" : ""}&page=${page}${sourceQs(sourceIds)}`);
/** Recommendation answers are saved on the server; `refresh` asks it to rebuild them now. */
const recQs = (adult: boolean, refresh: boolean) => {
  const q = [adult && "adult=1", refresh && "refresh=1"].filter(Boolean).join("&");
  return q ? `?${q}` : "";
};
export interface Freshness {
  /** When the answer was built (ms), and whether your library has changed since. */
  computedAt?: number;
  stale?: boolean;
}
export const alsoLiked = (adult = false, refresh = false) =>
  getJson<{ rows: { from: string; groups: SeriesGroup[] }[] } & Freshness>(`/api/for-you/also-liked${recQs(adult, refresh)}`);
export interface DeepRow {
  kind: "best" | "theme";
  tags: string[];
  support?: number;
  examples?: string[];
  groups: SeriesGroup[];
}
export const deepForYou = (adult = false, refresh = false) => getJson<{ rows: DeepRow[] } & Freshness>(`/api/for-you/deep${recQs(adult, refresh)}`);
export const setAdultMarks = (titles: string[], mark: boolean | null) => send("PUT", "/api/adult-marks", { titles, mark }) as Promise<{ marked: number }>;
export const setAdultMark = (mangaId: number, mark: boolean | null) => send("PUT", `/api/manga/${mangaId}/adult`, { mark }) as Promise<{ mark: boolean | null }>;
export interface MergedName {
  key: string;
  title: string;
  canon: boolean;
  /** The name (and cover) the series is shown with. */
  primary: boolean;
  /** This source's own name. */
  own: boolean;
  /** The listing's series id (null for an old merge that didn't record it). */
  mangaId?: number | null;
  version?: string | null;
  /** Which listing the name, the cover and the description are taken from. */
  shows?: { title: boolean; cover: boolean; description: boolean };
}
type Merged = { mergedWith: MergedName[] };
export interface DisplayChoice {
  title?: string;
  cover?: string;
  /** A listing's key, or null for the opened series' own description. */
  description?: string | null;
}
export const setDisplay = (mangaId: number, choice: DisplayChoice) =>
  send("PUT", `/api/manga/${mangaId}/merge/display`, choice) as Promise<Merged & { title: string; description: string | null; about: SeriesData["about"] }>;
export const setVersion = (mangaId: number, label: string | null) => send("PUT", `/api/manga/${mangaId}/version`, { label }) as Promise<{ version: string | null }>;
export const setPreferredVersion = (mangaId: number, label: string | null) =>
  send("PUT", `/api/manga/${mangaId}/preferred-version`, { label }) as Promise<{ preferredVersion: string | null }>;
/** Version labels offered first; any other text works too. */
export const VERSION_PRESETS = ["Uncensored", "Censored", "Colored", "Raw", "Official"];
/** MangaBaka: detailed tags (weighted per series) and a content rating, found by title or picked by hand. */
export type BakaWeight = "core" | "defining" | "recurrent" | "incidental" | "unweighted";
export interface BakaMatch {
  id: number;
  title: string;
  url: string;
  contentRating: string | null;
  type: string | null;
  year: string | null;
  rating: number | null;
  manual: boolean;
  tags: { id?: number; name: string; path: string; weight: BakaWeight; genre: boolean }[];
}
export interface BakaInfo { status: "matched" | "none" | "none-manual" | "unavailable"; match: BakaMatch | null }
export interface BakaHit { id: number; title: string; titles: string[]; type: string | null; year: string | null; url: string }
export const mangaBaka = (mangaId: number, refresh = false) => getJson<BakaInfo>(`/api/manga/${mangaId}/mangabaka${refresh ? "?refresh=1" : ""}`);
export const setMangaBaka = (mangaId: number, mbId: number | null) => send("PUT", `/api/manga/${mangaId}/mangabaka`, { mbId }) as Promise<BakaInfo>;
export const autoMangaBaka = (mangaId: number) => send("DELETE", `/api/manga/${mangaId}/mangabaka`) as Promise<BakaInfo>;
export const searchMangaBaka = (q: string) => getJson<{ hits: BakaHit[] }>(`/api/mangabaka/search?q=${encodeURIComponent(q)}`);
export const mergePreviews = (mangaId: number) =>
  getJson<{ items: { key: string; sourceName: string | null; description: string; available: boolean }[] }>(`/api/manga/${mangaId}/merge/previews`);
/** A listing's own cover, even when it's part of a merged series that shows another one. */
export const rawThumbnailUrl = (mangaId: number) => `/api/manga/${mangaId}/thumbnail?raw=1`;
export const mergeTitle = (mangaId: number, title: string, otherId?: number) => send("POST", `/api/manga/${mangaId}/merge`, { title, mangaId: otherId }) as Promise<Merged>;
export const setMainName = (mangaId: number, key: string) => send("PUT", `/api/manga/${mangaId}/merge/primary`, { key }) as Promise<Merged & { title: string }>;
export const unmergeTitle = (mangaId: number, key: string) => send("DELETE", `/api/manga/${mangaId}/merge/${encodeURIComponent(key)}`) as Promise<Merged>;
export const setLiked = (mangaId: number, on: boolean) => send("PUT", `/api/manga/${mangaId}/like`, { on });
export const setNotInterested = (mangaId: number, title: string, on: boolean, adult = false) =>
  send("PUT", `/api/manga/${mangaId}/not-interested`, { title, on, adult });
export interface Shelf {
  tags: string[];
  from: string;
  groups: SeriesGroup[];
}
export const forYou = (adult = false, refresh = false) =>
  getJson<{ groups: SeriesGroup[]; because: string[]; shelves?: Shelf[] } & Freshness>(`/api/for-you${recQs(adult, refresh)}`);

export interface AdultState {
  pinSet: boolean;
  unlocked: boolean;
  /** A passkey (Face ID) is set up, so it can unlock without the PIN. */
  passkey?: boolean;
  /** Unlocked on this phone while the NAS couldn't be reached: only what's saved here is shown. */
  offline?: boolean;
}
export const classifyAdult = (items: { mangaId: number; title: string; sourceId?: string }[]) =>
  send("POST", "/api/classify", { items }) as Promise<{ hide: Record<string, boolean> }>;
export const setSourceCheck = (id: string, check: boolean) => send("PUT", `/api/sources/${encodeURIComponent(id)}/check`, { check });
export const adultState = () => getJson<AdultState>("/api/adult");
export const setAdultPin = (pin: string, currentPin?: string) =>
  send("POST", "/api/adult/pin", { pin, currentPin }) as Promise<AdultState>;
export const unlockAdult = (pin: string) => send("POST", "/api/adult/unlock", { pin }) as Promise<AdultState>;
export const lockAdult = () => send("POST", "/api/adult/lock") as Promise<AdultState>;
/** A listing that looks like this same series (same MangaBaka entry, or same name apart from a version word). */
export interface SameSeries { mangaId: number; title: string; sourceName: string; label: string | null; selfLabel: string | null }
export interface SimilarResult {
  groups: SeriesGroup[];
  basedOn?: string[];
  sameSeries?: SameSeries[];
  /** Present when the series has primary tags (or a smaller set was asked for). */
  primary?: { tags: string[]; matchedAll: boolean; subsets: { tags: string[]; groups: SeriesGroup[] }[] };
  /** Series sharing this one's parody, group or character. */
  facetRows?: { label: string; value: string; groups: SeriesGroup[] }[];
}
/** `tags` tries a smaller set of the primary tags for this one request (not saved). */
export const similar = (mangaId: number, tags?: string[]) =>
  getJson<SimilarResult>(`/api/manga/${mangaId}/similar${tags ? `?tags=${encodeURIComponent(tags.join("|"))}` : ""}`);
/** Series with every one of these MangaBaka tags (and source genres, by name), found on your sources. */
export const mangaBakaBrowse = (tags: number[], genres: string[], page: number, adult: boolean) =>
  getJson<SearchResult & { more?: boolean }>(
    `/api/mangabaka/browse?${[...tags.map((t) => `tag=${t}`), ...genres.map((g) => `genre=${encodeURIComponent(g)}`), `page=${page}`, adult ? "adult=1" : ""].filter(Boolean).join("&")}`,
  );
export const mangaBakaTags = (q: string) => getJson<{ tags: { id: number; name: string; path: string; count: number | null }[] }>(`/api/mangabaka/tags?q=${encodeURIComponent(q)}`);
export const setPrimaryTags = (mangaId: number, tags: string[]) => send("PUT", `/api/manga/${mangaId}/primary-tags`, { tags }) as Promise<{ tags: string[] }>;
export interface MergeListing { mangaId: number; title: string; sourceName: string | null; adult: boolean; label: string | null }
export interface MergeSuggestion { key: string; reason: "mangabaka" | "version"; a: MergeListing; b: MergeListing }
export const mergeSuggestions = () => getJson<{ suggestions: MergeSuggestion[] }>("/api/merge-suggestions");
export const dismissMerge = (pair: { key: string } | { a: string; b: string }) => send("POST", "/api/merge-suggestions/dismiss", pair);

export const search = (q: string, page = 1, sort?: string, sourceIds?: string[]) =>
  getJson<BrowseResult>(`/api/search?q=${encodeURIComponent(q)}&page=${page}${sortQs(sort)}${sourceQs(sourceIds)}`);
export const latest = (mangaId: number) => getJson<LatestChapter>(`/api/manga/${mangaId}/latest`);
/** Bumped when merges change which cover a series shows, so images load fresh. */
let coverVersion = 0;
export const coversChanged = () => {
  coverVersion++;
};
export const thumbnailUrl = (mangaId: number) => `/api/manga/${mangaId}/thumbnail${coverVersion ? `?v=${coverVersion}` : ""}`;

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
  /** What the extension says, and any manual choice (true/false) that overrides it. */
  flaggedNsfw?: boolean;
  adultOverride?: boolean | null;
  /** Whether each of its series is checked for adult content while 18+ mode is off. */
  checkTitles?: boolean;
  /** An 18+ source while 18+ mode is off: listed, but its health isn't shown. */
  hidden?: boolean;
  health: SourceHealth | null;
}
export const sources = () => getJson<{ sources: SourceRow[] }>("/api/sources");
export const setSourceAdult = (id: string, adult: boolean | null) => send("PUT", `/api/sources/${encodeURIComponent(id)}/adult`, { adult });
export const checkSources = () => send("POST", "/api/sources/check");

export interface Alternative {
  mangaId: number;
  sourceName: string;
  version?: string | null;
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
  /** Found on another source of the series before yours has it. */
  elsewhere?: boolean;
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
  anyTag?: boolean;
  filters: string[];
  error?: string;
}
export const genreSupport = () => getJson<{ sources: GenreSupport[] }>("/api/sources/genres");

export interface SwitchOffer {
  mangaId: number;
  toMangaId: number;
  toSourceName: string | null;
  toLatest: number;
  fromLatest: number;
  title: string;
  fromSourceName: string | null;
  /** ahead: same version further along; other-version: only another version has newer chapters; back: your preferred version caught up. */
  kind?: "ahead" | "other-version" | "back";
  toVersion?: string | null;
  fromVersion?: string | null;
}
export const switchOffers = () => getJson<{ offers: SwitchOffer[] }>("/api/switch-offers").then((r) => r.offers);
export const acceptSwitch = (mangaId: number) => send("POST", `/api/switch-offers/${mangaId}/accept`) as Promise<{ mangaId: number }>;
export const dismissSwitch = (mangaId: number) => send("POST", `/api/switch-offers/${mangaId}/dismiss`);

export interface Rating {
  score: number | null;
  popularity: number | null;
  /** AniList's wide banner art, when it has one. */
  banner?: string | null;
  /** MangaUpdates' rating out of 10, looked up when AniList has no score. */
  mu?: number | null;
}
export const ratingsFor = (titles: string[], alts?: Record<string, string[]>) =>
  send("POST", "/api/ratings", { titles, alts }) as Promise<{ ratings: Record<string, Rating> }>;
