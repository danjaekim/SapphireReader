import { useEffect, useState } from "react";
import { addToLibrary, library, ratingsFor, removeFromLibrary, type Rating } from "./api";

/** AniList scores, asked for in small batches as cards appear and remembered for the session. */
const ratingCache = new Map<string, Rating | null>();
const waiting = new Map<string, Set<() => void>>();
let timer: number | undefined;

function flush() {
  timer = undefined;
  const titles = [...waiting.keys()].slice(0, 40);
  ratingsFor(titles).then(
    (r) => titles.forEach((t) => ratingCache.set(t, r.ratings[t] ?? null)),
    () => titles.forEach((t) => ratingCache.set(t, null)),
  ).finally(() => {
    for (const t of titles) {
      waiting.get(t)?.forEach((cb) => cb());
      waiting.delete(t);
    }
    if (waiting.size > 0) timer = window.setTimeout(flush, 100);
  });
}

/** The AniList score (0-100) for a title: undefined while loading, null when AniList doesn't know it. */
export function useScore(title: string | null, enabled = true): number | null | undefined {
  const r = useRating(title, enabled);
  return r === undefined ? undefined : (r?.score ?? null);
}

/** Everything AniList told us about a title (score, banner): undefined while loading, null when unknown. */
export function useRating(title: string | null, enabled = true): Rating | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!title || !enabled || ratingCache.has(title)) return;
    const cb = () => bump((n) => n + 1);
    const set = waiting.get(title) ?? new Set();
    set.add(cb);
    waiting.set(title, set);
    if (timer === undefined) timer = window.setTimeout(flush, 150);
    return () => void set.delete(cb);
  }, [title, enabled]);
  if (!title) return null;
  return ratingCache.has(title) ? (ratingCache.get(title) ?? null) : undefined;
}

/** Which series are in the library, shared so every card agrees and updates at once. */
let libIds: Set<number> | null = null;
let libLoading = false;
const libListeners = new Set<() => void>();
const libChanged = () => libListeners.forEach((l) => l());

export function useLibraryIds() {
  const [, bump] = useState(0);
  useEffect(() => {
    const cb = () => bump((n) => n + 1);
    libListeners.add(cb);
    if (!libIds && !libLoading) {
      libLoading = true;
      library().then((r) => { libIds = new Set(r.items.map((i) => i.mangaId)); }, () => { libIds = new Set(); }).finally(() => { libLoading = false; libChanged(); });
    }
    return () => void libListeners.delete(cb);
  }, []);
  return {
    has: (id: number) => libIds?.has(id) ?? false,
    ready: libIds !== null,
    async toggle(hit: { mangaId: number; sourceId: string; sourceName: string; title: string }) {
      const ids = libIds ?? new Set<number>();
      libIds = ids;
      const adding = !ids.has(hit.mangaId);
      adding ? ids.add(hit.mangaId) : ids.delete(hit.mangaId);
      libChanged();
      try {
        if (adding) await addToLibrary(hit.mangaId, hit.sourceId, hit.sourceName, hit.title);
        else await removeFromLibrary(hit.mangaId);
      } catch {
        adding ? ids.delete(hit.mangaId) : ids.add(hit.mangaId);
        libChanged();
      }
    },
  };
}

/** Forget the cached library list (after it changes somewhere else). */
export const forgetLibraryIds = () => { libIds = null; };
