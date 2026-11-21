import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";
import { canonKey, canonLabel } from "./genres.js";
import {
  fetchMangaDetails,
  groupHits,
  inScope,
  listSources,
  type EngineSource,
  type Scope,
  type SearchResult,
  type SourceHit,
  type SourceReport,
} from "./search.js";

type FetchLike = typeof fetch;

/** A source's filter list as the engine reports it (only the parts genre browsing needs). */
export type EngineFilter =
  | { __typename: "CheckBoxFilter"; name: string }
  | { __typename: "TriStateFilter"; name: string }
  | { __typename: "SelectFilter"; name: string; values: string[] }
  | { __typename: "GroupFilter"; name: string; filters: EngineFilter[] }
  | { __typename: string; name?: string };

export interface FilterChange {
  position: number;
  checkBoxState?: boolean;
  triState?: "INCLUDE";
  selectState?: number;
  groupChange?: FilterChange;
}

const GENRE_NAME = /genre|categor|tag|theme/i;
const CONDITION_NAME = /condition|match|mode|operator|logic/i;

interface GenreSlot {
  /** The name this source uses. */
  name: string;
  /** Builds the change that turns this genre on. */
  change: () => FilterChange;
}

/** Finds where in a source's filters each genre can be switched on, keyed by canonical genre. */
export function genreSlots(filters: EngineFilter[]): Map<string, GenreSlot> {
  const slots = new Map<string, GenreSlot>();
  filters.forEach((f, position) => {
    if (f.__typename === "GroupFilter" && GENRE_NAME.test(f.name ?? "")) {
      (f as Extract<EngineFilter, { __typename: "GroupFilter" }>).filters.forEach((child, i) => {
        if ((child.__typename !== "CheckBoxFilter" && child.__typename !== "TriStateFilter") || !child.name) return;
        const key = canonKey(child.name);
        if (slots.has(key)) return;
        const on = child.__typename === "CheckBoxFilter" ? { checkBoxState: true } : { triState: "INCLUDE" as const };
        slots.set(key, { name: child.name, change: () => ({ position, groupChange: { position: i, ...on } }) });
      });
    } else if (f.__typename === "SelectFilter" && /genre|categor/i.test(f.name ?? "")) {
      (f as Extract<EngineFilter, { __typename: "SelectFilter" }>).values.forEach((v, i) => {
        const key = canonKey(v);
        // Index 0 is nearly always "All"/"Any", which isn't a genre.
        if (i === 0 || !key || slots.has(key)) return;
        slots.set(key, { name: v, change: () => ({ position, selectState: i }) });
      });
    }
  });
  return slots;
}

/** Some sources have an "OR / AND" switch for their genre list; this finds the change that picks AND. */
function matchAllChange(filters: EngineFilter[]): FilterChange | null {
  for (const [position, f] of filters.entries()) {
    if (f.__typename !== "SelectFilter" || !CONDITION_NAME.test(f.name ?? "")) continue;
    const values = (f as Extract<EngineFilter, { __typename: "SelectFilter" }>).values;
    const idx = values.findIndex((v) => /^\s*(and|all)\b/i.test(v));
    if (idx >= 0) return { position, selectState: idx };
  }
  return null;
}

export interface GenrePlan {
  /** What to send to the source so it narrows the list itself. */
  changes: FilterChange[];
  /** Requested genres (canonical keys) the source can't filter by; results are checked against these afterwards. */
  missing: string[];
}

/**
 * Turns "these genres" into the filter changes one source understands, and says which genres it
 * can't filter by. Returns null when the source can't filter by any of them.
 */
export function planGenreFilters(filters: EngineFilter[], genres: string[]): GenrePlan | null {
  const slots = genreSlots(filters);
  const changes: FilterChange[] = [];
  const missing: string[] = [];
  let usedSelect = false;
  for (const g of genres) {
    const key = canonKey(g);
    const slot = slots.get(key);
    if (!slot) {
      missing.push(key);
      continue;
    }
    const change = slot.change();
    // A single-choice list can only take one genre; the rest get checked afterwards.
    if (change.selectState !== undefined) {
      if (usedSelect) {
        missing.push(key);
        continue;
      }
      usedSelect = true;
    }
    changes.push(change);
  }
  if (changes.length === 0) return null;
  if (changes.length > 1) {
    const all = matchAllChange(filters);
    if (all) changes.push(all);
  }
  return { changes, missing };
}

// The id is spliced in (digits only) so this doesn't depend on the engine's exact ID type name.
const filtersQuery = (id: string) => `
  query {
    source(id: "${id}") {
      filters {
        __typename
        ... on CheckBoxFilter { name }
        ... on TriStateFilter { name }
        ... on SelectFilter { name values }
        ... on GroupFilter {
          name
          filters {
            __typename
            ... on CheckBoxFilter { name }
            ... on TriStateFilter { name }
          }
        }
      }
    }
  }`;

const FILTER_TTL_MS = 60 * 60 * 1000;
const filterCache = new Map<string, { at: number; value: EngineFilter[] }>();

export function clearFilterCache(): void {
  filterCache.clear();
  primedAt.clear();
}

const primedAt = new Map<string, number>();

async function loadFilters(config: Config, sourceId: string, fetchImpl?: FetchLike): Promise<EngineFilter[]> {
  const data = await engineQuery<{ source: { filters: EngineFilter[] } }>(config, filtersQuery(sourceId), {}, { fetchImpl });
  return data.source.filters;
}

async function filtersFor(config: Config, sourceId: string, fetchImpl?: FetchLike): Promise<EngineFilter[]> {
  const hit = filterCache.get(sourceId);
  if (hit && Date.now() - hit.at < FILTER_TTL_MS) return hit.value;
  if (!/^-?\d+$/.test(sourceId)) throw new Error("bad source id");
  let filters = await loadFilters(config, sourceId, fetchImpl);
  // Many extensions fetch their genre list from the site the first time they're used, so it's
  // empty until something has been loaded from them. Load one page, then ask again.
  if (genreSlots(filters).size === 0 && Date.now() - (primedAt.get(sourceId) ?? 0) > 30 * 60 * 1000) {
    primedAt.set(sourceId, Date.now());
    await engineQuery(
      config,
      `mutation ($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { mangas { id } } }`,
      { input: { source: sourceId, type: "POPULAR", page: 1 } },
      { fetchImpl, timeoutMs: 20000 },
    ).catch(() => {});
    filters = await loadFilters(config, sourceId, fetchImpl).catch(() => filters);
  }
  filterCache.set(sourceId, { at: Date.now(), value: filters });
  return filters;
}

function browsableSources(all: EngineSource[], scope: Scope) {
  return all.filter((s) => inScope(s, scope));
}

/** Every genre any of your sources can filter by (similar spellings merged), with how many sources offer it. */
export async function listGenres(
  config: Config,
  opts: { fetchImpl?: FetchLike; scope?: Scope } = {},
): Promise<{ name: string; sources: number }[]> {
  const { fetchImpl, scope = "safe" } = opts;
  const sources = browsableSources(await listSources(config, fetchImpl), scope);
  const counts = new Map<string, { name: string; sources: number }>();
  await Promise.all(
    sources.map(async (s) => {
      try {
        for (const [key, slot] of genreSlots(await filtersFor(config, s.id, fetchImpl))) {
          const entry = counts.get(key);
          if (entry) entry.sources++;
          else counts.set(key, { name: canonLabel(slot.name), sources: 1 });
        }
      } catch {
        // A source that can't report filters just doesn't contribute genres.
      }
    }),
  );
  return [...counts.values()].sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
}

/** For the Sources page: which sources can filter by genre, and what their filters look like. */
export async function genreSupport(
  config: Config,
  opts: { fetchImpl?: FetchLike; scope?: Scope } = {},
): Promise<{ id: string; name: string; genres: number; filters: string[]; error?: string }[]> {
  const { fetchImpl, scope = "safe" } = opts;
  const sources = browsableSources(await listSources(config, fetchImpl), scope);
  return Promise.all(
    sources.map(async (s) => {
      try {
        const filters = await filtersFor(config, s.id, fetchImpl);
        return {
          id: s.id,
          name: s.name,
          genres: genreSlots(filters).size,
          filters: filters.filter((f) => f.name).map((f) => `${f.__typename.replace(/Filter$/, "")}: ${f.name}`),
        };
      } catch (err) {
        return { id: s.id, name: s.name, genres: 0, filters: [], error: err instanceof Error ? err.message : "unknown error" };
      }
    }),
  );
}

const BROWSE_MUTATION = `
  mutation ($input: FetchSourceMangaInput!) {
    fetchSourceManga(input: $input) {
      mangas { id title thumbnailUrl }
    }
  }`;

export interface BrowseResult extends SearchResult {
  /** Sources that couldn't be searched at all because they can't filter by any of the chosen genres. */
  skipped: string[];
}

/** Runs `task` over `items`, a few at a time. */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await task(items[i]);
    }),
  );
  return out;
}

/**
 * Browses your sources for series that have ALL the chosen genres, optionally with a text query too.
 * Each source narrows by whatever genres it can filter on (asking for "match all" where it offers it);
 * for genres a source can't filter on, its top results are checked against the series' own genre list.
 */
export async function browseByGenres(
  config: Config,
  genres: string[],
  opts: { query?: string; fetchImpl?: FetchLike; scope?: Scope; timeoutMs?: number; onResult?: SourceReport; page?: number; seed?: number } = {},
): Promise<BrowseResult> {
  const { query, fetchImpl, scope = "safe", timeoutMs = 10000, onResult, page = 1, seed } = opts;
  const sources = browsableSources(await listSources(config, fetchImpl), scope);
  const failed: BrowseResult["failed"] = [];
  const skipped: string[] = [];
  let searched = 0;
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        // A source that can't filter by these genres still gets searched: its list is checked
        // against each series' own genres instead of being skipped.
        const plan: GenrePlan =
          planGenreFilters(await filtersFor(config, source.id, fetchImpl).catch(() => []), genres) ??
          { changes: [], missing: genres.map(canonKey) };
        searched++;
        const started = Date.now();
        const data = await engineQuery<{
          fetchSourceManga: { mangas: { id: number; title: string; thumbnailUrl: string | null }[] };
        }>(
          config,
          BROWSE_MUTATION,
          {
            input: {
              source: source.id,
              type: plan.changes.length === 0 && !query ? "POPULAR" : "SEARCH",
              page,
              query: query || null,
              filters: plan.changes,
            },
          },
          { fetchImpl, timeoutMs },
        );
        onResult?.(source, { ok: true, ms: Date.now() - started });
        let mangas = data.fetchSourceManga.mangas;
        if (plan.missing.length > 0) {
          // Check the rest against each series' own genres (a handful per page, to stay gentle on the site).
          const checked = await mapLimit(mangas.slice(0, 20), 5, async (m) => {
            try {
              const details = await fetchMangaDetails(config, m.id, fetchImpl);
              const have = new Set(details.genre.map(canonKey));
              return plan.missing.every((k) => have.has(k)) ? m : null;
            } catch {
              return null;
            }
          });
          mangas = checked.filter((m): m is NonNullable<typeof m> => m !== null);
        }
        return mangas.map<SourceHit>((m) => ({
          mangaId: m.id,
          sourceId: source.id,
          sourceName: source.name,
          title: m.title,
          thumbnailUrl: m.thumbnailUrl,
        }));
      } catch (err) {
        onResult?.(source, { ok: false, ms: 0, error: err instanceof Error ? err.message : "unknown error" });
        failed.push({ sourceName: source.name, error: err instanceof Error ? err.message : "unknown error" });
        return [];
      }
    }),
  );
  const hits = results.flat();
  // The series the person clicked the genre on always belongs in the answer, as long as it really has them all.
  if (seed !== undefined && page === 1 && !hits.some((h) => h.mangaId === seed)) {
    try {
      const d = await fetchMangaDetails(config, seed, fetchImpl);
      const have = new Set(d.genre.map(canonKey));
      if (genres.every((g) => have.has(canonKey(g)))) {
        hits.unshift({ mangaId: d.id, sourceId: d.sourceId, sourceName: d.sourceName ?? "Source", title: d.title, thumbnailUrl: null });
      }
    } catch {
      // The seed is a bonus; ignore failures.
    }
  }
  return { groups: groupHits(hits), failed, searched, skipped };
}
