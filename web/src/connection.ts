import { useEffect, useState } from "react";

/**
 * Whether the NAS can be reached. Any API call that fails to connect (or gets the service worker's
 * offline stand-in) marks the app offline; a light ping every 15 seconds, or the browser coming back
 * online, finds the NAS again. While offline the app shows what's saved on this device, and reading
 * progress waits in a queue (see pending below) until the NAS is back.
 */
let offline = false;
const listeners = new Set<(o: boolean) => void>();
let ping: number | undefined;

export const isOffline = () => offline;

export function reportOffline(next: boolean): void {
  if (next === offline) return;
  offline = next;
  listeners.forEach((l) => l(next));
  if (next) startPing();
  else {
    stopPing();
    void flushPending();
  }
}

async function check(): Promise<void> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (r.ok && !r.headers.get("x-sapphire-offline")) reportOffline(false);
  } catch {
    // Still offline.
  }
}
function startPing() {
  if (ping === undefined && typeof window !== "undefined") ping = window.setInterval(() => void check(), 15_000);
}
function stopPing() {
  if (ping !== undefined) window.clearInterval(ping);
  ping = undefined;
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void check());
  window.addEventListener("offline", () => reportOffline(true));
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && offline && void check());
}

export function useOffline(): boolean {
  const [o, setO] = useState(offline);
  useEffect(() => {
    setO(offline);
    listeners.add(setO);
    return () => void listeners.delete(setO);
  }, []);
  return o;
}

/** fetch for the API: notes whether the NAS answered. */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    reportOffline(true);
    throw new Error("You're offline.");
  }
  reportOffline(res.headers.get("x-sapphire-offline") === "1");
  return res;
}

// ---- Reading progress made while offline, sent when the NAS is back. ----

const QUEUE = "sapphire.pending";
const READ_HERE = "sapphire.readHere";
interface PendingProgress {
  mangaId: number;
  body: { chapterId: number; chapterNumber: number; chapterName: string; pageIndex: number; pageOffset: number; finished?: boolean };
  device: string;
}
const load = <T>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Full or blocked: nothing more to do.
  }
};

/** Keeps a progress save for later. Finished chapters are also remembered here so offline lists show them read. */
export function queueProgress(mangaId: number, body: PendingProgress["body"], device: string): void {
  const q = load<PendingProgress[]>(QUEUE, []);
  // Only the newest unfinished save per series matters; finished ones each mark a chapter read.
  // Drop this series' older unfinished place, and a repeat of the same finished chapter; keep other finished ones.
  const kept = q.filter((p) => p.mangaId !== mangaId || (p.body.finished && !(body.finished && p.body.chapterId === body.chapterId)));
  kept.push({ mangaId, body, device });
  store(QUEUE, kept.slice(-500));
  if (body.finished) markReadHere(body.chapterId);
}

/** A newer save made online replaces any queued place for that series (finished chapters still go). */
export function supersede(mangaId: number): void {
  const q = load<PendingProgress[]>(QUEUE, []);
  const kept = q.filter((p) => p.mangaId !== mangaId || p.body.finished);
  if (kept.length !== q.length) store(QUEUE, kept);
}

export function markReadHere(chapterId: number): void {
  const ids = load<number[]>(READ_HERE, []);
  if (!ids.includes(chapterId)) store(READ_HERE, [...ids, chapterId].slice(-3000));
}
export const readHere = (): Set<number> => new Set(load<number[]>(READ_HERE, []));
export const pendingCount = (): number => load<PendingProgress[]>(QUEUE, []).length;

let flushing = false;
/** Sends the queued saves in order; stops at the first failure and tries again next time. */
export async function flushPending(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const q = load<PendingProgress[]>(QUEUE, []);
      if (q.length === 0) break;
      const p = q[0];
      const res = await fetch(`/api/progress/${p.mangaId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(p.device ? { "x-sapphire-device": p.device } : {}) },
        body: JSON.stringify(p.body),
      }).catch(() => null);
      if (!res || res.headers.get("x-sapphire-offline") === "1") break;
      // A save the server refuses (a series it no longer knows) is dropped rather than retried forever.
      store(QUEUE, load<PendingProgress[]>(QUEUE, []).slice(1));
      sent++;
    }
  } finally {
    flushing = false;
  }
  return sent;
}
