import { useEffect, useState } from "react";
import { chapterPages } from "./api";
import { readHere } from "./connection";
import { readHref } from "./route";
import { tidyTitle } from "./titles";

/**
 * Chapters saved on this device (phone, tablet, PC) for reading with no connection. Pages go into
 * the browser's Cache Storage, and the service worker serves them from there. Browsers only allow
 * this on a secure address (https, or localhost), so over plain http the buttons stay hidden.
 */
const CACHE = "sapphire-offline-v1";
const INDEX = "/offline/chapter/";

export interface OfflineChapter {
  mangaId: number;
  chapterId: number;
  series: string;
  chapter: string;
  pages: number;
  savedAt: string;
  /** Chapter number, for ordering (missing on chapters saved before offline mode). */
  number?: number;
  /** From an 18+ series: only listed while 18+ mode is on (missing on older saves = unknown, kept hidden while locked). */
  adult?: boolean;
}

/** The chapter number of a saved chapter (older saves only kept "Chapter 12"). */
export const numberOf = (c: OfflineChapter) => c.number ?? (Number(/(-?\d+(?:\.\d+)?)/.exec(c.chapter)?.[1]) || 0);

export const offlineSupported = () => typeof window !== "undefined" && window.isSecureContext && "caches" in window;

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export async function offlineChapters(): Promise<OfflineChapter[]> {
  if (!offlineSupported()) return [];
  const cache = await caches.open(CACHE);
  const keys = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith(INDEX));
  const items = await Promise.all(keys.map(async (k) => (await cache.match(k))?.json() as Promise<OfflineChapter> | undefined));
  return items.filter((x): x is OfflineChapter => !!x).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

async function isSaved(chapterId: number): Promise<boolean> {
  if (!offlineSupported()) return false;
  return !!(await (await caches.open(CACHE)).match(`${INDEX}${chapterId}`));
}

/** Saves a chapter's pages (and what the reader needs to open it) on this device. */
export async function saveOffline(mangaId: number, chapterId: number, pages: string[], onProgress?: (done: number) => void) {
  const cache = await caches.open(CACHE);
  // Ask the browser not to clear these when space runs low.
  await navigator.storage?.persist?.().catch(() => false);
  const series = await fetch(`/api/manga/${mangaId}`);
  if (!series.ok) throw new Error("Couldn't load the series.");
  const data = (await series.clone().json()) as { manga: { title: string }; adult?: boolean; chapters: { id: number; chapterNumber: number; name: string }[] };
  await cache.put(`/api/manga/${mangaId}`, series);
  await cache.add(`/api/chapters/${chapterId}/pages`);
  await cache.add(`/api/manga/${mangaId}/thumbnail`).catch(() => {});
  let done = 0;
  for (const src of pages) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Page ${done + 1} didn't download.`);
    await cache.put(src, res);
    onProgress?.(++done);
  }
  const c = data.chapters.find((x) => x.id === chapterId);
  const entry: OfflineChapter = {
    mangaId,
    chapterId,
    series: data.manga.title,
    chapter: c ? (c.chapterNumber >= 0 ? `Chapter ${c.chapterNumber}` : c.name) : "Chapter",
    pages: pages.length,
    savedAt: new Date().toISOString(),
    number: c?.chapterNumber,
    adult: data.adult === true,
  };
  await cache.put(`${INDEX}${chapterId}`, new Response(JSON.stringify(entry), { headers: { "content-type": "application/json" } }));
  changed();
}

/** Saves several chapters on this device, one after another; reports how many are done. */
export async function saveManyOffline(mangaId: number, chapterIds: number[], onProgress?: (done: number) => void): Promise<number> {
  let done = 0;
  for (const id of chapterIds) {
    if (!(await isSaved(id))) {
      const { pages } = await chapterPages(id);
      await saveOffline(mangaId, id, pages);
    }
    onProgress?.(++done);
  }
  return done;
}

/** Removing a chapter from this device once it's read (on unless turned off on the Downloads page). */
const AUTO_REMOVE = "sapphire.offline.autoRemove";
export const autoRemoveOn = () => {
  try {
    return localStorage.getItem(AUTO_REMOVE) !== "0";
  } catch {
    return true;
  }
};
export const setAutoRemove = (on: boolean) => {
  try {
    localStorage.setItem(AUTO_REMOVE, on ? "1" : "0");
  } catch {
    // Not saved.
  }
};
export { isSaved };

/** Older saves don't say whether they're 18+; ask the NAS once while it can be reached. */
export async function fillAdultFlags(): Promise<void> {
  if (!offlineSupported()) return;
  const cache = await caches.open(CACHE);
  const missing = (await offlineChapters()).filter((c) => c.adult === undefined || c.number === undefined);
  const byManga = new Map<number, OfflineChapter[]>();
  for (const c of missing) byManga.set(c.mangaId, [...(byManga.get(c.mangaId) ?? []), c]);
  for (const [mangaId, list] of byManga) {
    const res = await fetch(`/api/manga/${mangaId}`).catch(() => null);
    if (!res?.ok || res.headers.get("x-sapphire-offline")) return;
    const d = (await res.json()) as { adult?: boolean; chapters: { id: number; chapterNumber: number }[] };
    for (const c of list) {
      const n = d.chapters.find((x) => x.id === c.chapterId)?.chapterNumber;
      await cache.put(`${INDEX}${c.chapterId}`, new Response(JSON.stringify({ ...c, adult: d.adult === true, number: c.number ?? n }), { headers: { "content-type": "application/json" } }));
    }
  }
  changed();
}

export async function removeOffline(chapterId: number) {
  const cache = await caches.open(CACHE);
  const pagesRes = await cache.match(`/api/chapters/${chapterId}/pages`);
  const pages = pagesRes ? ((await pagesRes.json()) as { pages: string[] }).pages : [];
  await Promise.all([...pages.map((p) => cache.delete(p)), cache.delete(`/api/chapters/${chapterId}/pages`), cache.delete(`${INDEX}${chapterId}`)]);
  changed();
}

export function useOfflineChapters(): OfflineChapter[] | null {
  const [items, setItems] = useState<OfflineChapter[] | null>(null);
  useEffect(() => {
    const load = () => offlineChapters().then(setItems, () => setItems([]));
    load();
    listeners.add(load);
    return () => void listeners.delete(load);
  }, []);
  return items;
}

/** "Save on this device" for one chapter; shows progress, then a tick (tap again to remove). */
export function OfflineButton({ mangaId, chapterId, pages, compact = false }: { mangaId: number; chapterId: number; pages: string[]; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "saved" | "error" | number>("idle");
  useEffect(() => {
    isSaved(chapterId).then((s) => setState(s ? "saved" : "idle"), () => {});
  }, [chapterId]);
  if (!offlineSupported()) return null;

  async function toggle() {
    if (state === "saved") {
      await removeOffline(chapterId);
      return setState("idle");
    }
    setState(0);
    try {
      await saveOffline(mangaId, chapterId, pages, (n) => setState(n));
      setState("saved");
    } catch {
      setState("error");
    }
  }

  const label =
    state === "saved" ? "On this device (tap to remove)" : typeof state === "number" ? `Saving ${state} of ${pages.length}` : state === "error" ? "Saving failed. Tap to retry." : "Save on this device for offline reading";
  return (
    <button type="button" className={`iconBtn offlineBtn ${state === "saved" ? "on" : ""}`} onClick={toggle} title={label} aria-label={label} disabled={typeof state === "number"}>
      {typeof state === "number" ? `${Math.round((state / Math.max(1, pages.length)) * 100)}%` : state === "saved" ? "📱✓" : state === "error" ? "📱!" : compact ? "📱" : "📱 Save offline"}
    </button>
  );
}

/**
 * What's on this device, by series: shown instead of the usual pages while the NAS can't be reached (and on
 * a series page, just that series). 18+ series stay hidden unless 18+ mode was on.
 */
export function OfflineHome({ mangaId, adult }: { mangaId?: number; adult: boolean }) {
  const items = useOfflineChapters();
  if (items === null) return null;
  const read = readHere();
  const shown = items.filter((c) => (adult || c.adult === false) && (mangaId === undefined || c.mangaId === mangaId));
  const groups = new Map<number, OfflineChapter[]>();
  for (const c of shown) groups.set(c.mangaId, [...(groups.get(c.mangaId) ?? []), c]);
  const series = [...groups.values()].map((list) => list.sort((a, b) => numberOf(a) - numberOf(b)));
  return (
    <section className="offlineHome">
      <p className="muted">
        {mangaId === undefined ? "" : "Only the chapters saved here can be read offline. "}
        Your place is kept here and sent to the NAS when it's back.
      </p>
      {series.length === 0 ? (
        <p className="muted">{mangaId === undefined ? "Nothing is saved on this device yet. Next time you're online, pick chapters on a series page and choose Save to phone." : "No chapters of this series are saved on this device."}</p>
      ) : (
        series.map((list) => {
          const first = list[0];
          const next = list.find((c) => !read.has(c.chapterId)) ?? null;
          return (
            <article key={first.mangaId} className="card offlineSeries">
              <header>
                <img src={`/api/manga/${first.mangaId}/thumbnail`} alt="" width={56} height={80} />
                <span className="offlineSeriesInfo">
                  <strong>{tidyTitle(first.series)}</strong>
                  <span className="muted small">{list.length} chapter{list.length === 1 ? "" : "s"} saved{next ? "" : ", all read"}</span>
                </span>
                {next && <a className="button small" href={readHref(next.mangaId, next.chapterId)}>Read {next.chapter}</a>}
              </header>
              <ul className="offlineChapters">
                {list.map((c) => (
                  <li key={c.chapterId} className={read.has(c.chapterId) ? "read" : ""}>
                    <a href={readHref(c.mangaId, c.chapterId)}>{c.chapter}</a>
                    {read.has(c.chapterId) && <span className="muted small">Read</span>}
                    <button type="button" className="linkish" onClick={() => void removeOffline(c.chapterId)}>Remove</button>
                  </li>
                ))}
              </ul>
            </article>
          );
        })
      )}
    </section>
  );
}
