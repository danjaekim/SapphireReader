import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    }
  }

  getProgress(mangaId: number): Progress | null {
    const row = this.db.prepare("SELECT * FROM progress WHERE manga_id = ?").get(mangaId) as
      | Record<string, unknown>
      | undefined;
    return row ? toProgress(row) : null;
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
