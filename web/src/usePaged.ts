import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { thumbnailUrl, type SearchResult, type SeriesGroup } from "./api";
import { parseHash } from "./route";

/** Adds a later page's series to the ones already shown, merging sources for the same series. */
export function mergeResults(a: SearchResult, b: SearchResult): { merged: SearchResult; added: number } {
  const byKey = new Map<string, SeriesGroup>(a.groups.map((g) => [g.key, { ...g, hits: [...g.hits] }]));
  let added = 0;
  for (const g of b.groups) {
    const have = byKey.get(g.key);
    if (!have) {
      byKey.set(g.key, { ...g, hits: [...g.hits] });
      added++;
    } else {
      for (const h of g.hits) if (!have.hits.some((x) => x.mangaId === h.mangaId)) have.hits.push(h);
    }
  }
  const failed = [...a.failed];
  for (const f of b.failed) if (!failed.some((x) => x.sourceName === f.sourceName)) failed.push(f);
  return {
    merged: { ...a, groups: [...byKey.values()], failed, searched: Math.max(a.searched, b.searched) },
    added,
  };
}

interface CacheEntry {
  result: SearchResult;
  page: number;
  more: boolean;
  scrollY: number;
}

// Results stay in memory so Back returns to the same list, scrolled to the same spot, without asking the sources again.
const cache = new Map<string, CacheEntry>();
const MAX_CACHED = 24;

export function clearPagedCache(): void {
  cache.clear();
}

/**
 * Loads page 1 whenever `key` changes (null means "don't load"), then more pages on demand.
 * Stops when a page brings nothing new.
 */
function remember(key: string, entry: CacheEntry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

/**
 * Warms the browser cache with a page's covers before its cards are near the screen, a few at a time and
 * at low priority so covers you can see go first. Covers come from the source site through the engine, which
 * is slow the first time; by the time you scroll there they're already loaded.
 */
const warmed = new Set<string>();
const coverWaiting: string[] = [];
let coverRunning = 0;
function pumpCovers() {
  while (coverRunning < 4 && coverWaiting.length > 0) {
    const url = coverWaiting.shift()!;
    coverRunning++;
    const img = new Image();
    (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
    img.decoding = "async";
    const done = () => {
      coverRunning--;
      pumpCovers();
    };
    img.onload = done;
    img.onerror = done;
    img.src = url;
  }
}
export function warmCovers(groups: SeriesGroup[]): void {
  for (const g of groups) {
    const id = g.cover ?? g.hits[0]?.mangaId;
    if (id === undefined) continue;
    const url = thumbnailUrl(id);
    if (warmed.has(url)) continue;
    warmed.add(url);
    coverWaiting.push(url);
  }
  pumpCovers();
}

export function usePaged(fetchPage: (page: number) => Promise<SearchResult>, key: string | null) {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  const page = useRef(1);
  const loading = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const restoreTo = useRef<number | null>(null);
  // The next page, asked for as soon as the current one is shown, so "load more" usually has it ready.
  const ahead = useRef<{ run: number; page: number; promise: Promise<SearchResult> } | null>(null);
  const fetchAhead = useCallback((runId: number, nextPage: number) => {
    if (ahead.current?.run === runId && ahead.current.page === nextPage) return;
    const promise = fetchRef.current(nextPage);
    // Covers for the next page start loading in the background too.
    promise.then((r) => runId === run.current && warmCovers(r.groups), () => undefined);
    ahead.current = { run: runId, page: nextPage, promise };
  }, []);

  useEffect(() => {
    const id = ++run.current;
    page.current = 1;
    loading.current = false;
    setError(null);
    if (key === null) {
      setResult(null);
      setMore(false);
      setBusy(false);
      return;
    }
    ahead.current = null;
    const cached = cache.get(key);
    if (cached) {
      page.current = cached.page;
      restoreTo.current = cached.scrollY;
      setResult(cached.result);
      setMore(cached.more);
      setBusy(false);
      if (cached.more) fetchAhead(id, cached.page + 1);
      return;
    }
    restoreTo.current = null;
    // A new tab or filter starts at the top, not wherever the last list was scrolled to.
    window.scrollTo(0, 0);
    setResult(null);
    setMore(false);
    setBusy(true);
    fetchRef.current(1).then(
      (r) => {
        if (id !== run.current) return;
        // A result can say for itself whether there's more (MangaBaka tag pages can find nothing on your
        // sources yet have more after them); otherwise an empty page ends the list.
        const said = (r as { more?: boolean }).more;
        const hasMore = said ?? r.groups.length > 0;
        setResult(r);
        setMore(hasMore);
        setBusy(false);
        remember(key, { result: r, page: 1, more: hasMore, scrollY: 0 });
        if (hasMore) {
          warmCovers(r.groups);
          fetchAhead(id, 2);
        }
      },
      (e: unknown) => {
        if (id !== run.current) return;
        setError(e instanceof Error ? e.message : "Couldn't load results.");
        setBusy(false);
      },
    );
  }, [key]);

  // Coming back to a remembered list: scroll to where you were once it has drawn.
  useLayoutEffect(() => {
    if (result && restoreTo.current !== null) {
      window.scrollTo(0, restoreTo.current);
      restoreTo.current = null;
    }
  }, [result]);

  // Remember the scroll position when you leave for a series or the reader (the address changes before the
  // page does). Switching tabs, filters or pages isn't "leaving": that list starts from the top next time.
  useEffect(() => {
    if (key === null) return;
    const save = () => {
      const entry = cache.get(key);
      if (!entry) return;
      entry.scrollY = parseHash(location.hash).name === "page" ? 0 : window.scrollY;
    };
    const saveNow = () => {
      const entry = cache.get(key);
      if (entry) entry.scrollY = window.scrollY;
    };
    window.addEventListener("hashchange", save);
    window.addEventListener("pagehide", saveNow);
    return () => {
      window.removeEventListener("hashchange", save);
      window.removeEventListener("pagehide", saveNow);
    };
  }, [key]);

  const loadMore = useCallback(() => {
    if (loading.current || !more || !result) return;
    loading.current = true;
    const id = run.current;
    const next = page.current + 1;
    // Usually already on its way (or here) from fetchAhead.
    fetchAhead(id, next);
    ahead.current!.promise
      .then((r) => {
        if (id !== run.current) return;
        page.current = next;
        const { merged, added } = mergeResults(result, r);
        const hasMore = (r as { more?: boolean }).more ?? added > 0;
        setResult(merged);
        setMore(hasMore);
        if (key !== null) remember(key, { result: merged, page: next, more: hasMore, scrollY: cache.get(key)?.scrollY ?? 0 });
        if (hasMore) fetchAhead(id, next + 1);
      })
      .catch(() => {
        if (id !== run.current) return;
        // Forget the failed page, so a later visit asks for it again.
        if (ahead.current?.page === next) ahead.current = null;
        setMore(false);
      })
      .finally(() => {
        loading.current = false;
      });
  }, [more, result, key, fetchAhead]);

  return { result, busy, error, more, loadMore };
}
