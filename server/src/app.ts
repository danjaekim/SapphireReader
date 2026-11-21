import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { Config } from "./config.js";
import { checkEngine, engineFile } from "./engine.js";
import { latestChapter, searchAll, type LatestChapter } from "./search.js";

const rawVersion = process.env.APP_VERSION ?? "dev";
// A full commit hash is unreadable in the UI; keep the short form.
export const VERSION = /^[0-9a-f]{40}$/.test(rawVersion) ? rawVersion.slice(0, 7) : rawVersion;

const LATEST_TTL_MS = 10 * 60 * 1000;

export interface AppOptions {
  fetchImpl?: typeof fetch;
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const { fetchImpl } = options;
  const latestCache = new Map<number, { at: number; value: LatestChapter }>();

  app.get("/api/health", async () => ({ ok: true, name: "sapphire", version: VERSION }));

  app.get("/api/status", async () => ({
    server: { ok: true, version: VERSION },
    engine: await checkEngine(config, fetchImpl),
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

  // The chapter list comes from the source site, so it is slow; cache it briefly.
  app.get<{ Params: { id: string } }>("/api/manga/:id/latest", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const cached = latestCache.get(id);
    if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
    try {
      const value = await latestChapter(config, id, fetchImpl);
      latestCache.set(id, { at: Date.now(), value });
      return value;
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load chapters from the source." });
    }
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
