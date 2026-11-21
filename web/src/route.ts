import { useEffect, useState } from "react";

export type PageName =
  | "home"
  | "search"
  | "library"
  | "discover"
  | "discover-18"
  | "downloads"
  | "updates"
  | "history"
  | "sources"
  | "status";

const PAGES: PageName[] = ["home", "search", "library", "discover", "discover-18", "downloads", "updates", "history", "sources", "status"];

export type Route =
  | { name: "page"; page: PageName; params: URLSearchParams }
  | { name: "series"; mangaId: number }
  | { name: "read"; mangaId: number; chapterId: number };

/**
 * The address bar is the app's state: pages and their search, filter and sort settings all live in
 * the hash, so back, forward and reload land you exactly where you were.
 */
export function parseHash(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const series = /^\/series\/(\d+)$/.exec(path);
  if (series) return { name: "series", mangaId: Number(series[1]) };
  const read = /^\/read\/(\d+)\/(\d+)$/.exec(path);
  if (read) return { name: "read", mangaId: Number(read[1]), chapterId: Number(read[2]) };
  const page = path.replace(/^\//, "") as PageName;
  return { name: "page", page: PAGES.includes(page) ? page : "home", params: new URLSearchParams(query) };
}

type ParamValue = string | string[] | null | undefined;

export function pageHref(page: PageName, params: Record<string, ParamValue> = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : v ? [v] : []) if (item) qs.append(k, item);
  }
  const s = qs.toString();
  return `#/${page}${s ? `?${s}` : ""}`;
}

/** Opens Search with these genres already selected. */
export const genreHref = (genre: string, seed?: number, adult = false) =>
  pageHref(adult ? "discover-18" : "search", { genre: [genre], seed: seed ? String(seed) : undefined });

/** Opens Search for a name (an author or artist). */
export const searchHref = (q: string) => pageHref("search", { q });

export const seriesHref = (mangaId: number) => `#/series/${mangaId}`;
export const readHref = (mangaId: number, chapterId: number) => `#/read/${mangaId}/${chapterId}`;

// How many times the address has changed since the app opened. Zero means this page was opened directly
// (a bookmark, an alert), so there's nowhere "back" to inside Sapphire.
let moves = 0;
if (typeof window !== "undefined") window.addEventListener("hashchange", () => void moves++);

/** Goes back like the browser's back button, or to `fallback` if this is the first page that was opened. */
export function goBack(fallback = "#/home") {
  if (moves > 0 && window.history.length > 1) window.history.back();
  else window.location.hash = fallback;
}

export function navigate(href: string) {
  window.location.hash = href;
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseHash(hash);
}
