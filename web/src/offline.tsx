import { useEffect, useState } from "react";

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
}

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
  const data = (await series.clone().json()) as { manga: { title: string }; chapters: { id: number; chapterNumber: number; name: string }[] };
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
  };
  await cache.put(`${INDEX}${chapterId}`, new Response(JSON.stringify(entry), { headers: { "content-type": "application/json" } }));
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
