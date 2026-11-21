import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResult, SeriesGroup } from "./api";

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

/**
 * Loads page 1 whenever `key` changes (null means "don't load"), then more pages on demand.
 * Stops when a page brings nothing new.
 */
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

  useEffect(() => {
    const id = ++run.current;
    page.current = 1;
    loading.current = false;
    setResult(null);
    setError(null);
    setMore(false);
    if (key === null) {
      setBusy(false);
      return;
    }
    setBusy(true);
    fetchRef.current(1).then(
      (r) => {
        if (id !== run.current) return;
        setResult(r);
        setMore(r.groups.length > 0);
        setBusy(false);
      },
      (e: unknown) => {
        if (id !== run.current) return;
        setError(e instanceof Error ? e.message : "Couldn't load results.");
        setBusy(false);
      },
    );
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
        setResult((cur) => {
          if (!cur) return cur;
          const { merged, added } = mergeResults(cur, r);
          setMore(added > 0);
          return merged;
        });
      })
      .catch(() => id === run.current && setMore(false))
      .finally(() => {
        loading.current = false;
      });
  }, [more, result]);

  return { result, busy, error, more, loadMore };
}
