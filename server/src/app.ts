import { createReadStream, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Config } from "./config.js";
import { checkEngine, engineFile, engineQuery } from "./engine.js";
import { AdultGate, clearedCookie, sessionCookie } from "./adult.js";
import { requestUpdate, updateInfo } from "./updater.js";
import { browseByGenres, genreSupport, listGenres } from "./browse.js";
import { changeExtension, listExtensions, refreshExtensions, type ExtensionAction } from "./extensions.js";
import { discover, recommendFor, similarTo, type DiscoverSort } from "./discover.js";
import { Downloader, mimeForFile } from "./downloader.js";
import { backupName, snapshot } from "./backup.js";
import { anilistSearch, anilistSetProgress, anilistViewer } from "./tracker.js";
import { checkLibrary } from "./checker.js";
import { createNotifier } from "./notify.js";
import { Store, type ProgressInput } from "./store.js";
import {
  fetchChapterList,
  fetchMangaDetails,
  fetchPageUrls,
  listSources,
  groupKey,
  latestFromChapters,
  searchAll,
  type Scope,
  type SourceReport,
  type ChapterInfo,
} from "./search.js";

const rawVersion = process.env.APP_VERSION ?? "dev";
// A full commit hash is unreadable in the UI; keep the short form.
export const VERSION = /^[0-9a-f]{40}$/.test(rawVersion) ? rawVersion.slice(0, 7) : rawVersion;

const LATEST_TTL_MS = 10 * 60 * 1000;

declare module "fastify" {
  interface FastifyInstance {
    /** Checks every library series for new chapters (and sends alerts). */
    downloader: Downloader;
    runCheck: (pauseMs?: number) => Promise<{ checked: number; failed: number[]; alerts: number }>;
  }
}

export interface AppOptions {
  fetchImpl?: typeof fetch;
  store?: Store;
}

/** Results come in pages (infinite scroll); anything odd means page 1. */
const pageOf = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 1;
};

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const { fetchImpl } = options;
  const store = options.store ?? new Store(":memory:");
  const notify = createNotifier(config, fetchImpl);
  const gate = new AdultGate(store);
  const downloader = new Downloader(config, store, join(config.dataDir, "downloads"), fetchImpl, app.log);
  store.requeueInterruptedDownloads();
  downloader.kick();
  app.decorate("downloader", downloader);
  // 18+ sources are only used while this browser has unlocked 18+ mode.
  const scopeFor = (req: { headers: { cookie?: string } }): Scope => (gate.unlocked(req.headers.cookie) ? "all" : "safe");
  const report: SourceReport = (source, r) => store.recordSource(source.id, source.name, r);
  const chapterCache = new Map<number, { at: number; value: ChapterInfo[] }>();
  // The chapter list comes from the source site, so it is slow; keep it for a few minutes.
  async function chaptersFor(mangaId: number): Promise<ChapterInfo[]> {
    const cached = chapterCache.get(mangaId);
    if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
    const value = await fetchChapterList(config, mangaId, fetchImpl);
    chapterCache.set(mangaId, { at: Date.now(), value });
    return value;
  }

  app.get("/api/health", async () => ({ ok: true, name: "sapphire", version: VERSION }));

  app.get("/api/status", async () => ({
    server: { ok: true, version: VERSION },
    engine: await checkEngine(config, fetchImpl),
    alerts: { enabled: notify !== null, everyHours: config.checkIntervalHours },
  }));

  app.get("/api/update", async () => updateInfo(config, VERSION, fetchImpl ?? fetch));

  app.post("/api/update", async (_req, reply) => {
    try {
      await requestUpdate(config, fetchImpl ?? fetch);
      return reply.code(202).send({ started: true });
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Couldn't start the update." });
    }
  });

  app.get<{ Querystring: { q?: string; page?: string } }>("/api/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return reply.code(400).send({ error: "Type at least 2 characters." });
    try {
      return await searchAll(config, q, { fetchImpl, onResult: report, scope: scopeFor(req), page: pageOf(req.query.page) });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  app.get("/api/adult", async (req) => ({ pinSet: gate.pinSet(), unlocked: gate.unlocked(req.headers.cookie) }));

  app.post<{ Body: { pin?: unknown; currentPin?: unknown } }>("/api/adult/pin", async (req, reply) => {
    const { pin, currentPin } = req.body ?? {};
    if (!AdultGate.validPin(pin)) return reply.code(400).send({ error: "A PIN is 4 to 8 digits." });
    // The first PIN can be set by anyone on the network; changing it needs the old one.
    if (gate.pinSet()) {
      const check = typeof currentPin === "string" ? gate.check(currentPin) : "wrong";
      if (check === "locked") return reply.code(429).send({ error: "Too many wrong tries. Wait a few minutes." });
      if (check !== "ok") return reply.code(403).send({ error: "That isn't the current PIN." });
    }
    gate.setPin(pin);
    gate.closeAll();
    return reply.header("set-cookie", sessionCookie(gate.open())).send({ pinSet: true, unlocked: true });
  });

  app.post<{ Body: { pin?: unknown } }>("/api/adult/unlock", async (req, reply) => {
    const pin = req.body?.pin;
    if (typeof pin !== "string" || !gate.pinSet()) return reply.code(400).send({ error: "Set a PIN first." });
    const check = gate.check(pin);
    if (check === "locked") return reply.code(429).send({ error: "Too many wrong tries. Wait a few minutes." });
    if (check !== "ok") return reply.code(403).send({ error: "Wrong PIN." });
    return reply.header("set-cookie", sessionCookie(gate.open())).send({ pinSet: true, unlocked: true });
  });

  app.post("/api/adult/lock", async (req, reply) => {
    gate.close(req.headers.cookie);
    return reply.header("set-cookie", clearedCookie).send({ pinSet: gate.pinSet(), unlocked: false });
  });

  // A copy of the whole library, progress and settings, for safekeeping. Includes the 18+ PIN
  // hash and the 18+ library, so it needs the lock open.
  app.get("/api/backup", async (req, reply) => {
    if (!gate.unlocked(req.headers.cookie) && gate.pinSet()) {
      return reply.code(403).send({ error: "Turn on 18+ mode (PIN) first: backups include your 18+ library." });
    }
    const file = join(tmpdir(), `sapphire-export-${Date.now()}.db`);
    try {
      store.backupTo(file);
      const bytes = readFileSync(file);
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${backupName()}"`)
        .send(bytes);
    } finally {
      rmSync(file, { force: true });
    }
  });

  // ---- Trackers (AniList) ----
  app.get("/api/trackers", async () => ({
    anilist: { connected: store.getSetting("anilist_token") !== null, user: store.getSetting("anilist_user") },
  }));

  app.put<{ Body: { token?: unknown } }>("/api/trackers/anilist", async (req, reply) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!/^[\w.-]{20,}$/.test(token)) return reply.code(400).send({ error: "That doesn't look like an AniList token." });
    try {
      const user = await anilistViewer(token, fetchImpl);
      store.setSetting("anilist_token", token);
      store.setSetting("anilist_user", user);
      return { anilist: { connected: true, user } };
    } catch (err) {
      return reply.code(400).send({ error: `AniList didn't accept that token: ${err instanceof Error ? err.message : "unknown error"}` });
    }
  });

  app.delete("/api/trackers/anilist", async () => {
    store.deleteSetting("anilist_token");
    store.deleteSetting("anilist_user");
    return { anilist: { connected: false, user: null } };
  });

  app.get<{ Querystring: { q?: string } }>("/api/trackers/anilist/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return reply.code(400).send({ error: "Type at least 2 characters." });
    try {
      return { matches: await anilistSearch(q, fetchImpl) };
    } catch (err) {
      return reply.code(502).send({ error: `AniList search failed: ${err instanceof Error ? err.message : "unknown error"}` });
    }
  });

  app.get<{ Params: { id: string } }>("/api/manga/:id/tracking", async (req) => ({
    anilist: store.getTrackerLink(Number(req.params.id), "anilist"),
  }));

  app.put<{ Params: { id: string }; Body: { mediaId?: unknown; title?: unknown } }>("/api/manga/:id/tracking", async (req, reply) => {
    const id = Number(req.params.id);
    const { mediaId, title } = req.body ?? {};
    if (!Number.isInteger(id) || !Number.isInteger(mediaId) || typeof title !== "string") return reply.code(400).send({ error: "Bad request." });
    store.setTrackerLink(id, "anilist", mediaId as number, title);
    return { anilist: store.getTrackerLink(id, "anilist") };
  });

  app.delete<{ Params: { id: string } }>("/api/manga/:id/tracking", async (req) => {
    store.removeTrackerLink(Number(req.params.id), "anilist");
    return { anilist: null };
  });

  // Pushes a finished chapter to AniList. Fire and forget: reading never waits on, or fails because of, a tracker.
  async function syncTrackers(mangaId: number, chapterNumber: number): Promise<void> {
    const token = store.getSetting("anilist_token");
    const link = store.getTrackerLink(mangaId, "anilist");
    if (!token || !link || chapterNumber < 1 || Math.floor(chapterNumber) <= link.syncedProgress) return;
    try {
      await anilistSetProgress(token, link.mediaId, chapterNumber, fetchImpl);
      store.markTrackerSynced(mangaId, "anilist", Math.floor(chapterNumber));
    } catch (err) {
      app.log.warn(err, "couldn't update AniList");
    }
  }

  // Which sources a genre request may use: the page says what it is ("safe" ordinary pages, "adult" the 18+ page);
  // anything beyond ordinary sources needs the 18+ lock open.
  const requestedScope = (req: { headers: { cookie?: string }; query: unknown }): Scope => {
    const asked = (req.query as { scope?: string }).scope;
    if (asked === "adult" || asked === "all") return gate.unlocked(req.headers.cookie) ? asked : "safe";
    if (asked === "safe") return "safe";
    return scopeFor(req);
  };

  app.get("/api/updates", async (req) => ({
    items: store.updates({ includeAdult: gate.unlocked(req.headers.cookie) }),
    lastCheckedAt: store.lastChecked(),
  }));

  // Everything the home page needs that comes from Sapphire's own database (recommendations load separately).
  app.get("/api/home", async (req) => {
    const unlocked = gate.unlocked(req.headers.cookie);
    const library = store.library(unlocked);
    const continueReading = library
      .filter((i) => i.progress && (i.unread ?? 0) > 0)
      .sort((a, b) => b.progress!.updatedAt.localeCompare(a.progress!.updatedAt))
      .slice(0, 12);
    return {
      libraryCount: library.length,
      continueReading,
      newChapters: store.updates({ includeAdult: unlocked, caughtUpOnly: true, limit: 8 }),
      lastCheckedAt: store.lastChecked(),
      alertsOn: notify !== null,
    };
  });

  app.get("/api/sources/genres", async (req, reply) => {
    try {
      return { sources: await genreSupport(config, { fetchImpl, scope: scopeFor(req) }) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  app.get("/api/genres", async (req, reply) => {
    try {
      return { genres: await listGenres(config, { fetchImpl, scope: requestedScope(req) }) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  app.get<{ Querystring: { genres?: string; q?: string; page?: string; scope?: string; seed?: string } }>("/api/browse", async (req, reply) => {
    const genres = (req.query.genres ?? "").split(",").map((g) => g.trim()).filter(Boolean).slice(0, 10);
    const q = (req.query.q ?? "").trim();
    if (genres.length === 0) return reply.code(400).send({ error: "Pick at least one genre." });
    try {
      return await browseByGenres(config, genres, { query: q, fetchImpl, onResult: report, scope: requestedScope(req), page: pageOf(req.query.page), seed: /^\d+$/.test(req.query.seed ?? "") ? Number(req.query.seed) : undefined });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  app.get("/api/extensions", async (req, reply) => {
    try {
      let list = await listExtensions(config, fetchImpl);
      // First visit: the engine hasn't downloaded the repository index yet.
      if (list.length === 0) list = await refreshExtensions(config, fetchImpl);
      return { extensions: list };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  app.post("/api/extensions/refresh", async (req, reply) => {
    try {
      return { extensions: await refreshExtensions(config, fetchImpl) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't refresh the extension list." });
    }
  });

  app.post<{ Params: { pkg: string; action: string } }>("/api/extensions/:pkg/:action", async (req, reply) => {
    const { pkg, action } = req.params;
    if (!/^[A-Za-z0-9_.]+$/.test(pkg) || !["install", "update", "uninstall"].includes(action)) {
      return reply.code(400).send({ error: "Bad request." });
    }
    try {
      return { extension: await changeExtension(config, pkg, action as ExtensionAction, fetchImpl) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: `Couldn't ${action} that extension: ${err instanceof Error ? err.message : "engine error"}` });
    }
  });

  // Installed sources with how reliably each has answered lately.
  app.get("/api/sources", async (req, reply) => {
    try {
      const health = new Map(store.sourceHealth().map((h) => [h.sourceId, h]));
      const open = gate.unlocked(req.headers.cookie);
      const seen = new Set<string>();
      const sources = (await listSources(config, fetchImpl))
        .filter((s) => (s.lang === "en" || s.lang === "all") && s.name !== "Local source")
        .filter((s) => (open || !s.isNsfw) && !seen.has(s.id) && !!seen.add(s.id))
        .map((s) => ({ ...s, health: health.get(s.id) ?? null }));
      return { sources };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // Asks each source for its popular list, timing the answer, so health is current.
  app.post("/api/sources/check", async (req, reply) => {
    try {
      const sources = (await listSources(config, fetchImpl)).filter((s) => s.lang === "en" || s.lang === "all");
      await Promise.all(
        sources.map(async (s) => {
          const started = Date.now();
          try {
            await engineQuery(
              config,
              `mutation ($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { mangas { id } } }`,
              { input: { source: s.id, type: "POPULAR", page: 1 } },
              { fetchImpl, timeoutMs: 15000 },
            );
            report(s, { ok: true, ms: Date.now() - started });
          } catch (err) {
            report(s, { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : "unknown error" });
          }
        }),
      );
      return { ok: true };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // The same series on other sources, so you can see when another site is further ahead.
  app.get<{ Params: { id: string } }>("/api/manga/:id/alternatives", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const manga = await fetchMangaDetails(config, id, fetchImpl);
      const found = await searchAll(config, manga.title, { fetchImpl, onResult: report, scope: scopeFor(req) });
      const hits = (found.groups.find((g) => g.key === groupKey(manga.title))?.hits ?? [])
        .filter((h) => h.mangaId !== id && h.sourceId !== manga.sourceId)
        .slice(0, 6);
      const alternatives = await Promise.all(
        hits.map(async (h) => {
          try {
            const latest = latestFromChapters(await chaptersFor(h.mangaId));
            return { mangaId: h.mangaId, sourceName: h.sourceName, ...latest };
          } catch {
            return null;
          }
        }),
      );
      return {
        alternatives: alternatives
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .sort((a, b) => (b.latestNumber ?? -1) - (a.latestNumber ?? -1)),
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't look for other sources." });
    }
  });

  app.get<{ Querystring: { sort?: string; adult?: string; page?: string } }>("/api/discover", async (req, reply) => {
    const sort: DiscoverSort = req.query.sort === "latest" ? "latest" : "popular";
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    try {
      return await discover(config, sort, { fetchImpl, onResult: report, scope: adult ? "adult" : "safe", page: pageOf(req.query.page) });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // "For you" learns from the genres of what's in your library; cached so the page opens fast.
  // The 18+ page has its own taste profile and never mixes with the ordinary one.
  const forYouCache = new Map<boolean, { at: number; key: string; value: unknown }>();
  app.get<{ Querystring: { adult?: string } }>("/api/for-you", async (req, reply) => {
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const profile = store.tasteProfile(adult);
    const titles = store.libraryTitles(adult);
    const key = JSON.stringify([profile.slice(0, 3), titles.length]);
    const cached = forYouCache.get(adult);
    if (cached && cached.key === key && Date.now() - cached.at < 60 * 60 * 1000) return cached.value;
    try {
      const value = await recommendFor(config, profile, titles, { fetchImpl, onResult: report, scope: adult ? "adult" : "safe" });
      forYouCache.set(adult, { at: Date.now(), key, value });
      return value;
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  const similarCache = new Map<string, { at: number; groups: unknown[] }>();
  app.get<{ Params: { id: string } }>("/api/manga/:id/similar", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const manga = await fetchMangaDetails(config, id, fetchImpl);
      const scope = scopeFor(req);
      const key = `${id}|${scope}`;
      const cached = similarCache.get(key);
      if (cached && Date.now() - cached.at < 60 * 60 * 1000) return { groups: cached.groups };
      const groups = await similarTo(config, manga.title, manga.genre, { fetchImpl, onResult: report, scope });
      if (groups.length > 0) similarCache.set(key, { at: Date.now(), groups });
      return { groups };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't find similar series." });
    }
  });

  app.get<{ Params: { id: string } }>("/api/manga/:id/latest", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      return latestFromChapters(await chaptersFor(id));
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load chapters from the source." });
    }
  });

  app.get<{ Params: { id: string } }>("/api/manga/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const [manga, chapters] = await Promise.all([fetchMangaDetails(config, id, fetchImpl), chaptersFor(id)]);
      if (store.inLibrary(id)) {
        store.setChapterNumbers(id, chapters.map((c) => c.chapterNumber));
        store.setGenres(id, manga.genre);
      }
      return {
        manga,
        chapters,
        latest: latestFromChapters(chapters),
        inLibrary: store.inLibrary(id),
        progress: store.getProgress(id),
        readChapterIds: store.readChapterIds(id),
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load this series from the source." });
    }
  });

  // ---- Downloads ----
  app.get("/api/downloads", async (req) => {
    const items = store.downloads(gate.unlocked(req.headers.cookie));
    return { items, totalBytes: items.reduce((n, d) => n + d.bytes, 0) };
  });

  // Which of one series' chapters are saved (for the chapter list and the reader).
  app.get<{ Params: { id: string } }>("/api/manga/:id/downloads", async (req) => ({
    items: store.downloads(true, Number(req.params.id)).map((d) => ({ chapterId: d.chapterId, status: d.status, error: d.error })),
  }));

  app.post<{
    Body: {
      mangaId?: unknown;
      title?: unknown;
      sourceId?: unknown;
      sourceName?: unknown;
      chapters?: { id?: unknown; name?: unknown; number?: unknown }[];
    };
  }>("/api/downloads", async (req, reply) => {
    const b = req.body ?? {};
    const chapters = Array.isArray(b.chapters) ? b.chapters : [];
    const valid =
      Number.isInteger(b.mangaId) &&
      typeof b.title === "string" &&
      chapters.length > 0 &&
      chapters.length <= 500 &&
      chapters.every((c) => Number.isInteger(c.id) && typeof c.name === "string" && typeof c.number === "number");
    if (!valid) return reply.code(400).send({ error: "Bad request." });
    const sourceId = String(b.sourceId ?? "");
    const adult = (await listSources(config, fetchImpl).catch(() => [])).find((s) => s.id === sourceId)?.isNsfw === true;
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const queued = store.queueDownloads(
      { mangaId: b.mangaId as number, title: b.title as string, sourceName: typeof b.sourceName === "string" ? b.sourceName : null, adult },
      chapters.map((c) => ({ id: c.id as number, name: c.name as string, number: c.number as number })),
    );
    downloader.kick();
    return { queued };
  });

  app.delete<{ Params: { id: string } }>("/api/downloads/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Bad id." });
    const row = store.getDownload(id);
    if (row?.status === "downloading") return reply.code(409).send({ error: "That chapter is downloading right now." });
    downloader.remove(id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/downloads/series/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Bad id." });
    for (const d of store.downloads(true, id)) if (d.status !== "downloading") downloader.remove(d.chapterId);
    return { ok: true };
  });

  // A saved page, served from the NAS disk.
  app.get<{ Params: { chapter: string; page: string } }>("/api/dl/:chapter/:page", async (req, reply) => {
    const chapter = Number(req.params.chapter);
    const page = Number(req.params.page);
    const row = Number.isInteger(chapter) ? store.getDownload(chapter) : null;
    const file = row?.status === "done" && Number.isInteger(page) ? downloader.pageFile(row.mangaId, chapter, page) : null;
    if (!file) return reply.code(404).send({ error: "Page not saved." });
    return reply.header("content-type", mimeForFile(file)).header("cache-control", "public, max-age=604800, immutable").send(createReadStream(file));
  });

  app.get<{ Params: { id: string } }>("/api/chapters/:id/pages", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const saved = store.getDownload(id);
    if (saved?.status === "done" && saved.pages > 0) {
      return { pages: Array.from({ length: saved.pages }, (_, i) => `/api/dl/${id}/${i}`), downloaded: true };
    }
    try {
      return { pages: await fetchPageUrls(config, id, fetchImpl) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load this chapter's pages from the source." });
    }
  });

  // One page image, proxied so the engine never has to be reachable from the reading device.
  app.get<{ Params: { manga: string; chapter: string; page: string } }>(
    "/api/read/:manga/:chapter/:page",
    async (req, reply) => {
      const { manga, chapter, page } = req.params;
      if (![manga, chapter, page].every((v) => /^\d+$/.test(v))) return reply.code(400).send({ error: "Bad address." });
      try {
        const res = await engineFile(config, `/api/v1/manga/${manga}/chapter/${chapter}/page/${page}`, fetchImpl);
        if (!res.ok) return reply.code(404).send({ error: "Page not available." });
        return reply
          .header("content-type", res.headers.get("content-type") ?? "image/jpeg")
          .header("cache-control", "public, max-age=604800, immutable")
          .send(Buffer.from(await res.arrayBuffer()));
      } catch (err) {
        req.log.error(err);
        return reply.code(502).send({ error: "Page unavailable." });
      }
    },
  );

  app.get("/api/library", async (req) => ({ items: store.library(gate.unlocked(req.headers.cookie)) }));

  app.put<{ Params: { id: string }; Body: { sourceId?: string; sourceName?: string | null; title?: string } }>(
    "/api/library/:id",
    async (req, reply) => {
      const id = Number(req.params.id);
      const { sourceId, sourceName = null, title } = req.body ?? {};
      if (!Number.isInteger(id) || id < 0 || !sourceId || !title) return reply.code(400).send({ error: "Bad request." });
      const adult = (await listSources(config, fetchImpl).catch(() => [])).find((s) => s.id === sourceId)?.isNsfw === true;
      if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
      store.addToLibrary({ mangaId: id, sourceId, sourceName, title, adult });
      try {
        const chapters = await chaptersFor(id);
        store.setChapterNumbers(id, chapters.map((c) => c.chapterNumber));
        store.setGenres(id, (await fetchMangaDetails(config, id, fetchImpl)).genre);
      } catch (err) {
        req.log.warn(err); // Added anyway; the chapter counts fill in next time the series loads.
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/library/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    store.removeFromLibrary(id);
    return { ok: true };
  });

  // Re-reads every library series from its source; the same check the scheduler runs.
  let checking: Promise<unknown> | null = null;
  const runCheck = (pauseMs?: number) => {
    checking ??= checkLibrary({
      config,
      store,
      notify,
      pauseMs,
      log: app.log,
      loadNumbers: async (id) => {
        chapterCache.delete(id);
        const numbers = (await chaptersFor(id)).map((c) => c.chapterNumber);
        // Older library entries have no genres yet; fill them in so "For you" can learn from them.
        if (!store.genresKnown(id)) {
          await fetchMangaDetails(config, id, fetchImpl).then((m) => store.setGenres(id, m.genre), () => {});
        }
        return numbers;
      },
    }).finally(() => {
      checking = null;
    });
    return checking as ReturnType<typeof checkLibrary>;
  };
  app.decorate("runCheck", runCheck);

  app.post("/api/library/refresh", async (req) => {
    const unlocked = gate.unlocked(req.headers.cookie);
    const result = await runCheck(0);
    return { items: store.library(unlocked), failed: result.failed };
  });

  app.post("/api/notify/test", async (_req, reply) => {
    if (!notify) return reply.code(400).send({ error: "Alerts aren't set up. Set NTFY_URL on the Sapphire container." });
    try {
      await notify({ title: "Sapphire", message: "Test alert. Push notifications are working.", click: config.publicUrl || undefined });
      return { ok: true };
    } catch (err) {
      return reply.code(502).send({ error: `Couldn't reach ntfy: ${err instanceof Error ? err.message : "unknown error"}` });
    }
  });

  app.put<{ Params: { id: string }; Body: Partial<ProgressInput> }>("/api/progress/:id", async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const valid =
      Number.isInteger(id) &&
      id >= 0 &&
      Number.isInteger(b.chapterId) &&
      typeof b.chapterNumber === "number" &&
      typeof b.chapterName === "string" &&
      Number.isInteger(b.pageIndex) &&
      typeof b.pageOffset === "number";
    if (!valid) return reply.code(400).send({ error: "Bad request." });
    store.saveProgress(id, {
      chapterId: b.chapterId!,
      chapterNumber: b.chapterNumber!,
      chapterName: b.chapterName!,
      pageIndex: Math.max(0, b.pageIndex!),
      pageOffset: Math.min(1, Math.max(0, b.pageOffset!)),
      finished: b.finished === true,
    });
    if (b.finished === true) void syncTrackers(id, b.chapterNumber!);
    return { ok: true };
  });

  // Covers are served through Sapphire so the engine never needs to be reachable from devices.
  app.get<{ Params: { id: string } }>("/api/manga/:id/thumbnail", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const local = downloader.coverFile(id);
    if (local) {
      return reply.header("content-type", mimeForFile(local)).header("cache-control", "public, max-age=86400").send(createReadStream(local));
    }
    try {
      const res = await engineFile(config, `/api/v1/manga/${id}/thumbnail`, fetchImpl);
      if (!res.ok) return reply.code(404).send({ error: "No cover." });
      const type = res.headers.get("content-type") ?? "image/jpeg";
      return reply
        .header("content-type", type)
        .header("cache-control", "public, max-age=86400")
        .send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Cover unavailable." });
    }
  });

  const webDir = resolve(config.webDir);
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    // Single-page app: any non-API path serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
