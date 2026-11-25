import { createReadStream, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { Passkeys, newPasskeyName } from "./passkeys.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
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
import { discover, FAVORITES_ID, FAVORITES_WEIGHT, commonFactor, primaryBrowse, recommendShelves, similarTo, type DiscoverSort, type LikedSeries } from "./discover.js";
import { Downloader, mimeForFile } from "./downloader.js";
import { backupName, snapshot } from "./backup.js";
import { anilistSearch, anilistSetProgress, anilistViewer } from "./tracker.js";
import { checkLibrary } from "./checker.js";
import { MangaBaka, bakaUrl, findOnBaka, type BakaSeries, type BakaTag, type TagWeight, type UpdatesRec } from "./mangabaka.js";
import { bakaVector, boostFrom, cosine, tasteVector, type TagVector } from "./bakatags.js";
import { findOnSources } from "./alsoliked.js";
import { pairKey, shownKey, splitVersion, suggestMerges } from "./mergehints.js";
import { looksCluttered } from "./titles.js";
import { createNotifier } from "./notify.js";
import { Store, type ProgressInput, type SwitchOffer } from "./store.js";
import {
  fetchChapterList,
  fetchMangaDetails,
  fetchStoredChapters,
  fetchStoredManga,
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
  /** MangaBaka client (tests pass one with no spacing between calls). */
  baka?: MangaBaka;
}

/** Results come in pages (infinite scroll); anything odd means page 1. */
const pageOf = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 1;
};

export async function buildApp(config: Config, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, maxParamLength: 1000 });
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
  const passkeys = new Passkeys(store);
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
    const full = fetchMangaDetails(config, mangaId, fetchImpl);
    if (fresh) {
      detailsCache.set(mangaId, { at: Date.now(), value: full });
      full.catch(() => detailsCache.delete(mangaId));
      return full;
    }
    // Details hardly change, so what the engine saved last time answers at once (when it has been filled in
    // before); the refresh from the source runs behind it and replaces it when done (Dan, Nov 24: slow page).
    const value = fetchStoredManga(config, mangaId, fetchImpl).then(
      (s) => (s.initialized ? s.details : full),
      () => full,
    );
    detailsCache.set(mangaId, { at: Date.now(), value });
    full.then(
      (v) => detailsCache.set(mangaId, { at: Date.now(), value: Promise.resolve(v) }),
      () => undefined,
    );
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
  // --- Primary tags: the few tags you say a series is really about; Similar matches on them first. ------
  const primaryKey = (title: string) => `primary_tags.${normalizeTitle(title)}`;
  function primaryTagsOf(title: string): string[] {
    return tagSetting(primaryKey(title));
  }
  app.put<{ Params: { id: string }; Body: { tags?: unknown } }>("/api/manga/:id/primary-tags", async (req, reply) => {
    const id = Number(req.params.id);
    const raw = req.body?.tags;
    if (!Number.isInteger(id) || id < 0 || !Array.isArray(raw) || raw.some((t) => typeof t !== "string")) return reply.code(400).send({ error: "tags is a list of names." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    // Kept as written (character and parody names aren't genres), one per name, at most eight.
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const t of raw as string[]) {
      const name = t.trim().slice(0, 80);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      tags.push(name);
    }
    if (tags.length > 8) return reply.code(400).send({ error: "Pick at most 8 primary tags." });
    store.setSetting(primaryKey(manga.title), JSON.stringify(tags));
    for (const k of [...similarCache.keys()]) if (k.startsWith(`${id}|`)) similarCache.delete(k);
    // You just said what this series is about: For you rebuilds on the next visit instead of waiting out its 3h gap.
    store.recCacheClear();
    return { tags };
  });

  /**
   * What "For you" learns from: the series you like, plus your favorite tags as one stand-in series
   * that counts as much as a few liked ones (it has no id or title, so rows from it say "favorite tags").
   */
  /**
   * How central each tag is to one of your series: a primary tag 3, then MangaBaka's rank for it (core 2,
   * defining 1.5, recurrent 1, incidental 0.6; a source tag MangaBaka doesn't list 0.8), else 1.
   */
  const IMPORTANCE: Record<string, number> = { core: 2, defining: 1.5, recurrent: 1, incidental: 0.6, unweighted: 0.8 };
  function importanceFor(title: string): { importance: (tag: string) => number; primary: string[]; known: boolean } {
    const primary = primaryTagsOf(title);
    const pKeys = new Set(primary.map(canonKey));
    const data = store.bakaLink(normalizeTitle(title))?.data as BakaSeries | null | undefined;
    const mb = new Map<string, number>();
    for (const t of data?.tags ?? []) if (!t.spoiler) mb.set(canonKey(t.name), Math.max(mb.get(canonKey(t.name)) ?? 0, IMPORTANCE[t.weight] ?? 1));
    const hasMb = mb.size > 0;
    return {
      primary,
      known: hasMb || primary.length > 0,
      importance: (tag) => {
        const k = canonKey(tag);
        return pKeys.has(k) ? 3 : (mb.get(k) ?? (hasMb ? 0.8 : 1));
      },
    };
  }
  /** Recommendations weigh tags by how central they are to your series, not by how rare they are (Dan, Nov 24). */
  const flatWeight = () => 1;
  /** The same for a suggested series: how central each of its tags is to it, or null when Sapphire doesn't know. */
  function candidateImportance(g: SeriesGroup): ((tag: string) => number) | null {
    for (const title of [g.title, ...g.hits.map((h) => h.title)]) {
      const i = importanceFor(title);
      if (i.known) return i.importance;
    }
    return null;
  }
  function tasteSignals(adult: boolean): LikedSeries[] {
    const liked = store.likedSeries(adult).map((l) => {
      const imp = importanceFor(l.title);
      // Primary tags count even when the source doesn't list them (MangaBaka tags, description tags).
      const have = new Set(l.tags.map(canonKey));
      return { ...l, ...imp, tags: [...l.tags, ...imp.primary.filter((t) => !have.has(canonKey(t)))] };
    });
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

  app.get("/api/adult", async (req) => ({ pinSet: gate.pinSet(), unlocked: gate.unlocked(req.headers.cookie), passkey: passkeys.any() }));

  // Passkeys (Face ID etc.): a way to unlock 18+ mode without typing the PIN. Adding or removing one needs
  // 18+ mode already on (so the PIN); unlocking needs no PIN but the device's own check (Face ID).
  /** The page's own address, which a passkey is tied to. Passkeys only work over https (or localhost). */
  // The browser's own Origin header (or Referer) names the page; PUBLIC_URL isn't used here, since it's often
  // still the LAN http address and only matters for notification links.
  const passkeyOrigin = (req: { headers: Record<string, unknown> }): { origin: string; rpID: string } | null => {
    const raw = typeof req.headers.origin === "string" && req.headers.origin !== "null" ? req.headers.origin : typeof req.headers.referer === "string" ? req.headers.referer : "";
    try {
      const u = new URL(raw);
      const secure = u.protocol === "https:" || u.hostname === "localhost";
      if (!secure) return null;
      return { origin: u.origin, rpID: u.hostname };
    } catch {
      return null;
    }
  };
  const needHttpsFor = (req: { headers: Record<string, unknown> }) => {
    const seen = String(req.headers.origin ?? req.headers.referer ?? "").slice(0, 120) || "no address";
    return `Face ID needs the https address (your Tailscale link), not plain http. The server saw: ${seen}`;
  };
  const openOnly = (req: { headers: { cookie?: string } }) => gate.unlocked(req.headers.cookie);

  app.get("/api/adult/passkeys", async (req, reply) => {
    if (!openOnly(req)) return reply.code(403).send({ error: "Turn on 18+ mode first." });
    return { passkeys: passkeys.list() };
  });
  app.post("/api/adult/passkey/register/options", async (req, reply) => {
    if (!openOnly(req)) return reply.code(403).send({ error: "Turn on 18+ mode first." });
    const rp = passkeyOrigin(req);
    if (!rp) return reply.code(400).send({ error: needHttpsFor(req) });
    return passkeys.registerOptions(rp.rpID);
  });
  app.post<{ Body: { response?: unknown; challenge?: unknown; name?: unknown } }>("/api/adult/passkey/register/verify", async (req, reply) => {
    if (!openOnly(req)) return reply.code(403).send({ error: "Turn on 18+ mode first." });
    const rp = passkeyOrigin(req);
    if (!rp) return reply.code(400).send({ error: needHttpsFor(req) });
    const { response, challenge, name } = req.body ?? {};
    if (!response || typeof response !== "object" || typeof challenge !== "string") return reply.code(400).send({ error: "That didn't look right." });
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, 60) : newPasskeyName();
    const ok = await passkeys.registerVerify(response as never, challenge, rp.origin, rp.rpID, label);
    if (!ok) return reply.code(400).send({ error: "Couldn't set up Face ID. Try again." });
    return { passkeys: passkeys.list() };
  });
  app.delete<{ Params: { id: string } }>("/api/adult/passkeys/:id", async (req, reply) => {
    if (!openOnly(req)) return reply.code(403).send({ error: "Turn on 18+ mode first." });
    passkeys.remove(req.params.id);
    return { passkeys: passkeys.list() };
  });
  app.post("/api/adult/passkey/login/options", async (req, reply) => {
    const rp = passkeyOrigin(req);
    if (!rp || !passkeys.any()) return reply.code(400).send({ error: rp ? "No Face ID set up yet." : needHttpsFor(req) });
    return passkeys.loginOptions(rp.rpID);
  });
  app.post<{ Body: { response?: unknown; challenge?: unknown } }>("/api/adult/passkey/login/verify", async (req, reply) => {
    const rp = passkeyOrigin(req);
    if (!rp) return reply.code(400).send({ error: needHttpsFor(req) });
    const { response, challenge } = req.body ?? {};
    if (!response || typeof response !== "object" || typeof challenge !== "string") return reply.code(400).send({ error: "That didn't look right." });
    if (!(await passkeys.loginVerify(response as never, challenge, rp.origin, rp.rpID))) return reply.code(403).send({ error: "Face ID didn't match." });
    return reply.header("set-cookie", sessionCookie(gate.open())).send({ pinSet: gate.pinSet(), unlocked: true, passkey: true });
  });

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
    return reply.header("set-cookie", sessionCookie(gate.open())).send({ pinSet: true, unlocked: true, passkey: passkeys.any() });
  });

  app.post<{ Body: { pin?: unknown } }>("/api/adult/unlock", async (req, reply) => {
    const pin = req.body?.pin;
    if (typeof pin !== "string" || !gate.pinSet()) return reply.code(400).send({ error: "Set a PIN first." });
    const check = gate.check(pin);
    if (check === "locked") return reply.code(429).send({ error: "Too many wrong tries. Wait a few minutes." });
    if (check !== "ok") return reply.code(403).send({ error: "Wrong PIN." });
    return reply.header("set-cookie", sessionCookie(gate.open())).send({ pinSet: true, unlocked: true, passkey: passkeys.any() });
  });

  app.post("/api/adult/lock", async (req, reply) => {
    gate.close(req.headers.cookie);
    return reply.header("set-cookie", clearedCookie).send({ pinSet: gate.pinSet(), unlocked: false, passkey: passkeys.any() });
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
      // Updates you've since read (on any source) are done with, so they don't sit on the home page.
      newChapters: shown(store.updates({ includeAdult: unlocked, caughtUpOnly: true, limit: 40 })).filter((u) => !u.read).slice(0, 8),
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
    // Titles you've marked 18+ leave the ordinary page's answers, and ones marked not 18+ leave the 18+ page's.
    const moved = adult ? store.safeMarkedKeys() : store.adultMarkedKeys();
    const ok = (g: SeriesGroup) => !own.has(g.key) && !notKeys.has(g.key) && !moved.has(g.key) && !g.hits.some((h) => store.inLibrary(h.mangaId));
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
    const key = JSON.stringify([liked.map((l) => [l.mangaId, Math.round(l.weight * 10), l.tags ?? null, l.primary ?? null]), titles.length, bakaKnown(liked), "importance-v2"]);
    try {
      return await recommend("for-you", adult, key, req.query.refresh === "1", async () => {
        const result = await recommendShelves(config, liked, titles, {
          boost: tasteBoost(liked, store.notInterested(adult)),
          fetchImpl,
          onResult: report,
          scope: adult ? "adult" : "safe",
          hidden: new Set(hiddenTags().map(canonKey)),
          disliked: store.notInterested(adult),
          // The 18+ page also looks on mixed sources, keeping only the series found to be adult.
          browse: adult
            ? (tags, strict) => adultWithMixed((scope, only) => browseByGenres(config, tags, { fetchImpl, onResult: report, scope, only, strict, timeoutMs: 9000 }))
            : undefined,
          knowledge: { weight: flatWeight, tagsOf: (m) => store.seriesTags(m), importanceOf: candidateImportance },
          scores: async (list) => {
            const meta = await ratingsFor(store, list, fetchImpl, {}, false);
            return new Map([...meta].map(([k, m]) => [k, m.score]));
          },
        });
        enrichGroups(result.groups, 20);
        return result;
      });
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "The source engine isn't answering." });
    }
  });

  // "Readers of X also liked" (AniList's and MangaUpdates' reader recommendations, found on your sources). Separate from
  // /api/for-you because finding each one on your sources is slow; the page adds these rows when they arrive.
  app.get<{ Querystring: { adult?: string; refresh?: string } }>("/api/for-you/also-liked", async (req, reply) => {
    const adult = req.query.adult === "1";
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const liked = store.likedSeries(adult);
    const key = JSON.stringify([liked.map((l) => [l.mangaId, Math.round(l.weight * 10)]), "mu-v1"]);
    try {
      return await recommend("also-liked", adult, key, req.query.refresh === "1", async () => {
        const own = new Set(store.libraryTitles(adult).map(normalizeTitle));
        const notKeys = new Set(store.notInterested(adult).map((n) => n.titleKey));
        const rows = await alsoLiked(config, store, liked, {
          fetchImpl,
          onResult: report,
          // On the 18+ page an AniList pick may be on any of your sources, mixed ones included.
          scope: adult ? "all" : "safe",
          skip: (g) => own.has(g.key) || notKeys.has(g.key) || g.hits.some((h) => store.inLibrary(h.mangaId)) || (!adult && explicitOnBaka(g)),
          updates: updatesRecsFor,
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
    const key = JSON.stringify([liked.map((l) => [l.mangaId, Math.round(l.weight * 10), l.tags ?? null, l.primary ?? null]), titles.length, bakaKnown(liked), "importance-v2"]);
    try {
      return await recommend("deep", adult, key, req.query.refresh === "1", async () => {
        const rows = await deepRecommendations(liked, titles, {
          boost: tasteBoost(liked, store.notInterested(adult)),
          weight: flatWeight,
          importanceOf: candidateImportance,
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
        enrichGroups(rows.flatMap((r) => r.groups), 20);
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
  /**
   * The name this series goes by, for merge changes that only need its title: the name Sapphire last saw it under
   * (no site call, so a slow or blocked source can't make unmerging fail), else read from the source.
   */
  async function titleForMerge(id: number): Promise<{ title: string } | null> {
    const known = store.knownTitle(id);
    if (known) return { title: known };
    return detailsFor(id).catch(() => null);
  }
  // Merge another listing (by its title) into this series.
  app.post<{ Params: { id: string }; Body: { title?: unknown; mangaId?: unknown } }>("/api/manga/:id/merge", async (req, reply) => {
    const id = Number(req.params.id);
    const other = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!Number.isInteger(id) || id < 0 || !other) return reply.code(400).send({ error: "Needs the series and the title to merge." });
    const manga = await titleForMerge(id);
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
    const manga = await titleForMerge(id);
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
    const manga = await titleForMerge(id);
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

  type FacetRow = { label: string; value: string; groups: SeriesGroup[] };
  type PrimaryInfo = { tags: string[]; matchedAll: boolean; subsets: { tags: string[]; groups: SeriesGroup[] }[] };
  const similarCache = new Map<string, { at: number; groups: unknown[]; basedOn: string[]; primary?: PrimaryInfo; facetRows?: FacetRow[] }>();
  /** Similar series fill whole rows, so ones with a hidden tag are taken out here rather than on the card. */
  async function withoutHidden(groups: SeriesGroup[]): Promise<SeriesGroup[]> {
    const gone = await withHiddenTags(groups.map((g) => g.hits[0].mangaId)).catch(() => new Set<number>());
    return gone.size === 0 ? groups : groups.filter((g) => !gone.has(g.hits[0].mangaId));
  }
  // ---- Suggested merges: the same series listed under slightly different names --------------------
  const mbOf = (key: string) => store.bakaLink(key)?.mbId ?? null;
  /**
   * Splits Similar's results into other series and listings that look like this same series (same
   * MangaBaka entry, the same name apart from a version word, or the same tidied doujin name), which are
   * offered as a merge instead.
   */
  function splitSame(selfTitle: string, groups: SeriesGroup[]): { groups: SeriesGroup[]; sameSeries: { mangaId: number; title: string; sourceName: string; label: string | null; selfLabel: string | null }[] } {
    const selfKey = normalizeTitle(selfTitle);
    const selfMb = mbOf(selfKey);
    const self = splitVersion(selfTitle);
    const selfBase = normalizeTitle(self.base);
    const selfShown = shownKey(selfTitle);
    const dismissed = store.dismissedMerges();
    const keep: SeriesGroup[] = [];
    const same: { mangaId: number; title: string; sourceName: string; label: string | null; selfLabel: string | null }[] = [];
    for (const g of groups) {
      const hit = g.hits[0];
      const other = splitVersion(hit.title);
      const sameMb = selfMb !== null && mbOf(g.key) === selfMb;
      const sameBase = normalizeTitle(other.base) === selfBase && (other.label !== null || self.label !== null);
      // Doujin-style names that tidy to the same shown name.
      const sameShown = selfShown !== null && shownKey(hit.title) === selfShown && (looksCluttered(selfTitle) || looksCluttered(hit.title));
      if ((sameMb || sameBase || sameShown) && g.key !== selfKey && !dismissed.has(pairKey(selfKey, g.key))) {
        same.push({ mangaId: hit.mangaId, title: hit.title, sourceName: hit.sourceName, label: other.label, selfLabel: self.label });
      } else keep.push(g);
    }
    return { groups: keep, sameSeries: same };
  }
  app.get("/api/merge-suggestions", async (req) => {
    const unlocked = gate.unlocked(req.headers.cookie);
    const adultSources = new Set((await listSources(config, fetchImpl).catch(() => [])).filter((x) => x.isNsfw).map((x) => x.name));
    const isAdult = (l: { title: string; sourceName: string | null; adult: boolean }) =>
      store.adultMark(l.title) ?? (l.adult || (!!l.sourceName && adultSources.has(l.sourceName)));
    const listings = store.knownListings().filter((l) => unlocked || !isAdult(l));
    return { suggestions: suggestMerges(listings, mbOf, store.dismissedMerges()).slice(0, 100) };
  });
  app.post<{ Body: { key?: unknown; a?: unknown; b?: unknown } }>("/api/merge-suggestions/dismiss", async (req, reply) => {
    const b = req.body ?? {};
    const key = typeof b.key === "string" ? b.key : typeof b.a === "string" && typeof b.b === "string" ? pairKey(normalizeTitle(b.a), normalizeTitle(b.b)) : "";
    if (!key.includes("|")) return reply.code(400).send({ error: "Which pair?" });
    store.dismissMerge(key);
    return { ok: true };
  });

  /**
   * Whether each suggested series is explicit: its MangaBaka rating where known (erotica/pornographic), else
   * any listing on an 18+ source, marked 18+, classified adult, or carrying an adult tag. Unknown = null.
   */
  const EXPLICIT = new Set(["erotica", "pornographic"]);
  const ADULT_TAGS = new Set(["adult", "hentai", "smut", "erotica", "pornographic", "porn", "uncensored", "sexual violence"]);
  async function groupRatings(groups: SeriesGroup[]): Promise<Map<string, "explicit" | "clean" | null>> {
    const sources = await listSources(config, fetchImpl).catch(() => [] as EngineSource[]);
    const adultSources = new Set(sources.filter((x) => x.isNsfw).map((x) => x.id));
    const classified = store.seriesAdult(groups.flatMap((g) => g.hits.map((h) => h.mangaId)));
    const out = new Map<string, "explicit" | "clean" | null>();
    for (const g of groups) {
      const mb = (store.bakaLink(normalizeTitle(g.title))?.data as BakaSeries | null | undefined)?.contentRating ?? null;
      if (mb) {
        out.set(g.key, EXPLICIT.has(mb) ? "explicit" : "clean");
        continue;
      }
      const explicit =
        g.hits.some((h) => adultSources.has(h.sourceId) || store.adultMark(h.title) === true || classified.get(h.mangaId) === true) ||
        g.hits.some((h) => (store.seriesTags(h.mangaId) ?? []).some((t) => ADULT_TAGS.has(t.trim().toLowerCase())));
      const clean = !explicit && g.hits.some((h) => store.adultMark(h.title) === false || classified.get(h.mangaId) === false);
      out.set(g.key, explicit ? "explicit" : clean ? "clean" : null);
    }
    return out;
  }

  // Names in a gallery-style description that other series share: the work parodied, the circle, the characters.
  const FACET_ROWS: Record<string, string> = { Parodies: "Same parody", Groups: "Same group", Characters: "Same character" };
  /**
   * Rows of series sharing this one's parody, group or character (Dan, Nov 24), found by searching your
   * sources for the name. Primary ones first, then the first parody and group; characters only when you
   * picked one (names alone are noisy). At most three rows.
   */
  async function facetRowsFor(about: ReturnType<typeof parseDescription>, primaryLower: Set<string>, scope: Scope, selfKey: string, selfId: number): Promise<FacetRow[]> {
    const facets = (about.facets ?? []).filter((f) => f.label in FACET_ROWS);
    const picks: { label: string; value: string }[] = [];
    const add = (label: string, value: string) => {
      if (!picks.some((p) => p.value.toLowerCase() === value.toLowerCase())) picks.push({ label, value });
    };
    for (const f of facets) for (const v of f.values) if (primaryLower.has(v.toLowerCase())) add(f.label, v);
    for (const label of ["Parodies", "Groups"]) {
      const v = facets.find((f) => f.label === label)?.values[0];
      if (v) add(label, v);
    }
    const rows = await Promise.all(
      picks.slice(0, 3).map(async (p) => {
        const r = await searchAll(config, p.value, { fetchImpl, scope, onResult: report }).catch(() => null);
        const groups = (r?.groups ?? []).filter((g) => g.key !== selfKey && !g.hits.some((h) => h.mangaId === selfId)).slice(0, 18);
        return { label: FACET_ROWS[p.label], value: p.value, groups };
      }),
    );
    return rows.filter((r) => r.groups.length > 0);
  }

  app.get<{ Params: { id: string }; Querystring: { debug?: string; tags?: string } }>("/api/manga/:id/similar", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const manga = await detailsFor(id);
      const scope = scopeFor(req);
      // ?tags=a|b tries a subset of the primary tags (the "try with fewer" options) without saving it.
      const override = typeof req.query.tags === "string" ? req.query.tags.split("|").map((t) => t.trim()).filter(Boolean).slice(0, 8) : null;
      const primary = override ?? primaryTagsOf(manga.title);
      const key = `${id}|${scope}|${primary.join("|")}`;
      const debug = req.query.debug === "1";
      const finish = async (c: { groups: unknown[]; basedOn: string[]; primary?: PrimaryInfo; facetRows?: FacetRow[] }) => {
        const split = splitSame(manga.title, c.groups as SeriesGroup[]);
        const shown = await withoutHidden(split.groups);
        const shownKeys = new Set(shown.map((g) => g.key));
        const facetRows = [];
        for (const r of c.facetRows ?? []) {
          // A series already in the main grid isn't repeated in a row below it.
          const groups = (await withoutHidden(r.groups)).filter((g) => !shownKeys.has(g.key));
          if (groups.length > 0) facetRows.push({ ...r, groups });
        }
        const primaryOut = c.primary
          ? { ...c.primary, subsets: await Promise.all(c.primary.subsets.map(async (x) => ({ tags: x.tags, groups: await withoutHidden(x.groups) }))) }
          : undefined;
        return { groups: shown, basedOn: c.basedOn, sameSeries: split.sameSeries, ...(primaryOut ? { primary: primaryOut } : {}), facetRows };
      };
      const cached = similarCache.get(key);
      if (cached && !debug && Date.now() - cached.at < 60 * 60 * 1000) return await finish(cached);
      // MangaBaka's view of this series (remembered, so usually instant) sharpens the ranking and adds its own picks.
      const mb = await bakaFor(id, false).catch(() => null);
      const self = mb?.match ? (store.bakaLink(normalizeTitle(manga.title))?.data as BakaSeries | null) : null;
      const selfVec = self ? bakaVector(self.tags) : null;
      const selfAdult = await adultFor(manga.sourceId, manga.title).catch(() => false);
      const selfExplicit = self?.contentRating ? EXPLICIT.has(self.contentRating) : selfAdult;
      const selfKey = normalizeTitle(manga.title);
      const description = await shownDescription(manga).catch(() => manga.description);
      const about = parseDescription(description, manga.title);
      // Primary tags, split by where they can be matched: the sites' genres, MangaBaka's tags, or a parody/group/character name.
      const genreNames = new Map([...manga.genre, ...(about.tags ?? [])].map((g) => [canonKey(g), g] as const));
      const primaryGenres = primary.filter((t) => genreNames.has(canonKey(t))).map((t) => genreNames.get(canonKey(t))!);
      const primaryLower = new Set(primary.map((t) => t.toLowerCase()));
      const selfImportance = importanceFor(manga.title).importance;
      const boost = selfVec ? (g: SeriesGroup) => { const v = groupVec(g); return boostFrom(v ? cosine(selfVec, v) : null); } : undefined;
      const sourceSide = async () => {
        const prim = primaryGenres.length > 0 ? await primaryBrowse(config, manga.title, primaryGenres, { fetchImpl, onResult: report, scope, selfId: id, boost }) : null;
        if (prim && prim.groups.length > 0) return { groups: prim.groups, basedOn: prim.matchedAll ? primaryGenres : prim.subsets[0].tags, prim };
        // No primary genres, or nothing at all found with them: the automatic pick.
        const auto = await similarTo(config, manga.title, manga.genre, {
          fetchImpl,
          onResult: report,
          scope,
          selfId: id,
          // Its own tags count by how central they are to it (MangaBaka's ranks), not by rarity (Dan, Nov 25).
          knowledge: { weight: (t) => selfImportance(t) * commonFactor(t), tagsOf: (m) => store.seriesTags(m) },
          boost,
        });
        return { ...auto, prim };
      };
      const [source, fromBaka, rawFacetRows] = await Promise.all([
        sourceSide(),
        self ? bakaSimilar(self, { scope, explicit: selfExplicit, primary }).catch(() => ({ groups: [] as SeriesGroup[], shared: [] as string[], stats: null })) : Promise.resolve({ groups: [] as SeriesGroup[], shared: [] as string[], stats: null }),
        facetRowsFor(about, primaryLower, scope, selfKey, id).catch(() => [] as FacetRow[]),
      ]);
      // MangaBaka's picks lead (they share this series' specific tags, not just its broad genres). After them
      // come the genre-based ones, closest first, leaving out any MangaBaka knows to share almost nothing.
      const groups: SeriesGroup[] = [];
      const seenKeys = new Set<string>([selfKey]);
      const unrelated = (g: SeriesGroup) => {
        if (!selfVec || fromBaka.groups.length === 0 || source.prim?.groups.length) return false;
        const v = groupVec(g);
        return v !== null && cosine(selfVec, v) < 0.08;
      };
      // Explicit series suggest explicit series, and the rest don't suggest explicit ones (Dan, Nov 24).
      const subsetGroups = (source.prim?.subsets ?? []).flatMap((x) => x.groups);
      const ratings = await groupRatings([...fromBaka.groups, ...source.groups, ...rawFacetRows.flatMap((r) => r.groups), ...subsetGroups]);
      const fits = (g: SeriesGroup) => {
        const r = ratings.get(g.key) ?? null;
        return selfExplicit ? r === "explicit" : r !== "explicit";
      };
      for (const g of [...fromBaka.groups, ...source.groups.filter((g) => !unrelated(g))].filter(fits)) {
        if (seenKeys.has(g.key) || g.hits.some((h) => h.mangaId === id)) continue;
        seenKeys.add(g.key);
        groups.push(g);
      }
      const usedPrimary = primary.length > 0 && (source.prim?.groups.length || fromBaka.shared.some((n) => primaryLower.has(n.toLowerCase())));
      const basedOn = usedPrimary
        ? [...new Set([...(source.prim?.groups.length ? source.basedOn : []), ...fromBaka.shared.filter((n) => primaryLower.has(n.toLowerCase()))])]
        : fromBaka.groups.length > 0 && fromBaka.shared.length > 0
          ? fromBaka.shared
          : source.basedOn;
      const primaryInfo: PrimaryInfo | undefined =
        primary.length > 0
          ? {
              tags: primary,
              matchedAll: primaryGenres.length === 0 || source.prim?.matchedAll === true,
              subsets: (source.prim?.subsets ?? []).map((x) => ({ tags: x.tags, groups: x.groups.filter(fits) })).filter((x) => x.groups.length > 0),
            }
          : undefined;
      const facetRows = rawFacetRows.map((r) => ({ ...r, groups: r.groups.filter(fits) })).filter((r) => r.groups.length > 0);
      enrichGroups(source.groups, 12);
      const entry = { at: Date.now(), groups, basedOn, primary: primaryInfo, facetRows };
      if (groups.length > 0 || facetRows.length > 0) similarCache.set(key, entry);
      const result = await finish(entry);
      // ?debug=1 says how the list was built, for checking against live MangaBaka and sources.
      if (debug) {
        return {
          ...result,
          debug: {
            mangabaka: self ? { id: self.id, rating: self.contentRating, tags: self.tags.length, withIds: self.tags.filter((t) => t.id !== undefined).length } : null,
            explicit: selfExplicit,
            primary: { all: primary, genres: primaryGenres },
            baka: fromBaka.stats,
            genre: { found: source.groups.length, kept: source.groups.filter((g) => !unrelated(g) && fits(g)).length },
            facets: rawFacetRows.map((r) => ({ value: r.value, found: r.groups.length })),
          },
        };
      }
      return result;
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

  // ---- MangaBaka: detailed, weighted tags and a content rating for a series -----------------------
  const baka = options.baka ?? new MangaBaka(fetchImpl);
  const BAKA_FRESH_MS = 14 * 24 * 3600 * 1000;
  const BAKA_MISS_MS = 7 * 24 * 3600 * 1000;
  const WEIGHT_ORDER: TagWeight[] = ["core", "defining", "recurrent", "incidental", "unweighted"];
  const bakaView = (d: BakaSeries, manual: boolean) => ({
    id: d.id,
    title: d.title,
    url: bakaUrl(d.id),
    contentRating: d.contentRating,
    type: d.type,
    year: d.year,
    rating: d.rating,
    manual,
    // Spoiler tags never leave the server; the rest come most telling first.
    tags: d.tags
      .filter((t) => !t.spoiler)
      .sort((a, b) => WEIGHT_ORDER.indexOf(a.weight) - WEIGHT_ORDER.indexOf(b.weight))
      .map((t) => ({ ...(t.id !== undefined ? { id: t.id } : {}), name: t.name, path: t.path, weight: t.weight, genre: t.genre })),
  });
  /** The series' MangaBaka entry: remembered for two weeks (a miss for one), looked up again after that. */
  // The series page and Similar ask at the same moment; share one lookup.
  const bakaInFlight = new Map<string, Promise<{ status: string; match: ReturnType<typeof bakaView> | null }>>();
  function bakaFor(mangaId: number, refresh: boolean) {
    const k = `${mangaId}|${refresh}`;
    const running = bakaInFlight.get(k);
    if (running) return running;
    const p = bakaLookup(mangaId, refresh).finally(() => bakaInFlight.delete(k));
    bakaInFlight.set(k, p);
    return p;
  }
  async function bakaLookup(mangaId: number, refresh: boolean): Promise<{ status: string; match: ReturnType<typeof bakaView> | null }> {
    const manga = await detailsFor(mangaId);
    const key = normalizeTitle(manga.title);
    const link = store.bakaLink(key);
    const age = link ? Date.now() - Date.parse(link.fetchedAt) : Infinity;
    const data = link?.data as BakaSeries | null | undefined;
    if (link && !refresh) {
      if (link.mbId === null && (link.manual || age < BAKA_MISS_MS)) return { status: link.manual ? "none-manual" : "none", match: null };
      // Records saved before tag ids were kept can't drive tag searches (Similar's "telling" tags came back
      // empty, Dan's debug output Nov 24), so those are fetched again, at most hourly.
      const noIds = !!data && data.tags.length > 0 && data.tags.every((t) => t.id === undefined) && age > 3600 * 1000;
      if (link.mbId !== null && data && age < BAKA_FRESH_MS && !noIds) return { status: "matched", match: bakaView(data, link.manual) };
    }
    try {
      let id = link?.manual || (link?.mbId != null && !refresh) ? link!.mbId : null;
      if (id === null && !link?.manual) {
        const description = await shownDescription(manga).catch(() => manga.description);
        const names = [displayTitle(manga.title), manga.title, ...mergedWith(manga.title).map((m) => m.title), ...parseDescription(description, manga.title).altTitles];
        const anilistId = store.getTrackerLink(mangaId, "anilist")?.mediaId ?? store.anilistMeta([key]).get(key)?.anilistId ?? null;
        id = (await findOnBaka(baka, names, anilistId))?.id ?? null;
      }
      const series = id !== null ? await baka.series(id) : null;
      store.putBakaLink(key, series?.id ?? null, link?.manual ?? false, series);
      return series ? { status: "matched", match: bakaView(series, link?.manual ?? false) } : { status: link?.manual ? "none-manual" : "none", match: null };
    } catch (err) {
      app.log.warn(err, "couldn't reach MangaBaka");
      // Offline or busy: what we knew before is better than nothing.
      return { status: "unavailable", match: data ? bakaView(data, link?.manual ?? false) : null };
    }
  }
  /** The MangaBaka tag vector for a title key, if that series has been matched. */
  const bakaVecFor = (key: string): TagVector | null => {
    const d = store.bakaLink(key)?.data as BakaSeries | null | undefined;
    return d && Array.isArray(d.tags) && d.tags.length > 0 ? bakaVector(d.tags) : null;
  };
  const groupVec = (g: SeriesGroup): TagVector | null => {
    for (const k of [g.key, ...g.hits.map((h) => normalizeTitle(h.title))]) {
      const v = bakaVecFor(k);
      if (v) return v;
    }
    return null;
  };
  /**
   * Looks series up on MangaBaka in the background, one at a time (its limits are per minute), so the next
   * For you or Similar has their tags. Stops for this round when MangaBaka doesn't answer.
   */
  const bakaPending = new Map<string, string>();
  let bakaRunning = false;
  function enrichBaka(items: { key: string; title: string }[], max = 20): void {
    let added = 0;
    for (const it of items) {
      if (added >= max) break;
      if (!it.key || !it.title || bakaPending.has(it.key) || store.bakaLink(it.key)) continue;
      bakaPending.set(it.key, it.title);
      added++;
    }
    if (bakaRunning || bakaPending.size === 0) return;
    bakaRunning = true;
    void (async () => {
      try {
        for (const [key, title] of bakaPending) {
          bakaPending.delete(key);
          if (store.bakaLink(key)) continue;
          const anilistId = store.anilistMeta([key]).get(key)?.anilistId ?? null;
          const hit = await findOnBaka(baka, [title], anilistId);
          const series = hit ? await baka.series(hit.id) : null;
          store.putBakaLink(key, series?.id ?? null, false, series);
        }
      } catch (err) {
        app.log.warn(err, "MangaBaka background lookups stopped for now");
        bakaPending.clear();
      } finally {
        bakaRunning = false;
      }
    })();
  }
  /** Multiplies a candidate's fit by how well its MangaBaka tags match your taste; undefined when there's nothing to go on. */
  /** A liked series' MangaBaka vector with its primary tags counting double. */
  function withPrimary(v: TagVector | null, l: LikedSeries): TagVector | null {
    if (!v || !l.primary?.length) return v;
    const data = store.bakaLink(normalizeTitle(l.title))?.data as BakaSeries | null | undefined;
    const names = new Set(l.primary.map((x) => x.toLowerCase()));
    const out = new Map(v);
    for (const t of data?.tags ?? []) {
      if (!names.has(t.name.toLowerCase())) continue;
      const k = t.path.split(">").map((p) => p.trim().toLowerCase()).filter(Boolean).join(">");
      const w = out.get(k);
      if (w !== undefined) out.set(k, w * 2);
    }
    return out;
  }
  function tasteBoost(liked: LikedSeries[], disliked: { titleKey: string }[]): ((g: SeriesGroup) => number) | undefined {
    enrichBaka(liked.filter((l) => l.mangaId !== FAVORITES_ID).map((l) => ({ key: normalizeTitle(l.title), title: l.title })));
    const items = [
      ...liked.map((l) => ({ weight: l.weight, vec: l.title ? withPrimary(bakaVecFor(normalizeTitle(l.title)), l) : null })),
      ...disliked.map((d) => ({ weight: -0.8, vec: bakaVecFor(d.titleKey) })),
    ].filter((x): x is { weight: number; vec: TagVector } => x.vec !== null);
    const taste = tasteVector(items);
    if (taste.size === 0) return undefined;
    return (g) => {
      const v = groupVec(g);
      return boostFrom(v ? cosine(taste, v) : null);
    };
  }
  /** Count of liked series with MangaBaka tags, part of For you's cache key so new tags bring a rebuild. */
  const bakaKnown = (liked: LikedSeries[]) => liked.filter((l) => l.title && bakaVecFor(normalizeTitle(l.title))).length;
  /** Queue the candidates of a finished list for MangaBaka lookups. */
  const enrichGroups = (groups: SeriesGroup[], max = 20) => enrichBaka(groups.map((g) => ({ key: g.key, title: g.hits[0]?.title ?? g.title })), max);

  /**
   * MangaBaka's own Similar series for this one (best first), found on your sources. Explicit ones are left
   * out unless this series is 18+. Also says which tags they share most, for the "Matched on" line.
   */
  /** Series carrying a MangaBaka tag, remembered for a week (the tag search is rate-limited). */
  async function bakaTagPool(tagId: number, rating?: string): Promise<BakaSeries[]> {
    const key = `mb_tag.${tagId}${rating ? `.${rating}` : ""}`;
    try {
      const c = JSON.parse(store.getSetting(key) ?? "null") as { at: number; list: BakaSeries[] } | null;
      if (c && Date.now() - c.at < 7 * 24 * 3600 * 1000) return c.list;
    } catch {
      // Ask again.
    }
    const list = await baka.byTag(tagId, 50, rating);
    store.setSetting(key, JSON.stringify({ at: Date.now(), list }));
    return list;
  }

  /** MangaBaka rates this series erotica or pornographic (the ordinary page leaves those out). */
  const explicitOnBaka = (g: SeriesGroup) => EXPLICIT.has((store.bakaLink(g.key)?.data as BakaSeries | null | undefined)?.contentRating ?? "");

  /** MangaUpdates' reader recommendations for one of your series, through its MangaBaka match. Remembered a week. */
  async function updatesRecsFor(title: string): Promise<UpdatesRec[]> {
    const mbId = store.bakaLink(normalizeTitle(title))?.mbId;
    if (!mbId) return [];
    const key = `mu_recs.${mbId}`;
    try {
      const c = JSON.parse(store.getSetting(key) ?? "null") as { at: number; recs: UpdatesRec[] } | null;
      if (c && Date.now() - c.at < 7 * 24 * 3600 * 1000) return c.recs;
    } catch {
      // Ask again.
    }
    const recs = (await baka.updatesRecs(mbId)).slice(0, 20);
    store.setSetting(key, JSON.stringify({ at: Date.now(), recs }));
    return recs;
  }

  /**
   * Tags too broad to find neighbours by: reader demographics and who the lead is. Thousands of series carry
   * them, so a 50-title search on one returns the most popular of everything (Dan, Nov 24: "Matched mostly on
   * Seinen, Big Breasts, Male Lead" for a thin list).
   */
  const BROAD_TAG = /^(seinen|shou?nen|josei|shou?jo|kodomo|male lead|female lead|male protagonist|female protagonist|adult|mature|ecchi|smut|hentai|pornographic|erotica|manhwa|manhua|manga|webtoon|full colou?r|long strip)$/i;
  const broadTag = (t: BakaTag) => BROAD_TAG.test(t.name.trim()) || /^demographic/i.test(t.path) || (t.count !== undefined && t.count > 15000);

  /**
   * The tags that say most about a series: the most central first (core, then defining, then recurrent; MangaBaka's
   * own order within a rank), no genres, spoilers or broad tags. Not by rarity (Dan, Nov 25).
   */
  function tellingTags(s: BakaSeries, n: number) {
    const rank: Record<string, number> = { core: 0, defining: 1, recurrent: 2 };
    return s.tags
      .filter((t) => t.id !== undefined && !t.genre && !t.spoiler && t.weight in rank && !broadTag(t))
      .sort((a, b) => rank[a.weight] - rank[b.weight])
      .slice(0, n);
  }

  interface SimilarStats { telling: string[]; listed: number; pool: number; ranked: number; tried: number; found: number }

  /**
   * Similar series by MangaBaka's detailed tags. The pool is MangaBaka's own "similar" list plus the series
   * carrying this one's most telling tags (one tag search each, narrowed to this series' content rating);
   * every candidate is ranked by how closely its whole weighted tag set matches this one (cosine), kept to
   * the same content rating, and the best are looked up on your sources until enough are found. Explicit
   * series get a bigger search: their neighbours are less often on any one source.
   */
  async function bakaSimilar(self: BakaSeries, opts: { scope: Scope; explicit: boolean; primary?: string[] }): Promise<{ groups: SeriesGroup[]; shared: string[]; stats: SimilarStats }> {
    const fits = (r: BakaSeries) => r.id !== self.id && (opts.explicit ? EXPLICIT.has(r.contentRating ?? "") : !EXPLICIT.has(r.contentRating ?? ""));
    const selfVec = bakaVector(self.tags);
    const pool = new Map<number, { series: BakaSeries; bonus: number }>();
    const listed = await baka.similar(self.id).catch(() => []);
    // MangaBaka's own list also weighs author and relations, so its picks get a small head start.
    for (const x of listed) if (fits(x.series)) pool.set(x.series.id, { series: x.series, bonus: 0.1 });
    // Your primary tags for this series, where MangaBaka has them, replace the automatic pick (Dan, Nov 24).
    const lower = new Set((opts.primary ?? []).map((n) => n.trim().toLowerCase()));
    const primaryTags = self.tags.filter((t) => t.id !== undefined && lower.has(t.name.toLowerCase()));
    const telling = primaryTags.length > 0 ? primaryTags : tellingTags(self, opts.explicit ? 5 : 4);
    const pNames = new Set(primaryTags.map((t) => t.name.toLowerCase()));
    const carries = (r: BakaSeries) => (pNames.size === 0 ? 0 : r.tags.filter((t) => pNames.has(t.name.toLowerCase())).length);
    // An explicit series searches its own rating; others search unfiltered and drop explicit ones below.
    const rating = opts.explicit ? (self.contentRating && EXPLICIT.has(self.contentRating) ? self.contentRating : "pornographic") : undefined;
    for (const t of telling) {
      for (const r of await bakaTagPool(t.id!, rating).catch(() => [] as BakaSeries[])) if (fits(r) && !pool.has(r.id)) pool.set(r.id, { series: r, bonus: 0 });
    }
    // With primary tags, the ones carrying more of them come first; closeness on every tag orders the rest.
    const ranked = [...pool.values()]
      .map((x) => ({ ...x, score: cosine(selfVec, bakaVector(x.series.tags)) + x.bonus, p: carries(x.series) }))
      .filter((x) => x.score > 0.12 || x.p > 0)
      .sort((a, b) => b.p - a.p || b.score - a.score);
    // Remember these records, so their tags and rating are known later without another lookup.
    for (const { series } of ranked) {
      const k = normalizeTitle(series.title);
      if (k && !store.bakaLink(k)) store.putBakaLink(k, series.id, false, series);
    }
    // Most won't be on your sources; look through the best, four at a time, until enough are found.
    const [budget, enough] = opts.explicit ? [60, 16] : [30, 12];
    const out: SeriesGroup[] = [];
    const found: BakaSeries[] = [];
    const wanted = ranked.slice(0, budget);
    let tried = 0;
    for (let i = 0; i < wanted.length && out.length < enough; i += 4) {
      const slice = wanted.slice(i, i + 4);
      tried += slice.length;
      const batch = await Promise.all(
        slice.map((x) => findOnSources(config, store, { id: x.series.id, titles: x.series.titles }, { fetchImpl, scope: opts.scope, onResult: report }, "baka_match").then((g) => ({ g, s: x.series }), () => null)),
      );
      for (const b of batch) {
        if (!b?.g || out.some((o) => o.key === b.g!.key)) continue;
        out.push(b.g);
        found.push(b.s);
        // The group's own key may differ from MangaBaka's title; remember the record under it too.
        if (!store.bakaLink(b.g.key)) store.putBakaLink(b.g.key, b.s.id, false, b.s);
      }
    }
    // "Matched on": this series' specific tags that the found ones share most.
    const names = new Set(self.tags.filter((t) => !t.genre && !t.spoiler && !broadTag(t)).map((t) => t.name));
    const counts = new Map<string, number>();
    for (const f of found) for (const t of f.tags) if (names.has(t.name)) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const shared = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
    const stats = { telling: telling.map((t) => t.name), listed: listed.length, pool: pool.size, ranked: ranked.length, tried, found: out.length };
    if (primaryTags.length > 0) return { groups: out, shared: primaryTags.map((t) => t.name), stats };
    return { groups: out, shared: shared.length ? shared : telling.map((t) => t.name), stats };
  }

  app.get<{ Querystring: { q?: string } }>("/api/mangabaka/tags", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) return { tags: [] };
    try {
      return { tags: await baka.searchTags(q) };
    } catch {
      return reply.code(502).send({ error: "Couldn't reach MangaBaka." });
    }
  });

  /**
   * Browsing by MangaBaka tags (Dan, Nov 24: "allow direct filtering on MangaBaka tags"). MangaBaka is asked
   * for series with the first tag (one page of 30; its search can't AND tags), the records are kept when
   * they also carry every other tag and any source genres picked alongside (by name), and fit the page's
   * rating (the 18+ page: erotica/pornographic only; elsewhere: neither). Then each is looked up on your
   * sources by title, four at a time. Pages are kept an hour; tag pages and source matches for a week.
   */
  const mbBrowseCache = new Map<string, { at: number; value: Promise<SearchResult & { note?: string }> }>();
  app.get<{ Querystring: { tag?: string | string[]; genre?: string | string[]; page?: string; adult?: string } }>("/api/mangabaka/browse", async (req, reply) => {
    const tags = ([] as string[]).concat(req.query.tag ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 6);
    const genres = ([] as string[]).concat(req.query.genre ?? []).map((g) => g.trim()).filter(Boolean).slice(0, 8);
    const adult = req.query.adult === "1";
    const page = pageOf(req.query.page);
    if (tags.length === 0) return reply.code(400).send({ error: "Pick a MangaBaka tag." });
    if (adult && !gate.unlocked(req.headers.cookie)) return reply.code(403).send({ error: "18+ mode is locked." });
    const scope = scopeFor(req);
    const key = `${tags.join(",")}|${genres.map(canonKey).join(",")}|${adult}|${scope}|${page}`;
    const hit = mbBrowseCache.get(key);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.value;
    const run = (async () => {
      const pull = async (rating?: string) => {
        const k = `mb_tagpage.${tags[0]}.${rating ?? "any"}.${page}`;
        try {
          const c = JSON.parse(store.getSetting(k) ?? "null") as { at: number; list: BakaSeries[] } | null;
          if (c && Date.now() - c.at < 7 * 24 * 3600 * 1000) return c.list;
        } catch {
          // Ask again.
        }
        const list = await baka.byTag(tags[0], 30, rating, page);
        store.setSetting(k, JSON.stringify({ at: Date.now(), list }));
        return list;
      };
      const lists = adult ? await Promise.all([pull("pornographic"), pull("erotica")]) : [await pull()];
      const seen = new Set<number>();
      const wantKeys = genres.map(canonKey);
      const records = lists.flat().filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        const explicit = EXPLICIT.has(r.contentRating ?? "");
        if (adult ? !explicit : explicit) return false;
        const ids = new Set(r.tags.map((t) => t.id));
        const names = new Set(r.tags.map((t) => canonKey(t.name)));
        return tags.slice(1).every((t) => ids.has(t)) && wantKeys.every((g) => names.has(g));
      });
      for (const r of records) {
        const k = normalizeTitle(r.title);
        if (k && !store.bakaLink(k)) store.putBakaLink(k, r.id, false, r);
      }
      const groups: SeriesGroup[] = [];
      for (let i = 0; i < records.length; i += 4) {
        const batch = await Promise.all(
          records.slice(i, i + 4).map((r) => findOnSources(config, store, { id: r.id, titles: r.titles }, { fetchImpl, scope, onResult: report }, "baka_match").catch(() => null)),
        );
        for (const g of batch) if (g && !groups.some((x) => x.key === g.key)) groups.push(g);
      }
      const shown = await withoutHidden(groups);
      return {
        groups: shown,
        failed: [],
        searched: 0,
        note: records.length > 0 ? `${shown.length} of ${records.length} MangaBaka series on this page found on your sources.` : undefined,
        // More pages exist while MangaBaka filled this one.
        more: lists.some((l) => l.length >= 30),
      } as SearchResult & { note?: string; more: boolean };
    })();
    mbBrowseCache.set(key, { at: Date.now(), value: run });
    run.catch(() => mbBrowseCache.delete(key));
    try {
      return await run;
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't reach MangaBaka." });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/api/manga/:id/mangabaka", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    return bakaFor(id, req.query.refresh === "1").catch(() => reply.code(502).send({ error: "Couldn't read this series from its source." }));
  });
  /** Pick the MangaBaka entry by hand (mbId), say it isn't there (null), or go back to automatic (DELETE). */
  app.put<{ Params: { id: string }; Body: { mbId?: unknown } }>("/api/manga/:id/mangabaka", async (req, reply) => {
    const id = Number(req.params.id);
    const mbId = req.body?.mbId;
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    if (mbId !== null && !(Number.isInteger(mbId) && (mbId as number) > 0)) return reply.code(400).send({ error: "Pick a MangaBaka entry." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    const key = normalizeTitle(manga.title);
    if (mbId === null) {
      store.putBakaLink(key, null, true, null);
      return { status: "none-manual", match: null };
    }
    const series = await baka.series(mbId as number).catch(() => undefined);
    if (series === undefined) return reply.code(502).send({ error: "Couldn't reach MangaBaka." });
    if (series === null) return reply.code(404).send({ error: "MangaBaka has no entry with that number." });
    store.putBakaLink(key, series.id, true, series);
    return { status: "matched", match: bakaView(series, true) };
  });
  app.delete<{ Params: { id: string } }>("/api/manga/:id/mangabaka", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    const manga = await detailsFor(id).catch(() => null);
    if (!manga) return reply.code(502).send({ error: "Couldn't read this series from its source." });
    store.clearBakaLink(normalizeTitle(manga.title));
    return bakaFor(id, true);
  });
  app.get<{ Querystring: { q?: string } }>("/api/mangabaka/search", async (req, reply) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { hits: [] };
    // A pasted address or number looks that entry up directly.
    const direct = /^(?:(?:www\.)?mangabaka\.(?:org|dev)\/(?:series\/)?)?(\d{1,9})\/?$/.exec(q.replace(/^https?:\/\//, ""));
    try {
      if (direct) {
        const s = await baka.series(Number(direct[1]));
        return { hits: s ? [{ id: s.id, title: s.title, titles: s.titles.slice(0, 4), type: s.type, year: s.year, url: bakaUrl(s.id) }] : [] };
      }
      const hits = await baka.search(q);
      return { hits: hits.map((h) => ({ id: h.id, title: h.title, titles: h.titles.slice(0, 4), type: h.type, year: h.year, url: bakaUrl(h.id) })) };
    } catch {
      return reply.code(502).send({ error: "Couldn't reach MangaBaka." });
    }
  });

  /**
   * Everything the series page shows. `live` is false for the quick answer from what the engine saved last
   * time (no source site involved), which skips the bookkeeping the live answer does.
   */
  async function seriesPayload(req: FastifyRequest, id: number, manga: MangaDetails, chapters: ChapterInfo[], live: boolean) {
    const description = await shownDescription(manga).catch(() => manga.description);
    const adultSource = await adultSourceOf(manga.sourceId);
    const mark = store.adultMark(manga.title);
    const adult = mark ?? adultSource;
    if (live) {
      if (store.inLibrary(id)) {
        store.setChapterNumbers(id, chapters.map((c) => c.chapterNumber));
        store.setGenres(id, manga.genre);
      }
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
      primaryTags: primaryTagsOf(manga.title),
      ...(live ? {} : { saved: true }),
    };
  }

  app.get<{ Params: { id: string } }>("/api/manga/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const [manga, chapters] = await Promise.all([detailsFor(id), chaptersFor(id)]);
      return await seriesPayload(req, id, manga, chapters, true);
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "Couldn't load this series from the source.", detail: reasonOf(err) });
    }
  });

  /**
   * The quick first answer for the series page: what the engine saved last time, without the source site.
   * The page shows it at once and swaps in the live answer when that arrives. A fresh chapter list already
   * fetched in the last few minutes is used instead of the saved one.
   */
  app.get<{ Params: { id: string } }>("/api/manga/:id/saved", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: "Bad id." });
    try {
      const cachedDetails = detailsCache.get(id);
      const [stored, chapters] = await Promise.all([
        fetchStoredManga(config, id, fetchImpl),
        chapterCache.get(id) && Date.now() - chapterCache.get(id)!.at < LATEST_TTL_MS ? chapterCache.get(id)!.value : fetchStoredChapters(config, id, fetchImpl).catch(() => [] as ChapterInfo[]),
      ]);
      // A resolved live answer in memory beats the engine's copy.
      const settled = cachedDetails ? await Promise.race([cachedDetails.value, new Promise<null>((r) => setTimeout(() => r(null), 0))]).catch(() => null) : null;
      return await seriesPayload(req, id, settled ?? stored.details, chapters, false);
    } catch (err) {
      req.log.warn(err, "no saved copy of this series");
      return reply.code(404).send({ error: "Nothing saved for this series yet." });
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

  /**
   * The other listings of a library series that Sapphire already knows (found together in "Also on", or
   * merged), with their chapter numbers. No searching: only listings seen before. At most 4 per series,
   * on sources in its scope, and only ones sharing most chapter numbers (so it's the same series).
   */
  async function otherSourcesOf(mangaId: number, ownNumbers: number[]): Promise<{ mangaId: number; sourceName: string; numbers: number[] }[]> {
    const item = store.library(true).find((i) => i.mangaId === mangaId);
    if (!item) return [];
    const titles = [item.title, ...mergedWith(item.title).map((m) => m.title)];
    const keys = [...new Set(titles.map(groupKey))];
    const sources = await listSources(config, fetchImpl).catch(() => [] as EngineSource[]);
    const allowed = new Set(sources.filter((x) => inScope(x, item.adult ? "all" : "safe")).map((x) => x.id));
    const listings = store
      .seenListings(keys)
      .filter((l) => l.mangaId !== mangaId && l.sourceId !== item.sourceId && allowed.has(l.sourceId))
      .filter((l, i, all) => all.findIndex((x) => x.mangaId === l.mangaId) === i)
      .slice(0, 4);
    const own = new Set(ownNumbers.filter((n) => n >= 0));
    const out: { mangaId: number; sourceName: string; numbers: number[] }[] = [];
    for (const l of listings) {
      try {
        chapterCache.delete(l.mangaId);
        const numbers = (await chaptersFor(l.mangaId)).map((c) => c.chapterNumber).filter((n) => n >= 0);
        const shared = numbers.filter((n) => own.has(n)).length / Math.max(1, own.size);
        if (own.size < 3 || shared >= 0.6) {
          const version = store.versionOf(l.mangaId);
          out.push({ mangaId: l.mangaId, sourceName: version && version !== store.versionOf(mangaId) ? `${l.sourceName} (${version})` : l.sourceName, numbers });
        }
      } catch {
        // That source is having a bad day; try again next check.
      }
    }
    return out;
  }

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
      elsewhere: otherSourcesOf,
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

  /** Frees NAS space: removes every downloaded chapter of a series that you've read, the last one you finished too (Dan, Nov 25). */
  function autoDeleteFor(mangaId: number): number {
    if (!automation().autoDelete) return 0;
    const read = new Set(store.readChapterIds(mangaId));
    let removed = 0;
    for (const d of store.downloads(true, mangaId)) {
      if (d.status === "done" && read.has(d.chapterId)) {
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
      // Marking by hand counts like finishing in the reader: read downloads go, the next ones come.
      if (read && marked.length > 0 && store.inLibrary(id)) {
        autoDeleteFor(id);
        void autoDownloadFor(id).catch(() => 0);
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
