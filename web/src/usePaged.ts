import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SearchResult, SeriesGroup } from "./api";
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
    const cached = cache.get(key);
    if (cached) {
      page.current = cached.page;
      restoreTo.current = cached.scrollY;
      setResult(cached.result);
      setMore(cached.more);
      setBusy(false);
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
        setResult(r);
        setMore(r.groups.length > 0);
        setBusy(false);
        remember(key, { result: r, page: 1, more: r.groups.length > 0, scrollY: 0 });
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
    fetchRef
      .current(next)
      .then((r) => {
        if (id !== run.current) return;
        page.current = next;
        const { merged, added } = mergeResults(result, r);
        setResult(merged);
        setMore(added > 0);
        if (key !== null) remember(key, { result: merged, page: next, more: added > 0, scrollY: cache.get(key)?.scrollY ?? 0 });
      })
      .catch(() => id === run.current && setMore(false))
      .finally(() => {
        loading.current = false;
      });
  }, [more, result, key]);

  return { result, busy, error, more, loadMore };
}
