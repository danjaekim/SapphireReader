import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";
import { canonKey, canonLabel } from "./genres.js";
import {
  fetchMangaDetails,
  groupHits,
  interleaveGroups,
  scopedSources,
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
  | { __typename: "TextFilter"; name: string }
  | { __typename: "SortFilter"; name: string; values: string[] }
  | { __typename: string; name?: string };

export interface FilterChange {
  position: number;
  checkBoxState?: boolean;
  triState?: "INCLUDE";
  selectState?: number;
  groupChange?: FilterChange;
  textState?: string;
  sortState?: { index: number; ascending: boolean };
}

/** Orders Sapphire can ask for. "relevance" means each site's own default order. */
export type SortKey = "relevance" | "popular" | "latest" | "rating" | "newest" | "az";
export const SORT_KEYS: SortKey[] = ["relevance", "popular", "latest", "rating", "newest", "az"];

// How sites label each order, best match first. Sites word these very differently.
const SORT_WORDS: Record<Exclude<SortKey, "relevance">, RegExp[]> = {
  popular: [/^\s*(most\s+)?popular(ity)?\b/i, /popular|views?|most read|trending|hot\b|follow|bookmark|favou?rite/i],
  latest: [/latest|last\s+updated?|updated?|recent/i],
  rating: [/rating|rated|score/i, /^\s*top\b/i],
  newest: [/newest|^\s*new\b|added|created|release|date/i],
  az: [/a\s*-\s*z|alphabet|^\s*(title|name)\b/i],
};

/** The filter change that asks this source for `key` order, or null if it has no such order. */
export function sortChange(filters: EngineFilter[], key: SortKey): FilterChange | null {
  if (key === "relevance") return null;
  for (const re of SORT_WORDS[key]) {
    for (const [position, f] of filters.entries()) {
      const isSort = f.__typename === "SortFilter";
      const isSelect = f.__typename === "SelectFilter" && /sort|order/i.test(f.name ?? "") && !CONDITION_NAME.test(f.name ?? "");
      if (!isSort && !isSelect) continue;
      const values = (f as { values: string[] }).values ?? [];
      const index = values.findIndex((v) => re.test(v) && !/z\s*-\s*a|oldest|least|lowest|asc(ending)?\b/i.test(v));
      if (index < 0) continue;
      return isSort ? { position, sortState: { index, ascending: key === "az" } } : { position, selectState: index };
    }
  }
  return null;
}

// Sources call the same idea "genre", "tag", "category", "theme", "content" and so on.
const GENRE_NAME = /genre|categor|tag|theme|content|warning|label|keyword|type|demograph|format/i;
const CONDITION_NAME = /condition|match|mode|operator|logic/i;

interface GenreSlot {
  /** The name this source uses. */
  name: string;
  /** Builds the change that turns this genre on. */
  change: () => FilterChange;
}

type Group = Extract<EngineFilter, { __typename: "GroupFilter" }>;

/** Tick boxes inside a group, including groups nested in it (some sites split tags A–Z into subgroups). */
function addGroupSlots(slots: Map<string, GenreSlot>, group: Group, wrap: (inner: FilterChange) => FilterChange): void {
  group.filters.forEach((child, i) => {
    if (child.__typename === "GroupFilter") {
      addGroupSlots(slots, child as Group, (inner) => wrap({ position: i, groupChange: inner }));
      return;
    }
    if ((child.__typename !== "CheckBoxFilter" && child.__typename !== "TriStateFilter") || !child.name) return;
    const key = canonKey(child.name);
    if (!key || slots.has(key)) return;
    const on = child.__typename === "CheckBoxFilter" ? { checkBoxState: true } : { triState: "INCLUDE" as const };
    slots.set(key, { name: child.name, change: () => wrap({ position: i, ...on }) });
  });
}

/** Finds where in a source's filters each genre can be switched on, keyed by canonical genre. */
export function genreSlots(filters: EngineFilter[]): Map<string, GenreSlot> {
  const slots = new Map<string, GenreSlot>();
  filters.forEach((f, position) => {
    // Any group of tick boxes counts (sources name them all sorts of things), except obvious non-topics.
    if (f.__typename === "GroupFilter" && !/status|sort|order|year|language|rating/i.test(f.name ?? "")) {
      addGroupSlots(slots, f as Group, (inner) => ({ position, groupChange: inner }));
    } else if (f.__typename === "SelectFilter" && GENRE_NAME.test(f.name ?? "") && !CONDITION_NAME.test(f.name ?? "")) {
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

/** A free-text "Tags" box (e.g. NHentai-style sites' advanced search), which takes any tag by name. */
export function tagTextFilter(filters: EngineFilter[]): number | null {
  const i = filters.findIndex((f) => f.__typename === "TextFilter" && /^\s*(tags?|genres?|include(d)? tags?|tags? include)\s*$/i.test(f.name ?? ""));
  return i >= 0 ? i : null;
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
  // A tags text box takes every tag by name, including ones too rare to be in a tick-box list.
  const text = tagTextFilter(filters);
  if (text !== null) {
    return { changes: [{ position: text, textState: genres.map((g) => g.trim().toLowerCase()).join(", ") }], missing: [] };
  }
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
        ... on TextFilter { name }
        ... on SortFilter { name values }
        ... on GroupFilter {
          name
          filters {
            __typename
            ... on CheckBoxFilter { name }
            ... on TriStateFilter { name }
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

function browsableSources(all: EngineSource[], scope: Scope, only?: (s: EngineSource) => boolean) {
  return scopedSources(all, scope, only);
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
): Promise<{ id: string; name: string; genres: number; anyTag: boolean; filters: string[]; error?: string }[]> {
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
          anyTag: tagTextFilter(filters) !== null,
          filters: filters.filter((f) => f.name).map((f) => `${f.__typename.replace(/Filter$/, "")}: ${f.name}`),
        };
      } catch (err) {
        return { id: s.id, name: s.name, genres: 0, anyTag: false, filters: [], error: err instanceof Error ? err.message : "unknown error" };
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
  /** True when nothing matched the genres, so these are plain text-search results instead. */
  textFallback: boolean;
  /** Sources that have no such order, so their results are in their own default order. */
  unsorted: string[];
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
  opts: { query?: string; fetchImpl?: FetchLike; scope?: Scope; timeoutMs?: number; onResult?: SourceReport; page?: number; seed?: number; sort?: SortKey; strict?: boolean; only?: (s: EngineSource) => boolean } = {},
): Promise<BrowseResult> {
  // strict: only sources that can filter by every genre themselves; no per-series checks, no text
  // fallback. Fast, and every result really has the genres. Used for Similar and recommendations.
  const { query, fetchImpl, scope = "safe", timeoutMs = 10000, onResult, page = 1, seed, sort = "relevance", strict = false, only } = opts;
  const unsorted: string[] = [];
  const sources = browsableSources(await listSources(config, fetchImpl), scope, only);
  const failed: BrowseResult["failed"] = [];
  const skipped: string[] = [];
  let searched = 0;
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        // A source that can't filter by these genres still gets searched: its list is checked
        // against each series' own genres instead of being skipped.
        const filters = await filtersFor(config, source.id, fetchImpl).catch(() => [] as EngineFilter[]);
        const plan: GenrePlan =
          (genres.length > 0 ? planGenreFilters(filters, genres) : null) ?? { changes: [], missing: genres.map(canonKey) };
        if (strict && plan.missing.length > 0 && !(source.isNsfw && plan.changes.length === 0)) return [];
        const order = sortChange(filters, sort);
        if (sort !== "relevance" && !order) unsorted.push(source.name);
        const changes = order ? [...plan.changes, order] : plan.changes;
        // Sites like NHentai have no tag filter but take tags in the search box (tag:"glasses").
        // Only 18+ sources get this, and results are still checked against the series' own tags.
        const tagQuery =
          genres.length > 0 && plan.changes.length === 0 && source.isNsfw ? [query, ...genres.map((g) => `tag:"${canonLabel(g).toLowerCase()}"`)].filter(Boolean).join(" ") : null;
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
              type: changes.length === 0 && !query && !tagQuery ? (sort === "latest" ? "LATEST" : "POPULAR") : "SEARCH",
              page,
              query: tagQuery ?? (query || null),
              filters: changes,
            },
          },
          { fetchImpl, timeoutMs },
        );
        onResult?.(source, { ok: true, ms: Date.now() - started });
        let mangas = data.fetchSourceManga.mangas;
        if (plan.missing.length > 0 && !tagQuery) {
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
  let hits = results.flat();
  let lists: SourceHit[][] = results;
  // Last resort: nothing matched by genre anywhere, so search the genre names as plain text.
  let textFallback = false;
  if (hits.length === 0 && genres.length > 0 && !strict) {
    const text = [query, ...genres.map((g) => canonLabel(g))].filter(Boolean).join(" ");
    const loose = await Promise.all(
      sources.map(async (source) => {
        try {
          const data = await engineQuery<{
            fetchSourceManga: { mangas: { id: number; title: string; thumbnailUrl: string | null }[] };
          }>(config, BROWSE_MUTATION, { input: { source: source.id, type: "SEARCH", page, query: text, filters: [] } }, { fetchImpl, timeoutMs });
          return data.fetchSourceManga.mangas.map<SourceHit>((m) => ({
            mangaId: m.id,
            sourceId: source.id,
            sourceName: source.name,
            title: m.title,
            thumbnailUrl: m.thumbnailUrl,
          }));
        } catch {
          return [];
        }
      }),
    );
    hits = loose.flat();
    textFallback = hits.length > 0;
    lists = loose;
  }
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
  const groups = sort === "relevance" ? groupHits(hits) : orderGroups(lists, hits, sort);
  return { groups, failed, searched, skipped, textFallback, unsorted };
}

/** Each site already sorted its own list; merge them rank by rank (A–Z is simply sorted by title). */
function orderGroups(lists: SourceHit[][], hits: SourceHit[], sort: SortKey) {
  const extra = hits.filter((h) => !lists.some((l) => l.includes(h)));
  const groups = interleaveGroups([...extra.map((h) => [h]), ...lists]);
  if (sort === "az") groups.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  return groups;
}
