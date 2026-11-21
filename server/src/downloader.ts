import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { engineFile } from "./engine.js";
import { fetchPageUrls } from "./search.js";
import type { Store } from "./store.js";

type FetchLike = typeof fetch;

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg" };
const MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const PAGE_WORKERS = 3;

export const mimeForFile = (file: string) => MIME[file.split(".").pop() ?? ""] ?? "image/jpeg";

/** Saves chapters to the NAS disk, one chapter at a time, so they open without asking the source site. */
export class Downloader {
  private running: Promise<void> | null = null;

  constructor(
    private config: Config,
    private store: Store,
    private root: string,
    private fetchImpl?: FetchLike,
    private log?: { warn: (o: unknown, m?: string) => void },
  ) {}

  chapterDir(mangaId: number, chapterId: number) {
    return join(this.root, String(mangaId), String(chapterId));
  }

  /** The file for one saved page, or null. */
  pageFile(mangaId: number, chapterId: number, page: number): string | null {
    const dir = this.chapterDir(mangaId, chapterId);
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find((f) => f.split(".")[0] === String(page));
    return file ? join(dir, file) : null;
  }

  coverFile(mangaId: number): string | null {
    const dir = join(this.root, String(mangaId));
    if (!existsSync(dir)) return null;
    const file = readdirSync(dir).find((f) => f.startsWith("cover."));
    return file ? join(dir, file) : null;
  }

  /** Starts working through the queue if it isn't already. */
  kick(): void {
    this.running ??= this.loop().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when the queue is empty (used by tests). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async loop(): Promise<void> {
    for (let row = this.store.nextQueuedDownload(); row; row = this.store.nextQueuedDownload()) {
      this.store.setDownloadState(row.chapterId, { status: "downloading" });
      try {
        const { pages, bytes } = await this.fetchChapter(row.mangaId, row.chapterId);
        this.store.setDownloadState(row.chapterId, { status: "done", pages, bytes });
      } catch (err) {
        rmSync(this.chapterDir(row.mangaId, row.chapterId), { recursive: true, force: true });
        this.log?.warn(err, `download of chapter ${row.chapterId} failed`);
        this.store.setDownloadState(row.chapterId, { status: "failed", error: err instanceof Error ? err.message : "unknown error" });
      }
    }
  }

  private async fetchChapter(mangaId: number, chapterId: number): Promise<{ pages: number; bytes: number }> {
    // The page list gives engine addresses like /api/read/<manga>/<chapter index>/<page>.
    const urls = await fetchPageUrls(this.config, chapterId, this.fetchImpl);
    if (urls.length === 0) throw new Error("the source returned no pages");
    const dir = this.chapterDir(mangaId, chapterId);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await this.saveCover(mangaId);

    let bytes = 0;
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < urls.length; i = next++) {
        const m = /^\/api\/read\/(\d+)\/(\d+)\/(\d+)$/.exec(urls[i])!;
        const res = await engineFile(this.config, `/api/v1/manga/${m[1]}/chapter/${m[2]}/page/${m[3]}`, this.fetchImpl);
        if (!res.ok) throw new Error(`page ${i + 1} answered ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) throw new Error(`page ${i + 1} was empty`);
        const ext = EXT[(res.headers.get("content-type") ?? "").split(";")[0]] ?? "jpg";
        writeFileSync(join(dir, `${i}.${ext}`), buf);
        bytes += buf.length;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_WORKERS, urls.length) }, worker));
    return { pages: urls.length, bytes };
  }

  private async saveCover(mangaId: number): Promise<void> {
    if (this.coverFile(mangaId)) return;
    try {
      const res = await engineFile(this.config, `/api/v1/manga/${mangaId}/thumbnail`, this.fetchImpl);
      if (!res.ok) return;
      const ext = EXT[(res.headers.get("content-type") ?? "").split(";")[0]] ?? "jpg";
      writeFileSync(join(this.root, String(mangaId), `cover.${ext}`), Buffer.from(await res.arrayBuffer()));
    } catch {
      /* a missing cover isn't worth failing the chapter */
    }
  }

  /** Removes one chapter's files and record; the cover goes when the series has nothing left. */
  remove(chapterId: number): void {
    const row = this.store.getDownload(chapterId);
    if (!row) return;
    rmSync(this.chapterDir(row.mangaId, chapterId), { recursive: true, force: true });
    this.store.deleteDownload(chapterId);
    if (this.store.downloads(true, row.mangaId).length === 0) {
      rmSync(join(this.root, String(row.mangaId)), { recursive: true, force: true });
    }
  }
}
