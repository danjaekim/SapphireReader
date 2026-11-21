import type { Config } from "./config.js";
import { engineQuery } from "./engine.js";
import { groupHits, listSources, type EngineSource, type SearchResult, type SourceHit, type SourceReport, type Scope, inScope } from "./search.js";

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

const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const GENRE_NAME = /genre|categor|tag|theme/i;

interface GenreSlot {
  name: string;
  /** Builds the change that turns this genre on. */
  change: () => FilterChange;
}

/** Finds where in a source's filters each genre can be switched on. */
export function genreSlots(filters: EngineFilter[]): GenreSlot[] {
  const slots = new Map<string, GenreSlot>();
  filters.forEach((f, position) => {
    if (f.__typename === "GroupFilter" && GENRE_NAME.test(f.name ?? "")) {
      (f as Extract<EngineFilter, { __typename: "GroupFilter" }>).filters.forEach((child, i) => {
        if ((child.__typename !== "CheckBoxFilter" && child.__typename !== "TriStateFilter") || !child.name) return;
        const key = norm(child.name);
        if (slots.has(key)) return;
        const on = child.__typename === "CheckBoxFilter" ? { checkBoxState: true } : { triState: "INCLUDE" as const };
        slots.set(key, { name: child.name, change: () => ({ position, groupChange: { position: i, ...on } }) });
      });
    } else if (f.__typename === "SelectFilter" && /genre|categor/i.test(f.name ?? "")) {
      (f as Extract<EngineFilter, { __typename: "SelectFilter" }>).values.forEach((v, i) => {
        const key = norm(v);
        // Index 0 is nearly always "All"/"Any", which isn't a genre.
        if (i === 0 || !key || slots.has(key)) return;
        slots.set(key, { name: v, change: () => ({ position, selectState: i }) });
      });
    }
  });
  return [...slots.values()];
}

/**
 * Turns "these genres" into the filter changes one source understands.
 * Returns null when the source can't filter by every requested genre, or when it only offers a
 * single-choice genre list and more than one genre was asked for.
 */
export function planGenreFilters(filters: EngineFilter[], genres: string[]): FilterChange[] | null {
  const slots = new Map(genreSlots(filters).map((s) => [norm(s.name), s]));
  const changes: FilterChange[] = [];
  for (const g of genres) {
    const slot = slots.get(norm(g));
    if (!slot) return null;
    changes.push(slot.change());
  }
  const selects = changes.filter((c) => c.selectState !== undefined);
  if (selects.length > 1) return null;
  return changes;
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
}

async function filtersFor(config: Config, sourceId: string, fetchImpl?: FetchLike): Promise<EngineFilter[]> {
  const hit = filterCache.get(sourceId);
  if (hit && Date.now() - hit.at < FILTER_TTL_MS) return hit.value;
  if (!/^-?\d+$/.test(sourceId)) throw new Error("bad source id");
  const data = await engineQuery<{ source: { filters: EngineFilter[] } }>(config, filtersQuery(sourceId), {}, { fetchImpl });
  filterCache.set(sourceId, { at: Date.now(), value: data.source.filters });
  return data.source.filters;
}

function browsableSources(all: EngineSource[], scope: Scope) {
  return all.filter((s) => inScope(s, scope));
}

/** Every genre any of your sources can filter by, with how many sources offer it. */
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
        for (const slot of genreSlots(await filtersFor(config, s.id, fetchImpl))) {
          const key = norm(slot.name);
          const entry = counts.get(key);
          if (entry) entry.sources++;
          else counts.set(key, { name: slot.name, sources: 1 });
        }
      } catch {
        // A source that can't report filters just doesn't contribute genres.
      }
    }),
  );
  return [...counts.values()].sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
}

const BROWSE_MUTATION = `
  mutation ($input: FetchSourceMangaInput!) {
    fetchSourceManga(input: $input) {
      mangas { id title thumbnailUrl }
    }
  }`;

export interface BrowseResult extends SearchResult {
  /** Sources that were left out because they can't filter by every selected genre. */
  skipped: string[];
}

/** Browses every source that supports all the chosen genres at once, optionally with a text query too. */
export async function browseByGenres(
  config: Config,
  genres: string[],
  opts: { query?: string; fetchImpl?: FetchLike; scope?: Scope; timeoutMs?: number; onResult?: SourceReport } = {},
): Promise<BrowseResult> {
  const { query, fetchImpl, scope = "safe", timeoutMs = 10000, onResult } = opts;
  const sources = browsableSources(await listSources(config, fetchImpl), scope);
  const failed: BrowseResult["failed"] = [];
  const skipped: string[] = [];
  let searched = 0;
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const changes = planGenreFilters(await filtersFor(config, source.id, fetchImpl), genres);
        if (!changes) {
          skipped.push(source.name);
          return [];
        }
        searched++;
        const started = Date.now();
        const data = await engineQuery<{
          fetchSourceManga: { mangas: { id: number; title: string; thumbnailUrl: string | null }[] };
        }>(
          config,
          BROWSE_MUTATION,
          { input: { source: source.id, type: "SEARCH", page: 1, query: query || null, filters: changes } },
          { fetchImpl, timeoutMs },
        );
        onResult?.(source, { ok: true, ms: Date.now() - started });
        return data.fetchSourceManga.mangas.map<SourceHit>((m) => ({
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
  return { groups: groupHits(results.flat()), failed, searched, skipped };
}
