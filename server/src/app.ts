import { createReadStream, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import type { Config } from "./config.js";
import { checkEngine, engineFile, engineQuery } from "./engine.js";
import { AdultGate, clearedCookie, sessionCookie } from "./adult.js";
import { clearUpdateCache, requestUpdate, updateInfo } from "./updater.js";
import { rankByAnilist, ratingsFor, type RatingMeta } from "./ratings.js";
import { parseDescription } from "./description.js";
import { canonKey, canonLabel } from "./genres.js";
import { classifyAdult } from "./adultcheck.js";
import { clearEngineUpdateCache, engineUpdateInfo, requestEngineUpdate } from "./engineupdate.js";
import { browseByGenres, genreSupport, listGenres, SORT_KEYS, type SortKey } from "./browse.js";
import { changeExtension, listExtensions, refreshExtensions, type ExtensionAction } from "./extensions.js";
import { alsoLiked } from "./alsoliked.js";
import { deepRecommendations } from "./deep.js";
import { discover, FAVORITES_ID, FAVORITES_WEIGHT, recommendShelves, similarTo, tagWeights, type DiscoverSort, type LikedSeries } from "./discover.js";
import { Downloader, mimeForFile } from "./downloader.js";
import { backupName, snapshot } from "./backup.js";
import { anilistSearch, anilistSetProgress, anilistViewer } from "./tracker.js";
import { checkLibrary } from "./checker.js";
import { createNotifier } from "./notify.js";
import { Store, type ProgressInput, type SwitchOffer } from "./store.js";
import {
  fetchChapterList,
  fetchMangaDetails,
  type MangaDetails,
  onSeriesTags,
  fetchPageUrls,
  listSources,
  inScope,
  setAdultOverrides,
  setTitleAliases,
  rawTitleKey,
  displayTitle,
  primaryCover,
  primaryDescription,
  seenTitle,
  adultOverrideFor,
  groupKey,
  latestFromChapters,
  searchAll,
  rankByQuery,
  type EngineSource,
  type Scope,
  type SearchResult,
  type SourceReport,
  type ChapterInfo,
  type SeriesGroup,
  normalizeTitle,
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
  // Smaller API and app downloads, which matters most on a phone over Tailscale. Images are left alone.
  await app.register(fastifyCompress, { global: true, threshold: 1024, encodings: ["br", "gzip"] });
  const { fetchImpl } = options;
  const store = options.store ?? new Store(":memory:");
  // Remember the tags of every series looked at, so Similar can learn which tags are telling.
  onSeriesTags((mangaId, tags) => {
    try {
      store.recordSeriesTags(mangaId, tags);
    } catch {
      // Best effort.
    }
  });
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
  // A search card and the series page opened from it ask for the same list; share one request.
  const chaptersInFlight = new Map<number, Promise<ChapterInfo[]>>();
  async function chaptersFor(mangaId: number): Promise<ChapterInfo[]> {
    const cached = chapterCache.get(mangaId);
    if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.value;
    const running = chaptersInFlight.get(mangaId);
    if (running) return running;
    const job = fetchChapterList(config, mangaId, fetchImpl).then((value) => {
      chapterCache.set(mangaId, { at: Date.now(), value });
      return value;
    });
    chaptersInFlight.set(mangaId, job);
    const done = () => chaptersInFlight.delete(mangaId);
    job.then(done, done);
    return job;
  }

  // Series details come from the source site too (and the reader asks for them on every chapter),
  // so keep them for a while. The library check and an explicit refresh bypass this.
  const detailsCache = new Map<number, { at: number; value: Promise<MangaDetails> }>();
  function detailsFor(mangaId: number, fresh = false): Promise<MangaDetails> {
    const cached = detailsCache.get(mangaId);
    if (!fresh && cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.value;
    const value = fetchMangaDetails(config, mangaId, fetchImpl);
    detailsCache.set(mangaId, { at: Date.now(), value });
    value.catch(() => detailsCache.delete(mangaId));
    return value;
  }

  app.get("/api/health", async () => ({ ok: true, name: "sapphire", version: VERSION }));

  app.get("/api/status", async () => ({
    server: { ok: true, version: VERSION },
    engine: await checkEngine(config, fetchImpl),
    alerts: { enabled: notify !== null, everyHours: config.checkIntervalHours },
  }));

  // ?refresh=1 skips the 10-minute memory of GitHub's answer, for the "Check for updates" button.
  app.get<{ Querystring: { refresh?: string } }>("/api/update", async (req) => {
    if (req.query.refresh === "1") clearUpdateCache();
    return { ...(await updateInfo(config, VERSION, fetchImpl ?? fetch)), current: VERSION };
  });

  // The engine (Suwayomi) has its own version and its own update button.
  app.get<{ Querystring: { refresh?: string } }>("/api/engine-update", async (req) => {
    if (req.query.refresh === "1") clearEngineUpdateCache();
    const status = await checkEngine(config, fetchImpl);
    return engineUpdateInfo(config, status.reachable ? status.version : undefined, fetchImpl ?? fetch);
  });

  app.post("/api/engine-update", async (_req, reply) => {
    try {
      await requestEngineUpdate(config, fetchImpl ?? fetch);
      return reply.code(202).send({ started: true });
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Couldn't start the engine update." });
    }
  });

  app.post("/api/update", async (_req, reply) => {
    try {
      await requestUpdate(config, fetchImpl ?? fetch);
      return reply.code(202).send({ started: true });
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "Couldn't start the update." });
    }
  });

  // "Top rated" and "Most popular" use AniList's numbers, the same yardstick for every site
  // (each site's own order is the fallback for series AniList doesn't know).
  async function ranked<T extends { groups: SeriesGroup[] }>(result: T, sort: string): Promise<T> {
    if (sort !== "rating" && sort !== "popular") return result;
    return { ...result, groups: await rankByAnilist(store, result.groups, sort, fetchImpl) };
  }

  // AniList scores for a few titles at a time, so cards can show them without slowing the lists down.
  app.post<{ Body: { titles?: unknown; alts?: unknown } }>("/api/ratings", async (req, reply) => {
    const titles = Array.isArray(req.body?.titles) ? (req.body!.titles as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0).slice(0, 60) : [];
    if (titles.length === 0) return reply.code(400).send({ error: "No titles." });
    // Other names for a title (from its description), tried when the main title finds nothing.
    const alts: Record<string, string[]> = {};
    if (req.body?.alts && typeof req.body.alts === "object") {
      for (const [t, list] of Object.entries(req.body.alts as Record<string, unknown>)) {
        if (Array.isArray(list)) alts[t] = list.filter((a): a is string => typeof a === "string").slice(0, 15);
      }
    }
    const meta = await ratingsFor(store, titles, fetchImpl, alts).catch(() => new Map<string, RatingMeta>());
    const out: Record<string, { score: number | null; popularity: number | null; banner: string | null; mu: number | null }> = {};
    for (const t of titles) {
      const m = meta.get(normalizeTitle(t));
      // Only AniList's own image host, so a page never loads art from somewhere unexpected.
      const banner = m?.banner && /^https:\/\/s\d*\.anilist\.co\//.test(m.banner) ? m.banner : null;
      out[t] = { score: m?.score ?? null, popularity: m?.popularity ?? null, banner, mu: m?.mu ?? null };
    }
    return { ratings: out };
  });

  // Which sources get each of their series checked for adult content (the default). Off for ones you've settled.
  const noCheck = (): Set<string> => {
    try {
      return new Set(JSON.parse(store.getSetting("source_nocheck") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  };
  /** Whether a source is an 18+ one (by the extension's flag or your setting for the source). */
  const adultSourceOf = async (sourceId: string) => (await listSources(config, fetchImpl).catch(() => [])).find((x) => x.id === sourceId)?.isNsfw === true;
  /** Adult or not: your mark on the title wins, otherwise its source decides. */
  const adultFor = async (sourceId: string, title: string) => store.adultMark(title) ?? (await adultSourceOf(sourceId));

  // --- Hidden tags: series with any of these tags never show up in lists ----------------------------
  function tagSetting(key: string): string[] {
    try {
      const v = JSON.parse(store.getSetting(key) ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && t.trim().length > 0) : [];
    } catch {
      return [];
    }
  }
  /** One entry per genre, however it was typed ("BL", "Yaoi" and "Boys' Love" are the same one). */
  function cleanTags(raw: unknown): string[] | null {
    if (!Array.isArray(raw) || raw.some((t) => typeof t !== "string")) return null;
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const t of raw as string[]) {
      const name = canonLabel(t.trim()).slice(0, 60);
      const key = canonKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tags.push(name);
    }
    return tags.slice(0, 100);
  }
  const hiddenTags = () => tagSetting("hidden_tags");
  app.get("/api/settings/hidden-tags", async () => ({ tags: hiddenTags() }));
  app.put<{ Body: { tags?: unknown } }>("/api/settings/hidden-tags", async (req, reply) => {
    const tags = cleanTags(req.body?.tags);
    if (!tags) return reply.code(400).send({ error: "tags is a list of names." });
    store.setSetting("hidden_tags", JSON.stringify(tags));
    similarCache.clear();
    return { tags: hiddenTags() };
  });

  // --- Favorite tags: count strongly toward "For you". The 18+ page keeps its own list. -------------
  const favoriteTags = (adult: boolean) => tagSetting(adult ? "favorite_tags.adult" : "favorite_tags");
  app.get<{ Querystring: { adult?: string } }>("/api/settings/favorite-tags", async (req, reply) => {
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    return { tags: favoriteTags(adult) };
  });
  app.put<{ Querystring: { adult?: string }; Body: { tags?: unknown } }>("/api/settings/favorite-tags", async (req, reply) => {
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const tags = cleanTags(req.body?.tags);
    if (!tags) return reply.code(400).send({ error: "tags is a list of names." });
    store.setSetting(adult ? "favorite_tags.adult" : "favorite_tags", JSON.stringify(tags));
    return { tags: favoriteTags(adult) };
  });
  /**
   * What "For you" learns from: the series you like, plus your favorite tags as one stand-in series
   * that counts as much as a few liked ones (it has no id or title, so rows from it say "favorite tags").
   */
  function tasteSignals(adult: boolean): LikedSeries[] {
    const liked = store.likedSeries(adult);
    const favs = favoriteTags(adult);
    return favs.length > 0 ? [...liked, { mangaId: FAVORITES_ID, title: "", tags: favs, weight: FAVORITES_WEIGHT }] : liked;
  }

  /**
   * Which of these series carry a hidden tag. Tags already seen are used as they are; the rest are
   * read from the source once (a few at a time) and remembered for next time.
   */
  async function withHiddenTags(ids: number[]): Promise<Set<number>> {
    const out = new Set<number>();
    const blocked = new Set(hiddenTags().map(canonKey));
    if (blocked.size === 0 || ids.length === 0) return out;
    const hit = (tags: string[]) => tags.some((t) => blocked.has(canonKey(t)));
    const queue: number[] = [];
    for (const id of ids) {
      const tags = store.seriesTags(id);
      if (tags && tags.length > 0) {
        if (hit(tags)) out.add(id);
      } else queue.push(id);
    }
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          try {
            const tags = (await detailsFor(id)).genre ?? [];
            if (tags.length > 0) store.recordSeriesTags(id, tags);
            if (hit(tags)) out.add(id);
          } catch {
            // Unknown tags: leave it showing.
          }
        }
      }),
    );
    return out;
  }

  // Say which of these series should be hidden: ones with a hidden tag, and (while 18+ mode is off)
  // adult series that mixed sites list among ordinary ones. Each answer is worked out once and remembered.
  app.post<{ Body: { items?: unknown } }>("/api/classify", async (req) => {
    const locked = !gate.unlocked(req.headers.cookie);
    const hasHidden = hiddenTags().length > 0;
    if (!locked && !hasHidden) return { hide: {} };
    const raw = Array.isArray(req.body?.items) ? (req.body!.items as unknown[]) : [];
    const items = raw
      .filter((i): i is { mangaId: number; title: string; sourceId?: string } => typeof i === "object" && i !== null && Number.isInteger((i as { mangaId: unknown }).mangaId) && typeof (i as { title: unknown }).title === "string")
      .slice(0, 30);
    const hide: Record<number, boolean> = {};
    if (items.length === 0) return { hide };
    // Tags first: the adult check below then reuses the tags this reads.
    const tagged = await withHiddenTags(items.map((i) => i.mangaId)).catch(() => new Set<number>());
    for (const id of tagged) hide[id] = true;
    if (!locked) return { hide };
    const skip = noCheck();
    const check = items.filter((i) => !hide[i.mangaId] && !(typeof i.sourceId === "string" && skip.has(i.sourceId)));
    if (check.length === 0) return { hide };
    const found = await classifyAdult(store, check, {
      fetchImpl,
      details: async (id) => (await detailsFor(id)).genre ?? [],
    }).catch(() => new Map<number, boolean | null>());
    for (const [id, adult] of found) if (adult === true) hide[id] = true;
    return { hide };
  });

  /**
   * For the 18+ pages: the 18+ sources' results, plus the adult series from mixed sources (the ones
   * with "Check each title" on). Mixed sources' lists are fetched like any other, then only the
   * series found to be adult are kept.
   */
  /** adultWithMixedAll, without the titles you marked not 18+ (they belong on the regular pages). */
  async function adultWithMixed<T extends SearchResult>(run: (scope: Scope, only?: (s: EngineSource) => boolean) => Promise<T>): Promise<T> {
    const res = await adultWithMixedAll(run);
    const safe = store.safeMarkedKeys();
    return safe.size === 0 ? res : { ...res, groups: res.groups.filter((g) => !safe.has(g.key)) };
  }

  async function adultWithMixedAll<T extends SearchResult>(run: (scope: Scope, only?: (s: EngineSource) => boolean) => Promise<T>): Promise<T> {
    const skip = noCheck();
    const [adultRes, mixed] = await Promise.all([run("adult"), run("safe", (s) => !skip.has(s.id)).catch(() => null)]);
    if (!mixed || mixed.groups.length === 0) return adultRes;
    const probe = mixed.groups.slice(0, 40);
    const found = await classifyAdult(store, probe.map((g) => ({ mangaId: g.hits[0].mangaId, title: g.title })), {
      fetchImpl,
      details: async (id) => (await detailsFor(id)).genre ?? [],
    }).catch(() => new Map<number, boolean | null>());
    const keep = probe.filter((g) => found.get(g.hits[0].mangaId) === true);
    if (keep.length === 0) return { ...adultRes, searched: adultRes.searched + mixed.searched };
    // Take turns between the 18+ sources' series and the mixed sources' adult ones.
    const seen = new Set(adultRes.groups.map((g) => g.key));
    const extra = keep.filter((g) => !seen.has(g.key));
    const groups: SeriesGroup[] = [];
    for (let i = 0; i < Math.max(adultRes.groups.length, extra.length); i++) {
      if (i < adultRes.groups.length) groups.push(adultRes.groups[i]);
      if (i < extra.length) groups.push(extra[i]);
    }
    return { ...adultRes, groups, failed: [...adultRes.failed, ...mixed.failed], searched: adultRes.searched + mixed.searched };
  }

  app.put<{ Params: { id: string }; Body: { check?: unknown } }>("/api/sources/:id/check", async (req, reply) => {
    if (typeof req.body?.check !== "boolean") return reply.code(400).send({ error: "Bad request." });
    const skip = noCheck();
    if (req.body.check) skip.delete(req.params.id);
    else skip.add(req.params.id);
    store.setSetting("source_nocheck", JSON.stringify([...skip]));
    return { ok: true };
  });

  const sortOf = (v: string | undefined): SortKey => (SORT_KEYS.includes(v as SortKey) ? (v as SortKey) : "relevance");

  app.get<{ Querystring: { q?: string; page?: string; sort?: string; source?: string | string[] } }>("/api/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return reply.code(400).send({ error: "Type at least 2 characters." });
    const sort = sortOf(req.query.sort);
    // Only these sources (by id), when you picked some.
    const picked = new Set(([] as string[]).concat(req.query.source ?? []).filter(Boolean));
    const only = picked.size > 0 ? (s: EngineSource) => picked.has(s.id) : undefined;
    const scope = scopeFor(req);
    const page = pageOf(req.query.page);
    try {
      if (sort !== "relevance") {
        return await ranked(await browseByGenres(config, [], { query: q, sort, fetchImpl, onResult: report, scope, page, only }), sort);
      }
      // With 18+ mode locked, titles you marked not 18+ on 18+ sources still turn up.
      const safe = scope === "safe" ? store.safeMarkedKeys() : new Set<string>();
      const [res, extra] = await Promise.all([
        searchAll(config, q, { fetchImpl, onResult: report, scope, page, only }),
        safe.size > 0 ? searchAll(config, q, { fetchImpl, scope: "adult", page, only }).catch(() => null) : Promise.resolve(null),
      ]);
      if (!extra) return res;
      const groups = [...res.groups];
      for (const g of extra.groups.filter((x) => safe.has(x.key))) {
        const have = groups.find((x) => x.key === g.key);
        if (have) have.hits.push(...g.hits);
        else groups.push(g);
      }
      return { ...res, groups: rankByQuery(groups, q) };
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
    items: shown(store.updates({ includeAdult: gate.unlocked(req.headers.cookie) })),
    lastCheckedAt: store.lastChecked(),
  }));

  // Everything the home page needs that comes from Sapphire's own database (recommendations load separately).
  app.get("/api/home", async (req) => {
    const unlocked = gate.unlocked(req.headers.cookie);
    const library = shown(store.library(unlocked));
    const continueReading = library
      .filter((i) => i.progress && (i.unread ?? 0) > 0)
      .sort((a, b) => b.progress!.updatedAt.localeCompare(a.progress!.updatedAt))
      .slice(0, 12);
    return {
      libraryCount: library.length,
      continueReading,
      newChapters: shown(store.updates({ includeAdult: unlocked, caughtUpOnly: true, limit: 8 })),
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

  app.get<{ Querystring: { genres?: string; q?: string; page?: string; scope?: string; seed?: string; sort?: string; source?: string | string[] } }>("/api/browse", async (req, reply) => {
    const picked = new Set(([] as string[]).concat(req.query.source ?? []).filter(Boolean));
    const only = picked.size > 0 ? (s: EngineSource) => picked.has(s.id) : undefined;
    const genres = (req.query.genres ?? "").split(",").map((g) => g.trim()).filter(Boolean).slice(0, 10);
    const q = (req.query.q ?? "").trim();
    if (genres.length === 0) return reply.code(400).send({ error: "Pick at least one genre." });
    try {
      const sort = sortOf(req.query.sort);
      const scope = requestedScope(req);
      return withoutMarked(await ranked(await browseByGenres(config, genres, { query: q, fetchImpl, onResult: report, scope, sort, page: pageOf(req.query.page), only, seed: /^\d+$/.test(req.query.seed ?? "") ? Number(req.query.seed) : undefined }), sort), scope === "adult");
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
  function loadAdultOverrides(): Record<string, boolean> {
    try {
      const v = JSON.parse(store.getSetting("source_adult") ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "boolean")) as Record<string, boolean>;
    } catch {
      return {};
    }
  }
  setAdultOverrides(loadAdultOverrides());
  setTitleAliases(store.titleAliases(), store.titlePrimaries());
  /** Lists show a merged series under its primary name. */
  const shown = <T extends { title: string }>(rows: T[]): T[] => rows.map((r) => ({ ...r, title: displayTitle(r.title) }));

  app.get("/api/sources", async (req, reply) => {
    try {
      const health = new Map(store.sourceHealth().map((h) => [h.sourceId, h]));
      const seen = new Set<string>();
      const skipCheck = noCheck();
      const sources = (await listSources(config, fetchImpl))
        .filter((s) => (s.lang === "en" || s.lang === "all") && s.name !== "Local source")
        .filter((s) => !seen.has(s.id) && !!seen.add(s.id))
        .map((s) => ({ ...s, adultOverride: adultOverrideFor(s.id), health: health.get(s.id) ?? null, hidden: false, checkTitles: !skipCheck.has(s.id) }));
      return { sources };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // Mark a source as 18+ (or not) by hand, when the extension's own flag is wrong. null goes back to the extension's flag.
  app.put<{ Params: { id: string }; Body: { adult?: unknown } }>("/api/sources/:id/adult", async (req, reply) => {
    const adult = req.body?.adult;
    if (adult !== true && adult !== false && adult !== null) return reply.code(400).send({ error: "Bad request." });
    const map = loadAdultOverrides();
    if (adult === null) delete map[req.params.id];
    else map[req.params.id] = adult;
    store.setSetting("source_adult", JSON.stringify(map));
    setAdultOverrides(map);
    return { ok: true };
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
      // Merged series are listed under other names too, so look each one up.
      const names = [...new Set([manga.title, ...mergedWith(manga.title).map((m) => m.title)])].slice(0, 4);
      const found = await Promise.all(names.map((n) => searchAll(config, n, { fetchImpl, onResult: report, scope: scopeFor(req) }).catch(() => null)));
      const key = groupKey(manga.title);
      const searched = found.flatMap((f) => f?.groups.find((g) => g.key === key)?.hits ?? []);
      // Remember everything found together (this listing too), so opening any of them lists the rest,
      // even when one site's own search can't find the others by their name.
      store.rememberListings(key, [
        { mangaId: id, title: manga.title, sourceId: manga.sourceId, sourceName: manga.sourceName ?? "Source" },
        ...searched.map((h) => ({ mangaId: h.mangaId, title: h.title, sourceId: h.sourceId, sourceName: h.sourceName })),
      ]);
      const sources = await listSources(config, fetchImpl).catch(() => [] as EngineSource[]);
      const allowed = new Set(sources.filter((x) => inScope(x, scopeFor(req))).map((x) => x.id));
      const remembered = store
        .seenListings([key])
        // Still the same series (a merge may have been undone), and a source you can see right now.
        .filter((l) => groupKey(l.title) === key && allowed.has(l.sourceId))
        .map((l) => ({ mangaId: l.mangaId, sourceId: l.sourceId, sourceName: l.sourceName, title: l.title, thumbnailUrl: null }));
      const hits = [...searched, ...remembered]
        .filter((h, i, all) => all.findIndex((x) => x.mangaId === h.mangaId) === i)
        .filter((h) => h.mangaId !== id && h.sourceId !== manga.sourceId)
        .slice(0, 8);
      const alternatives = await Promise.all(
        hits.map(async (h) => {
          try {
            const latest = latestFromChapters(await chaptersFor(h.mangaId));
            return { mangaId: h.mangaId, sourceName: h.sourceName, version: store.versionOf(h.mangaId), ...latest };
          } catch {
            return null;
          }
        }),
      );
      return {
        alternatives: alternatives
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .sort((a, b) => (b.latestNumber ?? -1) - (a.latestNumber ?? -1))
          // A site can list the same title twice (two entries); show each site once per version, furthest ahead.
          .filter((a, i, all) => all.findIndex((x) => x.sourceName === a.sourceName && sameVersion(x.version, a.version)) === i),
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't look for other sources." });
    }
  });

  app.get<{ Querystring: { sort?: string; adult?: string; page?: string; source?: string | string[] } }>("/api/discover", async (req, reply) => {
    const sort: DiscoverSort = req.query.sort === "latest" ? "latest" : "popular";
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const other = sortOf(req.query.sort);
    // Only these sources (by id), when you picked some.
    const picked = new Set(([] as string[]).concat(req.query.source ?? []).filter(Boolean));
    const within = (only?: (s: EngineSource) => boolean) => (picked.size === 0 ? only : (s: EngineSource) => picked.has(s.id) && (!only || only(s)));
    try {
      // Popular and Latest use each site's own lists; other orders go through each site's sort filter.
      const page = pageOf(req.query.page);
      if (other === "rating" || other === "newest" || other === "az") {
        const run = (scope: Scope, only?: (s: EngineSource) => boolean) => browseByGenres(config, [], { sort: other, fetchImpl, onResult: report, scope, page, only: within(only) });
        return withoutMarked(await ranked(adult ? await adultWithMixed(run) : await run("safe"), other), adult);
      }
      const run = (scope: Scope, only?: (s: EngineSource) => boolean) => discover(config, sort, { fetchImpl, onResult: report, scope, page, only: within(only) });
      return withoutMarked(await ranked(adult ? await adultWithMixed(run) : await run("safe"), sort), adult);
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // ---- "For you" caching ------------------------------------------------------------------------
  // Answers are kept (in the database, so restarts don't lose them) and reused while what they were built
  // from is unchanged. When your library, likes or favorite tags change they're rebuilt, but no sooner than
  // REC_MIN_GAP after the last build; the page then offers a Refresh button. Hidden tags, "Not interested"
  // and what's already in your library are applied each time an answer is served, so they take effect at once.
  const REC_MIN_GAP_MS = 3 * 3600 * 1000;
  const REC_MAX_AGE_MS = 24 * 3600 * 1000;
  type RecGroups = { groups: SeriesGroup[] };
  async function recScrub(value: unknown, adult: boolean): Promise<unknown> {
    const own = new Set(store.libraryTitles(adult).map(normalizeTitle));
    const notKeys = new Set(store.notInterested(adult).map((n) => n.titleKey));
    const ok = (g: SeriesGroup) => !own.has(g.key) && !notKeys.has(g.key) && !g.hits.some((h) => store.inLibrary(h.mangaId));
    const v = JSON.parse(JSON.stringify(value)) as { groups?: SeriesGroup[]; shelves?: (RecGroups & { from?: string; examples?: string[] })[]; rows?: (RecGroups & { from?: string; examples?: string[] })[] };
    const clean = async (groups: SeriesGroup[]) => withoutHidden(groups.filter(ok));
    if (v.groups) v.groups = await clean(v.groups);
    for (const key of ["shelves", "rows"] as const) {
      const list = v[key];
      if (!list) continue;
      for (const r of list) {
        r.groups = await clean(r.groups);
        if (r.from) r.from = displayTitle(r.from);
        if (r.examples) r.examples = r.examples.map(displayTitle);
      }
      v[key] = list.filter((r) => r.groups.length > 0) as never;
    }
    return v;
  }
  const recEmpty = (v: unknown) => {
    const x = v as { groups?: unknown[]; shelves?: unknown[]; rows?: unknown[] };
    return !(x.groups?.length || x.shelves?.length || x.rows?.length);
  };
  async function recommend<T extends object>(kind: string, adult: boolean, key: string, refresh: boolean, compute: () => Promise<T>) {
    const stored = store.recCacheGet(kind, adult);
    // An empty answer (nothing to learn from yet, or the sites didn't answer) is never held on to.
    const cached = stored && !recEmpty(stored.value) ? stored : null;
    const now = Date.now();
    let use: { at: number; value: unknown; stale: boolean } | null = null;
    if (cached && !refresh) {
      const age = now - cached.at;
      if (cached.key === key && age < REC_MAX_AGE_MS) use = { at: cached.at, value: cached.value, stale: false };
      else if (cached.key !== key && age < REC_MIN_GAP_MS) use = { at: cached.at, value: cached.value, stale: true };
    }
    if (!use) {
      try {
        const value = await compute();
        if (!recEmpty(value)) store.recCacheSet(kind, adult, key, now, value);
        use = { at: now, value, stale: false };
      } catch (err) {
        // The sources aren't answering: an older answer beats an error.
        if (!cached) throw err;
        use = { at: cached.at, value: cached.value, stale: cached.key !== key };
      }
    }
    return { ...(await recScrub(use.value, adult) as object), computedAt: use.at, stale: use.stale };
  }

  // "For you" learns from the genres of what's in your library; cached so the page opens fast.
  // The 18+ page has its own taste profile and never mixes with the ordinary one.
  app.get<{ Querystring: { adult?: string; refresh?: string } }>("/api/for-you", async (req, reply) => {
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const liked = tasteSignals(adult);
    const titles = store.libraryTitles(adult);
    const key = JSON.stringify([liked.map((l) => [l.mangaId, Math.round(l.weight * 10), l.tags ?? null]), titles.length]);
    try {
      return await recommend("for-you", adult, key, req.query.refresh === "1", () =>
        recommendShelves(config, liked, titles, {
          fetchImpl,
          onResult: report,
          scope: adult ? "adult" : "safe",
          hidden: new Set(hiddenTags().map(canonKey)),
          disliked: store.notInterested(adult),
          // The 18+ page also looks on mixed sources, keeping only the series found to be adult.
          browse: adult
            ? (tags, strict) => adultWithMixed((scope, only) => browseByGenres(config, tags, { fetchImpl, onResult: report, scope, only, strict, timeoutMs: 9000 }))
            : undefined,
          knowledge: { weight: tagWeights(store.tagStats(canonKey)), tagsOf: (m) => store.seriesTags(m) },
          scores: async (list) => {
            const meta = await ratingsFor(store, list, fetchImpl, {}, false);
            return new Map([...meta].map(([k, m]) => [k, m.score]));
          },
        }),
      );
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // "Readers of X also liked" (AniList's community recommendations, found on your sources). Separate from
  // /api/for-you because finding each one on your sources is slow; the page adds these rows when they arrive.
  app.get<{ Querystring: { adult?: string; refresh?: string } }>("/api/for-you/also-liked", async (req, reply) => {
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const liked = store.likedSeries(adult);
    const key = JSON.stringify(liked.map((l) => [l.mangaId, Math.round(l.weight * 10)]));
    try {
      return await recommend("also-liked", adult, key, req.query.refresh === "1", async () => {
        const own = new Set(store.libraryTitles(adult).map(normalizeTitle));
        const notKeys = new Set(store.notInterested(adult).map((n) => n.titleKey));
        const rows = await alsoLiked(config, store, liked, {
          fetchImpl,
          onResult: report,
          // On the 18+ page an AniList pick may be on any of your sources, mixed ones included.
          scope: adult ? "all" : "safe",
          skip: (g) => own.has(g.key) || notKeys.has(g.key) || g.hits.some((h) => store.inLibrary(h.mangaId)),
        });
        return { rows };
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't reach AniList." });
    }
  });

  // The deeper rows: themes shared across everything you like, and a wide pool ranked by full tag lists.
  // Slow (it reads tags for many candidates), so it's its own request and the page adds the rows when they come.
  app.get<{ Querystring: { adult?: string; refresh?: string } }>("/api/for-you/deep", async (req, reply) => {
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const liked = tasteSignals(adult);
    const titles = store.libraryTitles(adult);
    const key = JSON.stringify([liked.map((l) => [l.mangaId, Math.round(l.weight * 10), l.tags ?? null]), titles.length]);
    try {
      return await recommend("deep", adult, key, req.query.refresh === "1", async () => {
        const rows = await deepRecommendations(liked, titles, {
          weight: tagWeights(store.tagStats(canonKey)),
          tagsOf: (m) => store.seriesTags(m),
          fetchTags: async (id) => {
            const tags = (await detailsFor(id)).genre ?? [];
            if (tags.length > 0) store.recordSeriesTags(id, tags);
            return tags;
          },
          browse: (tags, strict) =>
            adult
              ? adultWithMixed((scope, only) => browseByGenres(config, tags, { fetchImpl, onResult: report, scope, only, strict, timeoutMs: 9000 }))
              : browseByGenres(config, tags, { fetchImpl, onResult: report, scope: "safe", strict, timeoutMs: 9000 }),
          hidden: new Set(hiddenTags().map(canonKey)),
          disliked: store.notInterested(adult),
        });
        return { rows };
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // ♥ a series: it counts toward "For you" whether or not it's in the library.
  app.put<{ Params: { id: string }; Body: { on?: unknown } }>("/api/manga/:id/like", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const on = req.body?.on !== false;
    if (!on) {
      store.setLiked(id, "", false, false);
    } else {
      // Likes learn from the series' tags and keep 18+ ones with the 18+ taste, so read the details.
      const manga = await detailsFor(id).catch(() => null);
      if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
      if ((manga.genre ?? []).length > 0) store.recordSeriesTags(id, manga.genre);
      const adult = store.adultMark(manga.title) ?? ((await adultSourceOf(manga.sourceId)) || store.seriesAdult([id]).get(id) === true);
      store.setLiked(id, manga.title, adult, true);
    }
    return { liked: on };
  });

  // Your own call on whether a title is 18+: true (18+, e.g. a series on an ordinary source that's
  // really adult), false (not 18+, e.g. a safe series on a mixed source you set to 18+), or null (go
  // by its source again). Anything that would reveal a title (not 18+, or clearing an 18+ mark) needs
  // 18+ mode unlocked.
  app.put<{ Params: { id: string }; Body: { mark?: unknown; on?: unknown } }>("/api/manga/:id/adult", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const body = req.body ?? {};
    const mark = "mark" in body ? body.mark : body.on === false ? null : true;
    if (mark !== true && mark !== false && mark !== null) return reply.code(400).send({ error: "mark is true, false or null." });
    if (mark !== true && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    const sources = await listSources(config, fetchImpl).catch(() => []);
    const adultIds = new Set(sources.filter((x) => x.isNsfw).map((x) => x.id));
    const adultNames = new Set(sources.filter((x) => x.isNsfw).map((x) => x.name));
    store.setAdultMark(manga.title, mark, (src) => (!!src.id && adultIds.has(src.id)) || (!!src.name && adultNames.has(src.name)));
    store.recCacheClear();
    similarCache.clear();
    return { mark };
  });

  /**
   * Leaves out of a regular page the titles you marked 18+ (they show on the 18+ pages instead). The
   * 18+ pages already leave out the ones you marked not 18+ (adultWithMixed).
   */
  function withoutMarked<T extends { groups: SeriesGroup[] }>(result: T, adultPage: boolean): T {
    if (adultPage) return result;
    const marked = store.adultMarkedKeys();
    return marked.size === 0 ? result : { ...result, groups: result.groups.filter((g) => !marked.has(g.key)) };
  }

  // Mark several titles at once (from a list): 18+ (true), not 18+ (false) or back to their source (null).
  app.put<{ Body: { titles?: unknown; mark?: unknown } }>("/api/adult-marks", async (req, reply) => {
    const titles = Array.isArray(req.body?.titles) ? (req.body!.titles as unknown[]).filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 200) : [];
    const mark = req.body?.mark;
    if (titles.length === 0 || (mark !== true && mark !== false && mark !== null)) return reply.code(400).send({ error: "Needs titles and a mark (true, false or null)." });
    if (mark !== true && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const sources = await listSources(config, fetchImpl).catch(() => []);
    const adultIds = new Set(sources.filter((x) => x.isNsfw).map((x) => x.id));
    const adultNames = new Set(sources.filter((x) => x.isNsfw).map((x) => x.name));
    for (const t of titles) store.setAdultMark(t, mark, (src) => (!!src.id && adultIds.has(src.id)) || (!!src.name && adultNames.has(src.name)));
    store.recCacheClear();
    similarCache.clear();
    return { marked: titles.length, mark };
  });

  // ---- Merged titles: differently named listings of the same series count as one ----------------
  /**
   * Every name of a merged series (empty when it isn't merged): the canonical one first, which one it's
   * shown as (primary), and which is this source's own.
   */
  function mergedWith(title: string) {
    const canon = normalizeTitle(title);
    if (store.mergedNames(canon).length === 0) return [];
    const own = rawTitleKey(title);
    const shown = store.titlePrimaries().get(canon);
    const all = store.listings(canon);
    return all.map((n) => ({
      key: n.key,
      title: n.title,
      mangaId: n.mangaId,
      version: n.mangaId !== null ? store.versionOf(n.mangaId) : null,
      canon: n.key === canon,
      own: n.key === own,
      primary: n.title === (shown?.title ?? all[0]?.title),
      // Where the name, the cover and the description each come from (description: only when one was chosen).
      shows: {
        title: n.title === (shown?.title ?? all[0]?.title),
        cover: n.mangaId !== null && n.mangaId === (shown?.mangaId ?? all[0]?.mangaId),
        description: shown?.descMangaId != null && n.mangaId === shown.descMangaId,
      },
    }));
  }
  // ---- Versions (Uncensored, Censored, Colored…) of one series ------------------------------------
  const sameVersion = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  /**
   * The version to stay on for a series: the one you chose, else "Uncensored" when one of its listings
   * carries that label, else none (every listing counts the same).
   */
  function preferredVersionFor(title: string, ids: number[]): string | null {
    const chosen = store.preferredVersion(normalizeTitle(title));
    if (chosen) return chosen;
    const labels = ids.map((i) => store.versionOf(i)).filter((l): l is string => !!l);
    return labels.find((l) => sameVersion(l, "uncensored")) ?? null;
  }

  /** The description to show: a merged series can take it from another of its listings. */
  async function shownDescription(manga: MangaDetails): Promise<string | null> {
    const from = primaryDescription(manga.title);
    if (from !== null && from !== manga.id) {
      const other = await detailsFor(from).catch(() => null);
      if (other?.description?.trim()) return other.description;
    }
    return manga.description;
  }
  const mergesChanged = () => {
    setTitleAliases(store.titleAliases(), store.titlePrimaries());
    store.recCacheClear();
    similarCache.clear();
    chapterCache.clear();
  };
  // Merge another listing (by its title) into this series.
  app.post<{ Params: { id: string }; Body: { title?: unknown; mangaId?: unknown } }>("/api/manga/:id/merge", async (req, reply) => {
    const id = Number(req.params.id);
    const other = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!Number.isInteger(id) || id < 0 || !other) return reply.code(400).send({ error: "Needs the series and the title to merge." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    const canon = normalizeTitle(manga.title);
    const aliasKey = rawTitleKey(other);
    if (!aliasKey || normalizeTitle(other) === canon) return { mergedWith: mergedWith(manga.title) };
    // The series' current name stays the main one; if it's itself merged into another, that one does.
    const otherId = Number.isInteger(req.body?.mangaId) ? (req.body!.mangaId as number) : null;
    // This series' own id is the canonical listing's when this is that listing.
    const canonId = rawTitleKey(manga.title) === canon ? id : null;
    // Anything already merged under the other title follows it.
    const otherCanon = normalizeTitle(other);
    if (otherCanon !== aliasKey) {
      const oc = store.canonOf(otherCanon);
      store.mergeTitles(otherCanon, oc?.title ?? other, canon, store.canonTitle(canon) ?? manga.title, { alias: oc?.mangaId ?? null, canon: canonId });
    }
    store.mergeTitles(aliasKey, other, canon, store.canonTitle(canon) ?? manga.title, { alias: otherId, canon: canonId });
    mergesChanged();
    return { mergedWith: mergedWith(manga.title) };
  });
  // Show a merged series as one of its names (and that listing's cover).
  app.put<{ Params: { id: string }; Body: { key?: unknown } }>("/api/manga/:id/merge/primary", async (req, reply) => {
    const id = Number(req.params.id);
    const key = typeof req.body?.key === "string" ? req.body.key : "";
    if (!Number.isInteger(id) || id < 0 || !key) return reply.code(400).send({ error: "Needs the series and the name." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    store.setPrimary(normalizeTitle(manga.title), key);
    mergesChanged();
    return { mergedWith: mergedWith(manga.title), title: displayTitle(manga.title) };
  });
  // Choose where a merged series takes its name, cover and description from (each from any of its listings).
  app.put<{ Params: { id: string }; Body: { title?: unknown; cover?: unknown; description?: unknown } }>("/api/manga/:id/merge/display", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const pick = { title: str(req.body?.title), cover: str(req.body?.cover), description: req.body?.description === null ? null : str(req.body?.description) };
    if (pick.title === undefined && pick.cover === undefined && pick.description === undefined) return reply.code(400).send({ error: "Nothing to change." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    store.setDisplay(normalizeTitle(manga.title), pick);
    mergesChanged();
    const description = await shownDescription(manga);
    return { mergedWith: mergedWith(manga.title), title: displayTitle(manga.title), description, about: parseDescription(description, manga.title) };
  });
  // A look at each listing's description (and which source it's from) for the edit sheet.
  app.get<{ Params: { id: string } }>("/api/manga/:id/merge/previews", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    const items = await Promise.all(
      mergedWith(manga.title).map(async (m) => {
        const d = m.mangaId !== null ? await detailsFor(m.mangaId).catch(() => null) : null;
        const text = d ? parseDescription(d.description, d.title).body.replace(/\s+/g, " ").trim() : "";
        return { key: m.key, sourceName: d?.sourceName ?? null, description: text.length > 240 ? `${text.slice(0, 237).trimEnd()}…` : text, available: d !== null };
      }),
    );
    return { items };
  });
  // Label one listing with its version (Uncensored, Censored…), or clear it.
  app.put<{ Params: { id: string }; Body: { label?: unknown } }>("/api/manga/:id/version", async (req, reply) => {
    const id = Number(req.params.id);
    const label = req.body?.label;
    if (!Number.isInteger(id) || id < 0 || (label !== null && typeof label !== "string")) return reply.code(400).send({ error: "Needs a label (or null to clear it)." });
    store.setVersion(id, label as string | null);
    versionsChanged(id);
    return { version: store.versionOf(id) };
  });
  // The version to stay on for this series (merged copies included); null goes back to the automatic choice.
  app.put<{ Params: { id: string }; Body: { label?: unknown } }>("/api/manga/:id/preferred-version", async (req, reply) => {
    const id = Number(req.params.id);
    const label = req.body?.label;
    if (!Number.isInteger(id) || id < 0 || (label !== null && typeof label !== "string")) return reply.code(400).send({ error: "Needs a label (or null)." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    store.setPreferredVersion(normalizeTitle(manga.title), label as string | null);
    versionsChanged(id);
    const ids = [id, ...mergedWith(manga.title).map((m) => m.mangaId).filter((x): x is number => x !== null)];
    return { preferredVersion: preferredVersionFor(manga.title, ids) };
  });
  /** A version change can make an open "move" offer wrong: drop it and look again at the next check. */
  function versionsChanged(id: number) {
    const title = store.knownTitle(id);
    const key = title ? normalizeTitle(title) : null;
    for (const item of store.library(true)) {
      if (item.mangaId === id || (key && normalizeTitle(item.title) === key)) {
        store.clearSwitchOffer(item.mangaId);
        store.setSetting(`autoswitch.checked.${item.mangaId}`, "1970-01-01T00:00:00.000Z");
      }
    }
  }
  app.delete<{ Params: { id: string; key: string } }>("/api/manga/:id/merge/:key", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    // Taking this series' own name out of a merge is the same as taking the merge apart from this side.
    const key = req.params.key;
    const own = rawTitleKey(manga.title);
    store.unmergeTitle(store.titleAliases().has(key) ? key : own);
    mergesChanged();
    return { mergedWith: mergedWith(manga.title) };
  });

  // "Not interested" on a recommendation: it's never suggested again, and its tags count a little against.
  app.put<{ Params: { id: string }; Body: { title?: unknown; on?: unknown; adult?: unknown } }>("/api/manga/:id/not-interested", async (req, reply) => {
    const id = Number(req.params.id);
    const title = req.body?.title;
    if (!Number.isInteger(id) || typeof title !== "string" || !title.trim()) return reply.code(400).send({ error: "Needs the series id and title." });
    const on = req.body?.on !== false;
    // Its tags are what count against; read them from the source if they aren't known yet.
    if (on && !store.seriesTags(id)) {
      const tags = await detailsFor(id).then((m) => m.genre ?? [], () => []);
      if (tags.length > 0) store.recordSeriesTags(id, tags);
    }
    store.markNotInterested(id, title, req.body?.adult === true, on);
    return { ok: true };
  });

  const similarCache = new Map<string, { at: number; groups: unknown[]; basedOn: string[] }>();
  /** Similar series fill whole rows, so ones with a hidden tag are taken out here rather than on the card. */
  async function withoutHidden(groups: SeriesGroup[]): Promise<SeriesGroup[]> {
    const gone = await withHiddenTags(groups.map((g) => g.hits[0].mangaId)).catch(() => new Set<number>());
    return gone.size === 0 ? groups : groups.filter((g) => !gone.has(g.hits[0].mangaId));
  }
  app.get<{ Params: { id: string } }>("/api/manga/:id/similar", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const manga = await detailsFor(id);
      const scope = scopeFor(req);
      const key = `${id}|${scope}`;
      const cached = similarCache.get(key);
      if (cached && Date.now() - cached.at < 60 * 60 * 1000) return { groups: await withoutHidden(cached.groups as SeriesGroup[]), basedOn: cached.basedOn };
      const { groups, basedOn } = await similarTo(config, manga.title, manga.genre, {
        fetchImpl,
        onResult: report,
        scope,
        selfId: id,
        knowledge: { weight: tagWeights(store.tagStats(canonKey)), tagsOf: (m) => store.seriesTags(m) },
      });
      if (groups.length > 0) similarCache.set(key, { at: Date.now(), groups, basedOn });
      return { groups: await withoutHidden(groups), basedOn };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't find similar series." });
    }
  });

  /** A short, readable reason from an engine error (no stack trace), shown beside "couldn't load". */
  const reasonOf = (err: unknown): string => {
    const m = err instanceof Error ? err.message : String(err);
    const cut = m.search(/\s(?:at\s|java\.|kotlin|Caused by)/);
    return (cut > 0 ? m.slice(0, cut) : m).replace(/^Exception while fetching data \([^)]*\)\s*:\s*/, "").trim().slice(0, 200);
  };

  app.get<{ Params: { id: string } }>("/api/manga/:id/latest", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      return latestFromChapters(await chaptersFor(id));
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load chapters from the source.", detail: reasonOf(err) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/manga/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const [manga, chapters] = await Promise.all([detailsFor(id), chaptersFor(id)]);
      const description = await shownDescription(manga);
      if (store.inLibrary(id)) {
        store.setChapterNumbers(id, chapters.map((c) => c.chapterNumber));
        store.setGenres(id, manga.genre);
      }
      const adultSource = await adultSourceOf(manga.sourceId);
      const mark = store.adultMark(manga.title);
      const adult = mark ?? adultSource;
      store.recordSeriesMeta(id, manga.title, manga.sourceName, adult);
      // Reading done before this existed (or on this source) is remembered by chapter number so other sources can pick it up.
      const doneHere = new Set(store.readChapterIds(id));
      store.recordReadNumbers(id, chapters.filter((c) => doneHere.has(c.id)).map((c) => c.chapterNumber), true);
      // Chapters already read on another source of this series count as read here too, and move your place forward.
      const carried = store.applyReadFromOtherSources(id, chapters);
      if (carried.length > 0 && store.inLibrary(id)) {
        const furthest = carried.reduce((a, b) => (b.chapterNumber > a.chapterNumber ? b : a));
        const p = store.getProgress(id);
        if (!p || furthest.chapterNumber > p.chapterNumber) {
          store.saveProgress(id, { chapterId: furthest.id, chapterNumber: furthest.chapterNumber, chapterName: furthest.name, pageIndex: 0, pageOffset: 0, finished: true });
        }
      }
      return {
        // Shown under a merged series' primary name; the source's own name stays in sourceTitle.
        manga: { ...manga, title: displayTitle(manga.title), description },
        sourceTitle: manga.title,
        about: parseDescription(description, manga.title),
        adult,
        adultSource,
        markedAdult: mark === true,
        markedSafe: mark === false,
        mergedWith: mergedWith(manga.title),
        version: store.versionOf(id),
        preferredVersion: preferredVersionFor(manga.title, [id, ...mergedWith(manga.title).map((m) => m.mangaId).filter((x): x is number => x !== null)]),
        reader: readerPrefs(id, manga.sourceId, deviceOf(req)),
        liked: store.isLiked(id),
        chapters,
        latest: latestFromChapters(chapters),
        inLibrary: store.inLibrary(id),
        progress: store.getProgress(id),
        readChapterIds: store.readChapterIds(id),
        categories: store.seriesCategories(id),
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load this series from the source.", detail: reasonOf(err) });
    }
  });

  // ---- Downloads ----
  app.get("/api/downloads", async (req) => {
    const items = store.downloads(gate.unlocked(req.headers.cookie)).map((d) => ({ ...d, mangaTitle: displayTitle(d.mangaTitle) }));
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
    const adult = await adultFor(sourceId, b.title as string);
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

  app.get("/api/history", async (req) => ({ items: shown(store.history(gate.unlocked(req.headers.cookie))) }));
  app.delete<{ Params: { id: string } }>("/api/history/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Bad id." });
    store.removeHistory(id);
    return { ok: true };
  });

  // Library categories (shelves such as Reading, Plan to read, Dropped).
  const categoryName = (v: unknown) => (typeof v === "string" && v.trim().length > 0 && v.trim().length <= 40 ? v.trim() : null);
  app.get("/api/categories", async (req) => ({ categories: store.categories(gate.unlocked(req.headers.cookie)) }));
  app.post<{ Body: { name?: unknown } }>("/api/categories", async (req, reply) => {
    const name = categoryName(req.body?.name);
    if (!name) return reply.code(400).send({ error: "A name of 1 to 40 characters." });
    return { id: store.createCategory(name), categories: store.categories(gate.unlocked(req.headers.cookie)) };
  });
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>("/api/categories/:id", async (req, reply) => {
    const name = categoryName(req.body?.name);
    if (!name) return reply.code(400).send({ error: "A name of 1 to 40 characters." });
    store.renameCategory(Number(req.params.id), name);
    return { categories: store.categories(gate.unlocked(req.headers.cookie)) };
  });
  app.delete<{ Params: { id: string } }>("/api/categories/:id", async (req) => {
    store.deleteCategory(Number(req.params.id));
    return { categories: store.categories(gate.unlocked(req.headers.cookie)) };
  });
  app.put<{ Params: { id: string }; Body: { ids?: unknown } }>("/api/library/:id/categories", async (req, reply) => {
    const id = Number(req.params.id);
    const ids = req.body?.ids;
    if (!Number.isInteger(id) || !Array.isArray(ids) || !ids.every(Number.isInteger)) return reply.code(400).send({ error: "Send ids." });
    if (!store.inLibrary(id)) return reply.code(404).send({ error: "Add the series to your library first." });
    store.setSeriesCategories(id, ids as number[]);
    return { categories: store.seriesCategories(id) };
  });

  app.get("/api/library", async (req) => ({ items: shown(store.library(gate.unlocked(req.headers.cookie))) }));

  app.put<{ Params: { id: string }; Body: { sourceId?: string; sourceName?: string | null; title?: string } }>(
    "/api/library/:id",
    async (req, reply) => {
      const id = Number(req.params.id);
      const { sourceId, sourceName = null, title } = req.body ?? {};
      if (!Number.isInteger(id) || id < 0 || !sourceId || !title) return reply.code(400).send({ error: "Bad request." });
      const adult = await adultFor(sourceId, title);
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
    })
      .then((r) => {
        // After the check: keep reading series a few chapters ahead, and move caught-up series to
        // whichever source is furthest ahead. Runs in the background so a manual refresh isn't held up.
        void afterCheck().catch((err) => app.log.warn(err, "after-check tasks failed"));
        return r;
      })
      .finally(() => {
        checking = null;
      });
    return checking as ReturnType<typeof checkLibrary>;
  };

  // --- Automation: auto-download and auto-switch -------------------------------------------------
  type Automation = { autoDownload: number; autoSwitch: boolean; autoDelete: boolean };
  function automation(): Automation {
    try {
      const v = JSON.parse(store.getSetting("automation") ?? "{}") as Partial<Automation>;
      return {
        autoDownload: Number.isInteger(v.autoDownload) ? Math.min(10, Math.max(0, v.autoDownload!)) : 3,
        autoSwitch: v.autoSwitch !== false,
        autoDelete: v.autoDelete !== false,
      };
    } catch {
      return { autoDownload: 3, autoSwitch: true, autoDelete: true };
    }
  }
  app.get("/api/settings/automation", async () => automation());
  app.put<{ Body: Partial<Automation> }>("/api/settings/automation", async (req, reply) => {
    const next = { ...automation(), ...req.body };
    if (!Number.isInteger(next.autoDownload) || next.autoDownload < 0 || next.autoDownload > 10 || typeof next.autoSwitch !== "boolean" || typeof next.autoDelete !== "boolean") {
      return reply.code(400).send({ error: "autoDownload is 0 to 10; autoSwitch and autoDelete are true or false." });
    }
    store.setSetting("automation", JSON.stringify({ autoDownload: next.autoDownload, autoSwitch: next.autoSwitch, autoDelete: next.autoDelete }));
    return next;
  });

  /** Queues the next few unread chapters of a series you're reading, so they're on the NAS before you get there. */
  async function autoDownloadFor(mangaId: number): Promise<number> {
    const n = automation().autoDownload;
    if (n === 0) return 0;
    const item = store.library(true).find((i) => i.mangaId === mangaId);
    if (!item?.progress) return 0;
    const chapters = await chaptersFor(mangaId);
    const read = new Set(store.readChapterIds(mangaId));
    const at = chapters.findIndex((c) => c.id === item.progress!.chapterId);
    const ahead = chapters
      .slice(Math.max(0, at))
      .filter((c) => !read.has(c.id))
      .slice(0, n)
      .filter((c) => !store.getDownload(c.id) || store.getDownload(c.id)!.status === "failed");
    if (ahead.length === 0) return 0;
    const queued = store.queueDownloads(
      { mangaId, title: item.title, sourceName: item.sourceName, adult: item.adult },
      ahead.map((c) => ({ id: c.id, name: c.name, number: c.chapterNumber })),
    );
    downloader.kick();
    return queued;
  }

  /**
   * Frees NAS space: removes downloaded chapters of a series that you've read, except the one you
   * finished last (so flipping back a page still works offline).
   */
  function autoDeleteFor(mangaId: number): number {
    if (!automation().autoDelete) return 0;
    const read = new Set(store.readChapterIds(mangaId));
    const keep = store.getProgress(mangaId)?.chapterId;
    let removed = 0;
    for (const d of store.downloads(true, mangaId)) {
      if (d.status === "done" && read.has(d.chapterId) && d.chapterId !== keep) {
        downloader.remove(d.chapterId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * For a series you're caught up on, looks for the same series on your other sources and, if one is
   * further ahead (and clearly the same series: it has most of the same chapter numbers), moves the
   * library entry there, carrying over read chapters, your place and categories.
   */
  async function autoSwitchFor(mangaId: number): Promise<{ from: string | null; to: string; latest: number; kind: NonNullable<SwitchOffer["kind"]>; toVersion: string | null } | null> {
    const item = store.library(true).find((i) => i.mangaId === mangaId);
    if (!item || item.unread !== 0 || item.latestNumber === null) return null;
    const key = `autoswitch.checked.${mangaId}`;
    if (Date.now() - Date.parse(store.getSetting(key) ?? "0") < 20 * 3600 * 1000) return null;
    store.setSetting(key, new Date().toISOString());
    // Merged series are listed under other names too (often the other versions), so look each one up.
    const names = [...new Set([item.title, ...mergedWith(item.title).map((m) => m.title)])].slice(0, 4);
    const found = await Promise.all(names.map((n) => searchAll(config, n, { fetchImpl, onResult: report, scope: item.adult ? "all" : "safe" }).catch(() => null)));
    const hits = found
      .flatMap((f) => f?.groups.find((g) => g.key === groupKey(item.title))?.hits ?? [])
      .filter((h, i, all) => all.findIndex((x) => x.mangaId === h.mangaId) === i)
      .filter((h) => h.mangaId !== mangaId && h.sourceId !== item.sourceId)
      .slice(0, 6);
    const mine = (await chaptersFor(mangaId)).filter((c) => c.chapterNumber >= 0);
    const mineNumbers = new Set(mine.map((c) => c.chapterNumber));
    const candidates: { hit: (typeof hits)[number]; latest: number; version: string | null }[] = [];
    for (const hit of hits) {
      try {
        const chapters = await chaptersFor(hit.mangaId);
        const numbers = new Set(chapters.filter((c) => c.chapterNumber >= 0).map((c) => c.chapterNumber));
        const latest = Math.max(-1, ...numbers);
        const overlap = [...mineNumbers].filter((n) => numbers.has(n)).length / Math.max(1, mineNumbers.size);
        if (overlap >= 0.7) candidates.push({ hit, latest, version: store.versionOf(hit.mangaId) });
      } catch {
        // That source is having a bad day.
      }
    }
    const myVersion = store.versionOf(mangaId);
    const preferred = preferredVersionFor(item.title, [mangaId, ...candidates.map((c) => c.hit.mangaId)]);
    const furthest = (list: typeof candidates) => list.reduce<(typeof candidates)[number] | null>((a, c) => (!a || c.latest > a.latest ? c : a), null);
    let pick: { c: (typeof candidates)[number]; kind: NonNullable<SwitchOffer["kind"]> } | null = null;
    // Reading another version than the one you prefer: offer the way back once it has caught up.
    if (preferred && !sameVersion(myVersion, preferred)) {
      const back = furthest(candidates.filter((c) => sameVersion(c.version, preferred) && c.latest >= item.latestNumber!));
      if (back) pick = { c: back, kind: "back" };
    }
    if (!pick) {
      const same = furthest(candidates.filter((c) => sameVersion(c.version, myVersion) && c.latest > item.latestNumber!));
      if (same) pick = { c: same, kind: "ahead" };
    }
    if (!pick) {
      // Only another version has the newer chapters: say so, so you can decide.
      const other = furthest(candidates.filter((c) => !sameVersion(c.version, myVersion) && c.latest > item.latestNumber!));
      if (other) pick = { c: other, kind: "other-version" };
    }
    if (!pick) return null;
    // Asks first: the move happens when you accept it on the Updates page.
    const offered = store.offerSwitch({
      mangaId,
      toMangaId: pick.c.hit.mangaId,
      toSourceId: pick.c.hit.sourceId,
      toSourceName: pick.c.hit.sourceName,
      toLatest: pick.c.latest,
      fromLatest: item.latestNumber,
      kind: pick.kind,
      toVersion: pick.c.version,
    });
    return offered ? { from: item.sourceName, to: pick.c.hit.sourceName, latest: pick.c.latest, kind: pick.kind, toVersion: pick.c.version } : null;
  }

  async function afterCheck(): Promise<void> {
    const { autoSwitch } = automation();
    for (const item of store.library(true)) {
      if (autoSwitch) {
        try {
          const moved = await autoSwitchFor(item.mangaId);
          if (moved) {
            app.log.info(moved, `${item.mangaId} is further ahead on another source`);
            const latest = Number.isInteger(moved.latest) ? moved.latest : moved.latest.toFixed(1);
            await notify?.({
              title: item.adult ? "Sapphire" : item.title,
              message: item.adult
                ? "A series in your 18+ library is further ahead on another source"
                : moved.kind === "back"
                  ? `${moved.toVersion ?? "Your preferred version"} has caught up on ${moved.to}. Tap to move back.`
                  : moved.kind === "other-version"
                    ? `Up to chapter ${latest} is out in the ${moved.toVersion ?? "other"} version on ${moved.to}.`
                    : `${moved.to} has up to chapter ${latest}. Tap to move it there.`,
              click: config.publicUrl ? `${config.publicUrl}/#/updates` : undefined,
            }).catch(() => {});
          }
        } catch (err) {
          app.log.warn(err, `auto-switch failed for ${item.mangaId}`);
        }
      }
      await autoDownloadFor(item.mangaId).catch(() => 0);
      autoDeleteFor(item.mangaId);
    }
  }

  // "Further ahead elsewhere" suggestions, shown on the Updates page.
  app.get("/api/switch-offers", async (req) => ({
    offers: shown(store.switchOffers(gate.unlocked(req.headers.cookie))).map((o) => ({ ...o, fromVersion: store.versionOf(o.mangaId) })),
  }));
  app.post<{ Params: { id: string } }>("/api/switch-offers/:id/dismiss", async (req) => {
    store.dismissSwitchOffer(Number(req.params.id));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/switch-offers/:id/accept", async (req, reply) => {
    const id = Number(req.params.id);
    const offer = store.getSwitchOffer(id);
    const item = store.library(true).find((i) => i.mangaId === id);
    if (!offer || !item) return reply.code(404).send({ error: "That suggestion is gone." });
    if (item.adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    try {
      const [from, to] = await Promise.all([chaptersFor(id), chaptersFor(offer.toMangaId)]);
      store.switchSource(
        id,
        { mangaId: offer.toMangaId, sourceId: offer.toSourceId, sourceName: offer.toSourceName, title: item.title },
        { from, to: to.map((c) => ({ id: c.id, chapterNumber: c.chapterNumber, name: c.name })) },
      );
      store.recordSeriesMeta(offer.toMangaId, item.title, offer.toSourceName, item.adult);
      store.clearSwitchOffer(id);
      return { mangaId: offer.toMangaId };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load the chapters from the other source." });
    }
  });
  app.decorate("runCheck", runCheck);

  app.post("/api/library/refresh", async (req) => {
    const unlocked = gate.unlocked(req.headers.cookie);
    const result = await runCheck(0);
    return { items: shown(store.library(unlocked)), failed: result.failed };
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
    if (b.finished === true) {
      void syncTrackers(id, b.chapterNumber!);
      if (store.inLibrary(id)) {
        autoDeleteFor(id);
        void autoDownloadFor(id).catch(() => 0);
      }
    }
    return { ok: true };
  });

  // Covers are served through Sapphire so the engine never needs to be reachable from devices.
  app.get<{ Params: { id: string }; Querystring: { raw?: string } }>("/api/manga/:id/thumbnail", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    // A merged series is shown with its primary listing's cover.
    const known = store.knownTitle(id) ?? seenTitle(id);
    const primary = known && req.query.raw !== "1" ? primaryCover(known) : null;
    if (primary !== null && primary !== id) return reply.header("cache-control", "no-cache").redirect(`/api/manga/${primary}/thumbnail`);
    const local = downloader.coverFile(id);
    if (local) {
      return reply.header("content-type", mimeForFile(local)).header("cache-control", "public, max-age=3600").send(createReadStream(local));
    }
    try {
      const res = await engineFile(config, `/api/v1/manga/${id}/thumbnail`, fetchImpl);
      if (!res.ok) return reply.code(404).send({ error: "No cover." });
      const type = res.headers.get("content-type") ?? "image/jpeg";
      return reply
        .header("content-type", type)
        // An hour, so a merge (which can swap covers) shows soon.
        .header("cache-control", "public, max-age=3600")
        .send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Cover unavailable." });
    }
  });

  const iconPaths = new Map<string, string>();
  // Extension icons, also through Sapphire. Only plain apk file names are passed on to the engine.
  app.get<{ Params: { apk: string } }>("/api/extension-icon/:apk", async (req, reply) => {
    if (!/^[\w.-]+\.apk$/.test(req.params.apk)) return reply.code(400).send({ error: "Bad name." });
    try {
      // Use the path the engine itself reports; fall back to the classic one.
      let path = iconPaths.get(req.params.apk);
      if (!path) {
        for (const x of await listExtensions(config, fetchImpl)) if (x.apkName && x.iconUrl && (x.iconUrl.startsWith("/") || x.iconUrl.startsWith("https://"))) iconPaths.set(x.apkName, x.iconUrl);
        path = iconPaths.get(req.params.apk) ?? `/api/v1/extension/icon/${req.params.apk}`;
      }
      // Installed extensions' icons live in the engine; ones not installed yet point at the extension repo.
      const res = path.startsWith("https://")
        ? await (fetchImpl ?? fetch)(path, { signal: AbortSignal.timeout(15000) })
        : await engineFile(config, path, fetchImpl);
      if (!res.ok) return reply.code(404).send({ error: "No icon." });
      return reply
        .header("content-type", res.headers.get("content-type") ?? "image/png")
        .header("cache-control", "public, max-age=604800")
        .send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Icon unavailable." });
    }
  });

  // How a series is read: scrolling (webtoons) or one page at a time, left-to-right or right-to-left.
  // Each series can have its own; otherwise the default (which the person can also set) applies.
  type ReaderPrefs = { mode: "scroll" | "paged"; direction: "ltr" | "rtl" };
  const validPrefs = (v: unknown): v is ReaderPrefs =>
    typeof v === "object" && v !== null &&
    ["scroll", "paged"].includes((v as ReaderPrefs).mode) && ["ltr", "rtl"].includes((v as ReaderPrefs).direction);
  // Each device (phone, desktop, ...) keeps its own choices, since how you hold it differs. A device is
  // told apart by an id the app sends; choices made before this existed are shared and still apply.
  const deviceOf = (req: { headers: Record<string, string | string[] | undefined> }): string | null => {
    const v = req.headers["x-sapphire-device"];
    return typeof v === "string" && /^[a-z0-9-]{8,64}$/i.test(v) ? v.toLowerCase() : null;
  };
  // Per level: the series, then its source (one site is all manga, another all webtoons), then the
  // default. At each level this device's choice wins over the shared one.
  type PrefsLevel = "series" | "source" | "default";
  function readerPrefs(mangaId: number, sourceId?: string | null, device: string | null = null): ReaderPrefs & { custom: boolean; level: PrefsLevel } {
    const levels: [string, PrefsLevel][] = [[`${mangaId}`, "series"]];
    if (sourceId) levels.push([`source.${sourceId}`, "source"]);
    levels.push(["default", "default"]);
    const keys: [string, PrefsLevel][] = [];
    for (const [k, level] of levels) {
      if (device) keys.push([`reader.${device}.${k}`, level]);
      keys.push([`reader.${k}`, level]);
    }
    for (const [key, level] of keys) {
      try {
        const v = JSON.parse(store.getSetting(key) ?? "null");
        if (validPrefs(v)) return { mode: v.mode, direction: v.direction, custom: level === "series", level };
      } catch {
        // Ignore a bad value.
      }
    }
    return { mode: "scroll", direction: "ltr", custom: false, level: "default" };
  }
  // `everywhere: true` (or scope "all") sets the default; scope "source" sets it for every series from this one's site.
  // With a device id these are this device's own; without one they're the shared choices.
  app.put<{ Params: { id: string }; Body: { mode?: unknown; direction?: unknown; everywhere?: unknown; scope?: unknown } }>("/api/manga/:id/reader", async (req, reply) => {
    const id = Number(req.params.id);
    const prefs = { mode: req.body?.mode, direction: req.body?.direction };
    if (!Number.isInteger(id) || !validPrefs(prefs)) return reply.code(400).send({ error: "mode is scroll or paged; direction is ltr or rtl." });
    const scope = req.body?.everywhere === true ? "all" : req.body?.scope === "source" || req.body?.scope === "all" ? req.body.scope : "series";
    const device = deviceOf(req);
    const base = device ? `reader.${device}.` : "reader.";
    const sourceId = await detailsFor(id).then((m) => m.sourceId, () => null);
    if (scope === "source" && !sourceId) return reply.code(502).send({ error: "Couldn't tell which source this series is from." });
    const key = scope === "all" ? `${base}default` : scope === "source" ? `${base}source.${sourceId}` : `${base}${id}`;
    store.setSetting(key, JSON.stringify({ mode: prefs.mode, direction: prefs.direction }));
    if (scope !== "series") store.deleteSetting(`${base}${id}`);
    // "All series" means all of them, so it also replaces any per-source choices.
    if (scope === "all") store.deleteSettingsLike(`${base}source.`);
    return readerPrefs(id, sourceId, device);
  });

  // Mark chapters read or unread by hand (e.g. ones read elsewhere). Marking ahead of where you are
  // moves your place to the furthest chapter marked, so unread counts and alerts follow.
  app.post<{ Params: { id: string }; Body: { chapterIds?: unknown; read?: unknown } }>("/api/manga/:id/read", async (req, reply) => {
    const id = Number(req.params.id);
    const { chapterIds, read } = req.body ?? {};
    if (!Number.isInteger(id) || !Array.isArray(chapterIds) || !chapterIds.every(Number.isInteger) || typeof read !== "boolean") {
      return reply.code(400).send({ error: "Send chapterIds and read." });
    }
    try {
      const chapters = await chaptersFor(id);
      const marked = chapters.filter((c) => (chapterIds as number[]).includes(c.id));
      store.setChaptersRead(id, marked.map((c) => c.id), read);
      store.recordReadNumbers(id, marked.map((c) => c.chapterNumber), read);
      if (read && marked.length > 0) {
        const furthest = marked.reduce((a, b) => (b.chapterNumber > a.chapterNumber ? b : a));
        const p = store.getProgress(id);
        if (!p || furthest.chapterNumber > p.chapterNumber) {
          store.saveProgress(id, { chapterId: furthest.id, chapterNumber: furthest.chapterNumber, chapterName: furthest.name, pageIndex: 0, pageOffset: 0, finished: true });
        }
      }
      if (!read && marked.length > 0) {
        // Unmarking at or before your place moves your place back to just before the earliest one.
        const earliest = Math.min(...marked.map((c) => c.chapterNumber));
        const p = store.getProgress(id);
        if (p && earliest <= p.chapterNumber) {
          const before = chapters.filter((c) => c.chapterNumber >= 0 && c.chapterNumber < earliest).sort((a, b) => b.chapterNumber - a.chapterNumber)[0];
          if (before) store.saveProgress(id, { chapterId: before.id, chapterNumber: before.chapterNumber, chapterName: before.name, pageIndex: 0, pageOffset: 0, finished: false });
          else store.clearProgress(id);
        }
      }
      return { readChapterIds: store.readChapterIds(id), progress: store.getProgress(id) };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load this series' chapters." });
    }
  });

  const webDir = resolve(config.webDir);
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      cacheControl: false,
      // Built files have content hashes in their names, so they can be cached for good;
      // the page itself and the service worker must always be checked for a new version.
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.setHeader("cache-control", "public, max-age=31536000, immutable");
        else res.setHeader("cache-control", "no-cache");
      },
    });
    // Single-page app: any non-API path serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
