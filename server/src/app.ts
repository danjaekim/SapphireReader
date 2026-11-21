import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Config } from "./config.js";
import { checkEngine, engineFile } from "./engine.js";
import { checkLibrary } from "./checker.js";
import { createNotifier } from "./notify.js";
import { Store, type ProgressInput } from "./store.js";
import {
  fetchChapterList,
  fetchMangaDetails,
  fetchPageUrls,
  latestFromChapters,
  searchAll,
  type ChapterInfo,
} from "./search.js";

const rawVersion = process.env.APP_VERSION ?? "dev";
// A full commit hash is unreadable in the UI; keep the short form.
export const VERSION = /^[0-9a-f]{40}$/.test(rawVersion) ? rawVersion.slice(0, 7) : rawVersion;

const LATEST_TTL_MS = 10 * 60 * 1000;

declare module "fastify" {
  interface FastifyInstance {
    /** Checks every library series for new chapters (and sends alerts). */
    runCheck: (pauseMs?: number) => Promise<{ checked: number; failed: number[]; alerts: number }>;
  }
}

export interface AppOptions {
  fetchImpl?: typeof fetch;
  store?: Store;
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const { fetchImpl } = options;
  const store = options.store ?? new Store(":memory:");
  const notify = createNotifier(config, fetchImpl);
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

  app.get<{ Querystring: { q?: string } }>("/api/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return reply.code(400).send({ error: "Type at least 2 characters." });
    try {
      return await searchAll(config, q, { fetchImpl });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
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
      if (store.inLibrary(id)) store.setChapterNumbers(id, chapters.map((c) => c.chapterNumber));
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

  app.get<{ Params: { id: string } }>("/api/chapters/:id/pages", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
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

  app.get("/api/library", async () => ({ items: store.library() }));

  app.put<{ Params: { id: string }; Body: { sourceId?: string; sourceName?: string | null; title?: string } }>(
    "/api/library/:id",
    async (req, reply) => {
      const id = Number(req.params.id);
      const { sourceId, sourceName = null, title } = req.body ?? {};
      if (!Number.isInteger(id) || id < 0 || !sourceId || !title) return reply.code(400).send({ error: "Bad request." });
      store.addToLibrary({ mangaId: id, sourceId, sourceName, title });
      try {
        const chapters = await chaptersFor(id);
        store.setChapterNumbers(id, chapters.map((c) => c.chapterNumber));
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
        return (await chaptersFor(id)).map((c) => c.chapterNumber);
      },
    }).finally(() => {
      checking = null;
    });
    return checking as ReturnType<typeof checkLibrary>;
  };
  app.decorate("runCheck", runCheck);

  app.post("/api/library/refresh", async () => {
    const result = await runCheck(0);
    return { items: store.library(), failed: result.failed };
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
    return { ok: true };
  });

  // Covers are served through Sapphire so the engine never needs to be reachable from devices.
  app.get<{ Params: { id: string } }>("/api/manga/:id/thumbnail", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
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
