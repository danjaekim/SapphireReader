import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LibraryEntry {
  mangaId: number;
  sourceId: string;
  sourceName: string | null;
  title: string;
  addedAt: string;
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
    try {
      this.db.exec("ALTER TABLE library ADD COLUMN genres TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* column already exists */
    }
  }

  close(): void {
    this.db.close();
  }

  addToLibrary(entry: { mangaId: number; sourceId: string; sourceName: string | null; title: string }): void {
    this.db
      .prepare(
        `INSERT INTO library (manga_id, source_id, source_name, title, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(manga_id) DO UPDATE SET title = excluded.title, source_name = excluded.source_name`,
      )
      .run(entry.mangaId, entry.sourceId, entry.sourceName, entry.title, new Date().toISOString());
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
  tasteProfile(): { genre: string; weight: number }[] {
    const rows = this.db
      .prepare(
        `SELECT l.genres AS genres, EXISTS (SELECT 1 FROM progress p WHERE p.manga_id = l.manga_id) AS started FROM library l`,
      )
      .all() as { genres: string; started: number }[];
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
  libraryTitles(): string[] {
    return (this.db.prepare("SELECT title FROM library").all() as { title: string }[]).map((r) => r.title);
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

  library(): LibraryItem[] {
    const rows = this.db.prepare("SELECT * FROM library").all() as Record<string, unknown>[];
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
