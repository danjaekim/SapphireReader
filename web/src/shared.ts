import { useEffect, useState } from "react";
import { addToLibrary, classifyAdult, library, ratingsFor, removeFromLibrary, type Rating } from "./api";

/** AniList scores, asked for in small batches as cards appear and remembered for the session. */
const ratingCache = new Map<string, Rating | null>();
const waiting = new Map<string, Set<() => void>>();
const altNames = new Map<string, string[]>();
let timer: number | undefined;

function flush() {
  timer = undefined;
  const titles = [...waiting.keys()].slice(0, 40);
  const alts = Object.fromEntries(titles.filter((t) => altNames.has(t)).map((t) => [t, altNames.get(t)!]));
  ratingsFor(titles, Object.keys(alts).length ? alts : undefined).then(
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

/** One rating to show for a series, out of 10: AniList's when it has one, else MangaUpdates'. */
export function bestRating(r: Rating | null | undefined): { value: number; source: string } | null {
  if (r?.score != null) return { value: r.score / 10, source: "AniList" };
  if (r?.mu != null) return { value: r.mu, source: "MangaUpdates" };
  return null;
}

/**
 * Everything known about a title's ratings (AniList score, banner, MangaUpdates): undefined while
 * loading, null when unknown. `alts` (other names) help find series listed under another title.
 */
export function useRating(title: string | null, enabled = true, alts?: string[]): Rating | null | undefined {
  const [, bump] = useState(0);
  const ready = alts !== undefined || enabled;
  useEffect(() => {
    if (!title || !enabled || !ready || ratingCache.has(title)) return;
    if (alts?.length) altNames.set(title, alts);
    const cb = () => bump((n) => n + 1);
    const set = waiting.get(title) ?? new Set();
    set.add(cb);
    waiting.set(title, set);
    if (timer === undefined) timer = window.setTimeout(flush, 150);
    return () => void set.delete(cb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, enabled, ready]);
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

/**
 * While 18+ mode is off, mixed sites can still list adult series. Cards ask (in small batches, once
 * on screen) whether their series should be hidden; the server remembers each answer.
 */
const hideCache = new Map<number, boolean>();
const hideWaiting = new Map<number, { title: string; sourceId?: string; cbs: Set<() => void> }>();
let hideTimer: number | undefined;

export function resetHiddenCache() {
  hideCache.clear();
}

function flushHide() {
  hideTimer = undefined;
  const ids = [...hideWaiting.keys()].slice(0, 30);
  const items = ids.map((mangaId) => ({ mangaId, title: hideWaiting.get(mangaId)!.title, sourceId: hideWaiting.get(mangaId)!.sourceId }));
  classifyAdult(items).then(
    (r) => ids.forEach((id) => hideCache.set(id, r.hide[id] === true)),
    () => ids.forEach((id) => hideCache.set(id, false)),
  ).finally(() => {
    for (const id of ids) {
      hideWaiting.get(id)?.cbs.forEach((cb) => cb());
      hideWaiting.delete(id);
    }
    if (hideWaiting.size > 0) hideTimer = window.setTimeout(flushHide, 100);
  });
}

/** True when this series is adult and 18+ mode is off, so its card should be hidden. */
export function useHiddenAdult(hit: { mangaId: number; title: string; sourceId?: string }, enabled: boolean): boolean {
  const [, bump] = useState(0);
  const id = hit.mangaId;
  useEffect(() => {
    if (!enabled || hideCache.has(id)) return;
    const cb = () => bump((n) => n + 1);
    const w = hideWaiting.get(id) ?? { title: hit.title, sourceId: hit.sourceId, cbs: new Set<() => void>() };
    w.cbs.add(cb);
    hideWaiting.set(id, w);
    if (hideTimer === undefined) hideTimer = window.setTimeout(flushHide, 200);
    return () => void w.cbs.delete(cb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled]);
  return hideCache.get(id) === true;
}
