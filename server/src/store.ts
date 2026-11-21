import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeTitle } from "./search.js";

export interface LibraryEntry {
  mangaId: number;
  sourceId: string;
  sourceName: string | null;
  title: string;
  addedAt: string;
  /** From an 18+ source; hidden unless 18+ mode is unlocked. */
  adult: boolean;
}

export interface Progress {
  mangaId: number;
  chapterId: number;
  chapterNumber: number;
  chapterName: string;
  /** Which page of the chapter you were on (0-based) and how far down it (0 to 1). */
  pageIndex: number;
  pageOffset: number;
  updatedAt: string;
}

export interface ProgressInput {
  chapterId: number;
  chapterNumber: number;
  chapterName: string;
  pageIndex: number;
  pageOffset: number;
  /** True once the end of the chapter has been reached. */
  finished?: boolean;
}

export interface LibraryItem extends LibraryEntry {
  progress: Progress | null;
  latestNumber: number | null;
  chapterCount: number;
  /** Chapters newer than the last one you finished; null if the chapter list hasn't been loaded yet. */
  unread: number | null;
  /** Library categories (shelves) this series is on. */
  categories: number[];
}

export interface HistoryRow {
  mangaId: number;
  title: string;
  sourceName: string | null;
  adult: boolean;
  inLibrary: boolean;
  progress: Progress;
}

export interface Category {
  id: number;
  name: string;
  count: number;
}

export interface SwitchOffer {
  mangaId: number;
  toMangaId: number;
  toSourceId: string;
  toSourceName: string | null;
  toLatest: number;
  fromLatest: number;
}

export interface AnilistMeta {
  anilistId: number | null;
  score: number | null;
  popularity: number | null;
  /** Wide banner art, when AniList has one. */
  banner?: string | null;
  /** AniList flags it as adult (null: not known yet). */
  adult?: boolean | null;
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

function toDownload(r: Record<string, unknown>): DownloadRow {
  return {
    chapterId: r.chapter_id as number,
    mangaId: r.manga_id as number,
    mangaTitle: r.manga_title as string,
    sourceName: (r.source_name as string | null) ?? null,
    adult: r.adult === 1,
    chapterName: r.chapter_name as string,
    chapterNumber: r.chapter_number as number,
    status: r.status as DownloadRow["status"],
    pages: r.pages as number,
    bytes: r.bytes as number,
    error: (r.error as string | null) ?? null,
  };
}

export interface TrackerLink {
  mediaId: number;
  title: string;
  /** Highest chapter already pushed to the tracker, so it only ever moves forward. */
  syncedProgress: number;
}

export interface SourceHealth {
  sourceId: string;
  name: string;
  okCount: number;
  failCount: number;
  avgMs: number | null;
  lastOk: string | null;
  lastFail: string | null;
  lastError: string | null;
}

/** Everything Sapphire remembers, in one SQLite file on the NAS volume. */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library (
        manga_id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_name TEXT,
        title TEXT NOT NULL,
        added_at TEXT NOT NULL,
        chapter_numbers TEXT NOT NULL DEFAULT '[]',
        checked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS progress (
        manga_id INTEGER PRIMARY KEY,
        chapter_id INTEGER NOT NULL,
        chapter_number REAL NOT NULL,
        chapter_name TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        page_offset REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS downloads (
        chapter_id INTEGER PRIMARY KEY,
        manga_id INTEGER NOT NULL,
        manga_title TEXT NOT NULL,
        source_name TEXT,
        adult INTEGER NOT NULL DEFAULT 0,
        chapter_name TEXT NOT NULL,
        chapter_number REAL NOT NULL,
        status TEXT NOT NULL,
        pages INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manga_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        source_name TEXT,
        adult INTEGER NOT NULL DEFAULT 0,
        latest_number REAL NOT NULL,
        new_count INTEGER NOT NULL,
        caught_up INTEGER NOT NULL,
        detected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracker_links (
        manga_id INTEGER NOT NULL,
        service TEXT NOT NULL,
        media_id INTEGER NOT NULL,
        media_title TEXT NOT NULL,
        synced_progress INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (manga_id, service)
      );
      CREATE TABLE IF NOT EXISTS source_health (
        source_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ok_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        avg_ms REAL,
        last_ok TEXT,
        last_fail TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS chapters_read (
        manga_id INTEGER NOT NULL,
        chapter_id INTEGER NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (manga_id, chapter_id)
      );
    `);
    // Added after the first release; older databases get the column on startup.
    for (const column of ["genres TEXT NOT NULL DEFAULT '[]'", "adult INTEGER NOT NULL DEFAULT 0"]) {
      try {
        this.db.exec(`ALTER TABLE library ADD COLUMN ${column}`);
      } catch {
        /* column already exists */
      }
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Title and source of every series opened, so History can list series that aren't in the library.
    this.db.exec("CREATE TABLE IF NOT EXISTS series_meta (manga_id INTEGER PRIMARY KEY, title TEXT NOT NULL, source_name TEXT, adult INTEGER NOT NULL DEFAULT 0)");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS library_categories (manga_id INTEGER NOT NULL, category_id INTEGER NOT NULL, PRIMARY KEY (manga_id, category_id));
      CREATE TABLE IF NOT EXISTS switch_offers (
        manga_id INTEGER PRIMARY KEY, to_manga_id INTEGER NOT NULL, to_source_id TEXT NOT NULL, to_source_name TEXT,
        to_latest REAL NOT NULL, from_latest REAL NOT NULL, created_at TEXT NOT NULL, dismissed_latest REAL
      );
      CREATE TABLE IF NOT EXISTS anilist_meta (title_key TEXT PRIMARY KEY, anilist_id INTEGER, score INTEGER, popularity INTEGER, fetched_at TEXT NOT NULL);
    `);
    // Banner art came later: add the column and ask AniList again so existing entries get theirs.
    try {
      this.db.exec("ALTER TABLE anilist_meta ADD COLUMN banner TEXT");
      this.db.exec("UPDATE anilist_meta SET fetched_at = '1970-01-01T00:00:00.000Z'");
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec("ALTER TABLE anilist_meta ADD COLUMN is_adult INTEGER");
      this.db.exec("UPDATE anilist_meta SET fetched_at = '1970-01-01T00:00:00.000Z' WHERE anilist_id IS NOT NULL");
    } catch {
      /* column already exists */
    }
    // What each series turned out to be (adult or not), and how we know, so a series is only checked once.
    this.db.exec("CREATE TABLE IF NOT EXISTS series_adult (manga_id INTEGER PRIMARY KEY, adult INTEGER NOT NULL, basis TEXT NOT NULL, checked_at TEXT NOT NULL)");
    // MangaUpdates' rating, the fallback for series AniList doesn't know.
    this.db.exec("CREATE TABLE IF NOT EXISTS mu_meta (title_key TEXT PRIMARY KEY, series_id INTEGER, score REAL, fetched_at TEXT NOT NULL)");
    // Tags of every series Sapphire has looked at, so it can tell common tags from telling ones.
    // Which chapter numbers of a series (by normalised title) have been read on any source, so another source of the same series starts out with them marked.
    this.db.exec("CREATE TABLE IF NOT EXISTS read_numbers (title_key TEXT NOT NULL, chapter_number REAL NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY (title_key, chapter_number))");
    this.db.exec("CREATE TABLE IF NOT EXISTS series_tags (manga_id INTEGER PRIMARY KEY, tags TEXT NOT NULL, seen_at TEXT NOT NULL)");
  }

  recordSeriesMeta(mangaId: number, title: string, sourceName: string | null, adult: boolean): void {
    this.db
      .prepare("INSERT INTO series_meta (manga_id, title, source_name, adult) VALUES (?, ?, ?, ?) ON CONFLICT(manga_id) DO UPDATE SET title = excluded.title, source_name = excluded.source_name, adult = excluded.adult")
      .run(mangaId, title, sourceName, adult ? 1 : 0);
  }

  private readKey(mangaId: number): string | null {
    const row = this.db.prepare("SELECT title FROM series_meta WHERE manga_id = ?").get(mangaId) as { title: string } | undefined;
    return row ? normalizeTitle(row.title) || null : null;
  }

  /** Remembers (or forgets) that these chapter numbers of this series are read, whichever source they were read on. */
  recordReadNumbers(mangaId: number, numbers: number[], read: boolean): void {
    const key = this.readKey(mangaId);
    if (!key) return;
    const now = new Date().toISOString();
    const add = this.db.prepare("INSERT OR IGNORE INTO read_numbers (title_key, chapter_number, read_at) VALUES (?, ?, ?)");
    const del = this.db.prepare("DELETE FROM read_numbers WHERE title_key = ? AND chapter_number = ?");
    for (const n of numbers) if (n >= 0) (read ? add.run(key, n, now) : del.run(key, n));
  }

  /**
   * Marks the chapters of this source that were already read on another source of the same series
   * (same title, same chapter number). Returns the chapters it newly marked.
   */
  applyReadFromOtherSources(mangaId: number, chapters: { id: number; chapterNumber: number; name: string }[]): { id: number; chapterNumber: number; name: string }[] {
    const key = this.readKey(mangaId);
    if (!key) return [];
    const readNums = new Set((this.db.prepare("SELECT chapter_number FROM read_numbers WHERE title_key = ?").all(key) as { chapter_number: number }[]).map((r) => r.chapter_number));
    if (readNums.size === 0) return [];
    const have = new Set(this.readChapterIds(mangaId));
    const fresh = chapters.filter((c) => c.chapterNumber >= 0 && readNums.has(c.chapterNumber) && !have.has(c.id));
    this.setChaptersRead(mangaId, fresh.map((c) => c.id), true);
    return fresh;
  }

  /** Every series you've read, most recent first, with where you are in it. */
  history(includeAdult = false, limit = 200): HistoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, COALESCE(l.title, m.title) AS title, COALESCE(l.source_name, m.source_name) AS source_name,
                COALESCE(l.adult, m.adult, 0) AS adult, l.manga_id IS NOT NULL AS in_library
         FROM progress p
         LEFT JOIN library l ON l.manga_id = p.manga_id
         LEFT JOIN series_meta m ON m.manga_id = p.manga_id
         WHERE COALESCE(l.title, m.title) IS NOT NULL ${includeAdult ? "" : "AND COALESCE(l.adult, m.adult, 0) = 0"}
         ORDER BY p.updated_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      mangaId: r.manga_id as number,
      title: r.title as string,
      sourceName: (r.source_name as string | null) ?? null,
      adult: r.adult === 1,
      inLibrary: r.in_library === 1,
      progress: toProgress(r),
    }));
  }

  removeHistory(mangaId: number): void {
    this.db.prepare("DELETE FROM progress WHERE manga_id = ?").run(mangaId);
  }

  categories(includeAdult = false): Category[] {
    return (
      this.db
        .prepare(
          `SELECT c.id, c.name, COUNT(l.manga_id) AS count FROM categories c
           LEFT JOIN library_categories lc ON lc.category_id = c.id
           LEFT JOIN library l ON l.manga_id = lc.manga_id ${includeAdult ? "" : "AND l.adult = 0"}
           GROUP BY c.id ORDER BY c.position, c.id`,
        )
        .all() as { id: number; name: string; count: number }[]
    ).map((c) => ({ id: c.id, name: c.name, count: c.count }));
  }

  createCategory(name: string): number {
    const pos = (this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM categories").get() as { p: number }).p;
    return Number(this.db.prepare("INSERT INTO categories (name, position) VALUES (?, ?)").run(name, pos).lastInsertRowid);
  }

  renameCategory(id: number, name: string): void {
    this.db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, id);
  }

  deleteCategory(id: number): void {
    this.db.prepare("DELETE FROM library_categories WHERE category_id = ?").run(id);
    this.db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  }

  setSeriesCategories(mangaId: number, ids: number[]): void {
    this.db.prepare("DELETE FROM library_categories WHERE manga_id = ?").run(mangaId);
    const add = this.db.prepare("INSERT OR IGNORE INTO library_categories (manga_id, category_id) SELECT ?, id FROM categories WHERE id = ?");
    for (const id of ids) add.run(mangaId, id);
  }

  seriesCategories(mangaId: number): number[] {
    return (this.db.prepare("SELECT category_id FROM library_categories WHERE manga_id = ?").all(mangaId) as { category_id: number }[]).map((r) => r.category_id);
  }

  anilistMeta(keys: string[]): Map<string, AnilistMeta & { fetchedAt: string }> {
    const get = this.db.prepare("SELECT * FROM anilist_meta WHERE title_key = ?");
    const out = new Map<string, AnilistMeta & { fetchedAt: string }>();
    for (const k of keys) {
      const r = get.get(k) as Record<string, unknown> | undefined;
      if (r) out.set(k, { anilistId: (r.anilist_id as number | null) ?? null, score: (r.score as number | null) ?? null, popularity: (r.popularity as number | null) ?? null, banner: (r.banner as string | null) ?? null, adult: r.is_adult == null ? null : r.is_adult === 1, fetchedAt: r.fetched_at as string });
    }
    return out;
  }

  muMeta(keys: string[]): Map<string, { seriesId: number | null; score: number | null; fetchedAt: string }> {
    const get = this.db.prepare("SELECT * FROM mu_meta WHERE title_key = ?");
    const out = new Map<string, { seriesId: number | null; score: number | null; fetchedAt: string }>();
    for (const k of keys) {
      const r = get.get(k) as Record<string, unknown> | undefined;
      if (r) out.set(k, { seriesId: (r.series_id as number | null) ?? null, score: (r.score as number | null) ?? null, fetchedAt: r.fetched_at as string });
    }
    return out;
  }

  putMuMeta(key: string, seriesId: number | null, score: number | null): void {
    this.db
      .prepare(
        `INSERT INTO mu_meta (title_key, series_id, score, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(title_key) DO UPDATE SET series_id = excluded.series_id, score = excluded.score, fetched_at = excluded.fetched_at`,
      )
      .run(key, seriesId, score, new Date().toISOString());
  }

  putAnilistMeta(key: string, m: AnilistMeta): void {
    this.db
      .prepare(
        `INSERT INTO anilist_meta (title_key, anilist_id, score, popularity, banner, is_adult, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(title_key) DO UPDATE SET anilist_id = excluded.anilist_id, score = excluded.score, popularity = excluded.popularity,
           banner = excluded.banner, is_adult = excluded.is_adult, fetched_at = excluded.fetched_at`,
      )
      .run(key, m.anilistId, m.score, m.popularity, m.banner ?? null, m.adult == null ? null : m.adult ? 1 : 0, new Date().toISOString());
  }

  seriesAdult(ids: number[]): Map<number, boolean> {
    const get = this.db.prepare("SELECT adult FROM series_adult WHERE manga_id = ?");
    const out = new Map<number, boolean>();
    for (const id of ids) {
      const r = get.get(id) as { adult: number } | undefined;
      if (r) out.set(id, r.adult === 1);
    }
    return out;
  }

  putSeriesAdult(mangaId: number, adult: boolean, basis: string): void {
    this.db
      .prepare("INSERT INTO series_adult (manga_id, adult, basis, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(manga_id) DO UPDATE SET adult = excluded.adult, basis = excluded.basis, checked_at = excluded.checked_at")
      .run(mangaId, adult ? 1 : 0, basis, new Date().toISOString());
  }

  /**
   * Moves a library series to the same series on another source: the library entry, categories,
   * read chapters (matched by chapter number) and your place all follow.
   */
  switchSource(
    fromId: number,
    to: { mangaId: number; sourceId: string; sourceName: string | null; title: string },
    chapters: { from: { id: number; chapterNumber: number }[]; to: { id: number; chapterNumber: number; name: string }[] },
  ): void {
    const row = this.db.prepare("SELECT * FROM library WHERE manga_id = ?").get(fromId) as Record<string, unknown> | undefined;
    if (!row) return;
    const byNumber = new Map(chapters.to.filter((c) => c.chapterNumber >= 0).map((c) => [c.chapterNumber, c]));
    const readNumbers = new Set(
      chapters.from.filter((c) => this.readChapterIds(fromId).includes(c.id)).map((c) => c.chapterNumber),
    );
    this.addToLibrary({ mangaId: to.mangaId, sourceId: to.sourceId, sourceName: to.sourceName, title: to.title, adult: row.adult === 1 });
    this.db.prepare("UPDATE library SET added_at = ?, genres = ? WHERE manga_id = ?").run(row.added_at as string, row.genres as string, to.mangaId);
    this.setChapterNumbers(to.mangaId, chapters.to.map((c) => c.chapterNumber));
    this.setSeriesCategories(to.mangaId, this.seriesCategories(fromId));
    this.setChaptersRead(to.mangaId, [...readNumbers].map((n) => byNumber.get(n)?.id).filter((x): x is number => x !== undefined), true);
    const p = this.getProgress(fromId);
    const match = p ? byNumber.get(p.chapterNumber) : undefined;
    if (p && match) {
      this.saveProgress(to.mangaId, { chapterId: match.id, chapterNumber: match.chapterNumber, chapterName: match.name, pageIndex: p.pageIndex, pageOffset: p.pageOffset, finished: readNumbers.has(match.chapterNumber) });
    }
    this.db.prepare("DELETE FROM library_categories WHERE manga_id = ?").run(fromId);
    this.removeFromLibrary(fromId);
  }

  /** Remembers that another source is further ahead for a library series, unless that was already turned down. */
  offerSwitch(o: SwitchOffer): boolean {
    const old = this.db.prepare("SELECT dismissed_latest FROM switch_offers WHERE manga_id = ?").get(o.mangaId) as { dismissed_latest: number | null } | undefined;
    // Turned down before: only ask again once it's even further ahead than when you said no.
    if (old?.dismissed_latest != null && o.toLatest <= old.dismissed_latest) return false;
    this.db
      .prepare(
        `INSERT INTO switch_offers (manga_id, to_manga_id, to_source_id, to_source_name, to_latest, from_latest, created_at, dismissed_latest)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(manga_id) DO UPDATE SET to_manga_id = excluded.to_manga_id, to_source_id = excluded.to_source_id,
           to_source_name = excluded.to_source_name, to_latest = excluded.to_latest, from_latest = excluded.from_latest,
           created_at = excluded.created_at, dismissed_latest = NULL`,
      )
      .run(o.mangaId, o.toMangaId, o.toSourceId, o.toSourceName, o.toLatest, o.fromLatest, new Date().toISOString());
    return true;
  }

  switchOffers(includeAdult = false): (SwitchOffer & { title: string; fromSourceName: string | null; adult: boolean })[] {
    const rows = this.db
      .prepare(
        `SELECT o.*, l.title, l.source_name, l.adult FROM switch_offers o JOIN library l ON l.manga_id = o.manga_id
         WHERE o.dismissed_latest IS NULL ${includeAdult ? "" : "AND l.adult = 0"} ORDER BY o.created_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      mangaId: r.manga_id as number,
      toMangaId: r.to_manga_id as number,
      toSourceId: r.to_source_id as string,
      toSourceName: (r.to_source_name as string | null) ?? null,
      toLatest: r.to_latest as number,
      fromLatest: r.from_latest as number,
      title: r.title as string,
      fromSourceName: (r.source_name as string | null) ?? null,
      adult: r.adult === 1,
    }));
  }

  getSwitchOffer(mangaId: number): SwitchOffer | null {
    const r = this.db.prepare("SELECT * FROM switch_offers WHERE manga_id = ? AND dismissed_latest IS NULL").get(mangaId) as Record<string, unknown> | undefined;
    return r
      ? { mangaId, toMangaId: r.to_manga_id as number, toSourceId: r.to_source_id as string, toSourceName: (r.to_source_name as string | null) ?? null, toLatest: r.to_latest as number, fromLatest: r.from_latest as number }
      : null;
  }

  dismissSwitchOffer(mangaId: number): void {
    this.db.prepare("UPDATE switch_offers SET dismissed_latest = to_latest WHERE manga_id = ?").run(mangaId);
  }

  clearSwitchOffer(mangaId: number): void {
    this.db.prepare("DELETE FROM switch_offers WHERE manga_id = ?").run(mangaId);
  }

  recordSeriesTags(mangaId: number, tags: string[]): void {
    this.db
      .prepare("INSERT INTO series_tags (manga_id, tags, seen_at) VALUES (?, ?, ?) ON CONFLICT(manga_id) DO UPDATE SET tags = excluded.tags, seen_at = excluded.seen_at")
      .run(mangaId, JSON.stringify(tags), new Date().toISOString());
    this.tagStatsCache = null;
  }

  seriesTags(mangaId: number): string[] | null {
    const row = this.db.prepare("SELECT tags FROM series_tags WHERE manga_id = ?").get(mangaId) as { tags: string } | undefined;
    return row ? (JSON.parse(row.tags) as string[]) : null;
  }

  private tagStatsCache: { total: number; counts: Map<string, number> } | null = null;

  /** How many known series carry each tag (keys are whatever `key` maps a tag to). */
  tagStats(key: (tag: string) => string): { total: number; counts: Map<string, number> } {
    if (this.tagStatsCache) return this.tagStatsCache;
    const counts = new Map<string, number>();
    const rows = this.db.prepare("SELECT tags FROM series_tags").all() as { tags: string }[];
    for (const r of rows) {
      for (const k of new Set((JSON.parse(r.tags) as string[]).map(key))) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    this.tagStatsCache = { total: rows.length, counts };
    return this.tagStatsCache;
  }

  close(): void {
    this.db.close();
  }

  /** Writes a consistent copy of the whole database to `path` (safe while the app is running). */
  backupTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  /** Adds chapters to the download queue; ones already queued or finished are left alone. */
  queueDownloads(
    series: { mangaId: number; title: string; sourceName: string | null; adult: boolean },
    chapters: { id: number; name: string; number: number }[],
  ): number {
    const insert = this.db.prepare(
      `INSERT INTO downloads (chapter_id, manga_id, manga_title, source_name, adult, chapter_name, chapter_number, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
       ON CONFLICT(chapter_id) DO UPDATE SET status = 'queued', error = NULL WHERE downloads.status = 'failed'`,
    );
    let added = 0;
    const now = new Date().toISOString();
    for (const c of chapters) {
      const before = this.getDownload(c.id);
      insert.run(c.id, series.mangaId, series.title, series.sourceName, series.adult ? 1 : 0, c.name, c.number, now);
      if (!before || before.status === "failed") added++;
    }
    return added;
  }

  getDownload(chapterId: number): DownloadRow | null {
    const r = this.db.prepare("SELECT * FROM downloads WHERE chapter_id = ?").get(chapterId) as Record<string, unknown> | undefined;
    return r ? toDownload(r) : null;
  }

  /** The oldest chapter waiting to download. */
  nextQueuedDownload(): DownloadRow | null {
    const r = this.db.prepare("SELECT * FROM downloads WHERE status = 'queued' ORDER BY created_at, chapter_id LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    return r ? toDownload(r) : null;
  }

  setDownloadState(chapterId: number, state: { status: DownloadRow["status"]; pages?: number; bytes?: number; error?: string | null }): void {
    this.db
      .prepare("UPDATE downloads SET status = ?, pages = COALESCE(?, pages), bytes = COALESCE(?, bytes), error = ? WHERE chapter_id = ?")
      .run(state.status, state.pages ?? null, state.bytes ?? null, state.error ?? null, chapterId);
  }

  /** After a restart, anything that was mid-download goes back in the queue. */
  requeueInterruptedDownloads(): void {
    this.db.prepare("UPDATE downloads SET status = 'queued' WHERE status = 'downloading'").run();
  }

  downloads(includeAdult = false, mangaId?: number): DownloadRow[] {
    const where = [includeAdult ? "1" : "adult = 0", mangaId === undefined ? "1" : "manga_id = ?"].join(" AND ");
    const stmt = this.db.prepare(`SELECT * FROM downloads WHERE ${where} ORDER BY manga_title, chapter_number, chapter_id`);
    return (mangaId === undefined ? stmt.all() : stmt.all(mangaId)).map((r) => toDownload(r as Record<string, unknown>));
  }

  deleteDownload(chapterId: number): void {
    this.db.prepare("DELETE FROM downloads WHERE chapter_id = ?").run(chapterId);
  }

  /** Notes that a library series got new chapters, for the Updates page and the home page. */
  addUpdate(u: { mangaId: number; title: string; sourceName: string | null; adult: boolean; latestNumber: number; newCount: number; caughtUp: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO updates (manga_id, title, source_name, adult, latest_number, new_count, caught_up, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.mangaId, u.title, u.sourceName, u.adult ? 1 : 0, u.latestNumber, u.newCount, u.caughtUp ? 1 : 0, new Date().toISOString());
  }

  updates(opts: { includeAdult?: boolean; caughtUpOnly?: boolean; limit?: number } = {}): UpdateRow[] {
    const { includeAdult = false, caughtUpOnly = false, limit = 100 } = opts;
    const where = [includeAdult ? "1" : "adult = 0", caughtUpOnly ? "caught_up = 1" : "1"].join(" AND ");
    return (this.db.prepare(`SELECT * FROM updates WHERE ${where} ORDER BY detected_at DESC, id DESC LIMIT ?`).all(limit) as Record<string, unknown>[]).map((r) => ({
      mangaId: r.manga_id as number,
      title: r.title as string,
      sourceName: (r.source_name as string | null) ?? null,
      adult: r.adult === 1,
      latestNumber: r.latest_number as number,
      newCount: r.new_count as number,
      caughtUp: r.caught_up === 1,
      detectedAt: r.detected_at as string,
    }));
  }

  /** When the library was last checked for new chapters. */
  lastChecked(): string | null {
    const r = this.db.prepare("SELECT MAX(checked_at) AS t FROM library").get() as { t: string | null };
    return r.t;
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  /** Removes every setting whose key starts with this prefix. */
  deleteSettingsLike(prefix: string): void {
    this.db.prepare("DELETE FROM settings WHERE substr(key, 1, ?) = ?").run(prefix.length, prefix);
  }

  getTrackerLink(mangaId: number, service: string): TrackerLink | null {
    const r = this.db.prepare("SELECT * FROM tracker_links WHERE manga_id = ? AND service = ?").get(mangaId, service) as
      | Record<string, unknown>
      | undefined;
    return r ? { mediaId: r.media_id as number, title: r.media_title as string, syncedProgress: r.synced_progress as number } : null;
  }

  setTrackerLink(mangaId: number, service: string, mediaId: number, title: string): void {
    this.db
      .prepare(
        `INSERT INTO tracker_links (manga_id, service, media_id, media_title) VALUES (?, ?, ?, ?)
         ON CONFLICT(manga_id, service) DO UPDATE SET media_id = excluded.media_id, media_title = excluded.media_title, synced_progress = 0`,
      )
      .run(mangaId, service, mediaId, title);
  }

  markTrackerSynced(mangaId: number, service: string, progress: number): void {
    this.db.prepare("UPDATE tracker_links SET synced_progress = ? WHERE manga_id = ? AND service = ?").run(progress, mangaId, service);
  }

  removeTrackerLink(mangaId: number, service: string): void {
    this.db.prepare("DELETE FROM tracker_links WHERE manga_id = ? AND service = ?").run(mangaId, service);
  }

  getSetting(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  addToLibrary(entry: { mangaId: number; sourceId: string; sourceName: string | null; title: string; adult?: boolean }): void {
    this.db
      .prepare(
        `INSERT INTO library (manga_id, source_id, source_name, title, added_at, adult)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(manga_id) DO UPDATE SET title = excluded.title, source_name = excluded.source_name, adult = excluded.adult`,
      )
      .run(entry.mangaId, entry.sourceId, entry.sourceName, entry.title, new Date().toISOString(), entry.adult ? 1 : 0);
  }

  /** Removes a series from the library but keeps its reading history. */
  removeFromLibrary(mangaId: number): void {
    this.db.prepare("DELETE FROM library WHERE manga_id = ?").run(mangaId);
    this.db.prepare("DELETE FROM library_categories WHERE manga_id = ?").run(mangaId);
  }

  /** Remembers a series' genres so "For you" can learn what you like. */
  setGenres(mangaId: number, genres: string[]): void {
    this.db.prepare("UPDATE library SET genres = ? WHERE manga_id = ?").run(JSON.stringify(genres), mangaId);
  }

  genresKnown(mangaId: number): boolean {
    const r = this.db.prepare("SELECT genres FROM library WHERE manga_id = ?").get(mangaId) as { genres: string } | undefined;
    return !!r && r.genres !== "[]";
  }

  /** Genres across the library, weighted: series you've read count double. Most liked first. */
  tasteProfile(adult = false): { genre: string; weight: number }[] {
    const rows = this.db
      .prepare(
        `SELECT l.genres AS genres, EXISTS (SELECT 1 FROM progress p WHERE p.manga_id = l.manga_id) AS started
         FROM library l WHERE l.adult = ?`,
      )
      .all(adult ? 1 : 0) as { genres: string; started: number }[];
    const weights = new Map<string, { genre: string; weight: number }>();
    for (const r of rows) {
      for (const g of JSON.parse(r.genres) as string[]) {
        const key = g.toLowerCase();
        const entry = weights.get(key) ?? { genre: g, weight: 0 };
        entry.weight += r.started ? 2 : 1;
        weights.set(key, entry);
      }
    }
    return [...weights.values()].sort((a, b) => b.weight - a.weight || a.genre.localeCompare(b.genre));
  }

  /** Normalized titles you already have, so recommendations skip them. */
  libraryTitles(adult?: boolean): string[] {
    const rows = (adult === undefined
      ? this.db.prepare("SELECT title FROM library").all()
      : this.db.prepare("SELECT title FROM library WHERE adult = ?").all(adult ? 1 : 0)) as { title: string }[];
    return rows.map((r) => r.title);
  }

  inLibrary(mangaId: number): boolean {
    return this.db.prepare("SELECT 1 FROM library WHERE manga_id = ?").get(mangaId) !== undefined;
  }

  /** Remembers which chapters the source has, so the library can show how many are unread. */
  setChapterNumbers(mangaId: number, numbers: number[]): void {
    this.db
      .prepare("UPDATE library SET chapter_numbers = ?, checked_at = ? WHERE manga_id = ?")
      .run(JSON.stringify(numbers), new Date().toISOString(), mangaId);
  }

  /** Notes how a source answered, so the Sources page can show which ones are reliable. */
  recordSource(sourceId: string, name: string, r: { ok: boolean; ms: number; error?: string }): void {
    const now = new Date().toISOString();
    const row = this.db.prepare("SELECT avg_ms FROM source_health WHERE source_id = ?").get(sourceId) as
      | { avg_ms: number | null }
      | undefined;
    if (!row) this.db.prepare("INSERT INTO source_health (source_id, name) VALUES (?, ?)").run(sourceId, name);
    if (r.ok) {
      // Moving average, so one slow day doesn't stick forever.
      const avg = row?.avg_ms == null ? r.ms : row.avg_ms * 0.7 + r.ms * 0.3;
      this.db
        .prepare("UPDATE source_health SET name = ?, ok_count = ok_count + 1, avg_ms = ?, last_ok = ? WHERE source_id = ?")
        .run(name, avg, now, sourceId);
    } else {
      this.db
        .prepare("UPDATE source_health SET name = ?, fail_count = fail_count + 1, last_fail = ?, last_error = ? WHERE source_id = ?")
        .run(name, now, r.error ?? "unknown error", sourceId);
    }
  }

  sourceHealth(): SourceHealth[] {
    return (this.db.prepare("SELECT * FROM source_health").all() as Record<string, unknown>[]).map((r) => ({
      sourceId: r.source_id as string,
      name: r.name as string,
      okCount: r.ok_count as number,
      failCount: r.fail_count as number,
      avgMs: (r.avg_ms as number | null) ?? null,
      lastOk: (r.last_ok as string | null) ?? null,
      lastFail: (r.last_fail as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
    }));
  }

  saveProgress(mangaId: number, input: ProgressInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO progress (manga_id, chapter_id, chapter_number, chapter_name, page_index, page_offset, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(manga_id) DO UPDATE SET
           chapter_id = excluded.chapter_id, chapter_number = excluded.chapter_number,
           chapter_name = excluded.chapter_name, page_index = excluded.page_index,
           page_offset = excluded.page_offset, updated_at = excluded.updated_at`,
      )
      .run(mangaId, input.chapterId, input.chapterNumber, input.chapterName, input.pageIndex, input.pageOffset, now);
    if (input.finished) {
      this.db
        .prepare("INSERT OR IGNORE INTO chapters_read (manga_id, chapter_id, read_at) VALUES (?, ?, ?)")
        .run(mangaId, input.chapterId, now);
      this.recordReadNumbers(mangaId, [input.chapterNumber], true);
    }
  }

  getProgress(mangaId: number): Progress | null {
    const row = this.db.prepare("SELECT * FROM progress WHERE manga_id = ?").get(mangaId) as
      | Record<string, unknown>
      | undefined;
    return row ? toProgress(row) : null;
  }

  clearProgress(mangaId: number): void {
    this.db.prepare("DELETE FROM progress WHERE manga_id = ?").run(mangaId);
  }

  setChaptersRead(mangaId: number, chapterIds: number[], read: boolean): void {
    const now = new Date().toISOString();
    const add = this.db.prepare("INSERT OR IGNORE INTO chapters_read (manga_id, chapter_id, read_at) VALUES (?, ?, ?)");
    const del = this.db.prepare("DELETE FROM chapters_read WHERE manga_id = ? AND chapter_id = ?");
    for (const c of chapterIds) {
      if (read) add.run(mangaId, c, now);
      else del.run(mangaId, c);
    }
  }

  readChapterIds(mangaId: number): number[] {
    return (
      this.db.prepare("SELECT chapter_id FROM chapters_read WHERE manga_id = ?").all(mangaId) as {
        chapter_id: number;
      }[]
    ).map((r) => r.chapter_id);
  }

  /** 18+ series are left out unless `includeAdult` is set (the 18+ lock is open, or a background check). */
  library(includeAdult = false): LibraryItem[] {
    const rows = this.db
      .prepare(includeAdult ? "SELECT * FROM library" : "SELECT * FROM library WHERE adult = 0")
      .all() as Record<string, unknown>[];
    const items = rows.map<LibraryItem>((row) => {
      const mangaId = row.manga_id as number;
      const numbers = JSON.parse(row.chapter_numbers as string) as number[];
      const progress = this.getProgress(mangaId);
      const numbered = numbers.filter((n) => n >= 0);
      // A chapter counts as read once you've moved past it: everything below the one you're on,
      // plus the one you're on if you finished it.
      const lastDone = progress
        ? this.readChapterIds(mangaId).includes(progress.chapterId)
          ? progress.chapterNumber
          : progress.chapterNumber - 1e-6
        : -Infinity;
      return {
        mangaId,
        sourceId: row.source_id as string,
        sourceName: (row.source_name as string | null) ?? null,
        title: row.title as string,
        addedAt: row.added_at as string,
        adult: row.adult === 1,
        progress,
        latestNumber: numbered.length ? Math.max(...numbered) : null,
        chapterCount: numbers.length,
        unread: row.checked_at ? numbered.filter((n) => n > lastDone).length : null,
        categories: this.seriesCategories(mangaId),
      };
    });
    // Most recently read first; never-read series after those, newest addition first.
    return items.sort((a, b) =>
      (b.progress?.updatedAt ?? "").localeCompare(a.progress?.updatedAt ?? "") || b.addedAt.localeCompare(a.addedAt),
    );
  }
}

function toProgress(row: Record<string, unknown>): Progress {
  return {
    mangaId: row.manga_id as number,
    chapterId: row.chapter_id as number,
    chapterNumber: row.chapter_number as number,
    chapterName: row.chapter_name as string,
    pageIndex: row.page_index as number,
    pageOffset: row.page_offset as number,
    updatedAt: row.updated_at as string,
  };
}
