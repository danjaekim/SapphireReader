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
  | "status"
  | "merges";

const PAGES: PageName[] = ["home", "search", "library", "discover", "discover-18", "downloads", "updates", "history", "sources", "status", "merges"];

export type Route =
  | { name: "page"; page: PageName; params: URLSearchParams }
  | { name: "series"; mangaId: number }
  | { name: "read"; mangaId: number; chapterId: number; page?: number };

/**
 * The address bar is the app's state: pages and their search, filter and sort settings all live in
 * the hash, so back, forward and reload land you exactly where you were.
 */
export function parseHash(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const series = /^\/series\/(\d+)$/.exec(path);
  if (series) return { name: "series", mangaId: Number(series[1]) };
  const read = /^\/read\/(\d+)\/(\d+)$/.exec(path);
  if (read) {
    const page = Number(new URLSearchParams(query).get("page"));
    return { name: "read", mangaId: Number(read[1]), chapterId: Number(read[2]), ...(Number.isInteger(page) && page > 0 ? { page } : {}) };
  }
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

/** MangaBaka tags in an address: "id:name" each (the name is for showing). */
export interface MbTagParam {
  id: number;
  name: string;
}
export const mbTagsFrom = (params: URLSearchParams): MbTagParam[] =>
  params
    .getAll("mb")
    .map((v) => {
      const at = v.indexOf(":");
      return { id: Number(at > 0 ? v.slice(0, at) : v), name: at > 0 ? v.slice(at + 1) : v };
    })
    .filter((t) => Number.isInteger(t.id) && t.id > 0);
export const mbTagValues = (tags: MbTagParam[]) => tags.map((t) => `${t.id}:${t.name}`);
/** Opens Search (or Discover 18+ for an 18+ series) filtered by one MangaBaka tag. */
export const mbTagHref = (tag: MbTagParam, adult = false) => pageHref(adult ? "discover-18" : "search", { mb: mbTagValues([tag]) });

/** Opens Search for a name (an author or artist). */
export const searchHref = (q: string) => pageHref("search", { q });

export const seriesHref = (mangaId: number) => `#/series/${mangaId}`;
/** Opens the reader; `page` (counted from 0) jumps straight to that page. */
export const readHref = (mangaId: number, chapterId: number, page = 0) => `#/read/${mangaId}/${chapterId}${page > 0 ? `?page=${page}` : ""}`;

// The pages visited, mirroring the browser's history, so "back to the series" from the reader can tell
// whether the series page is already the previous entry (then it goes back, rather than adding another).
const trail: string[] = [];
let at = -1;
let replacing = false;
if (typeof window !== "undefined") {
  trail.push(window.location.hash);
  at = 0;
  window.addEventListener("hashchange", () => {
    const h = window.location.hash;
    if (replacing) trail[at] = h;
    else if (trail[at - 1] === h) at--;
    else if (trail[at + 1] === h) at++;
    else {
      trail.length = at + 1;
      trail.push(h);
      at++;
    }
    replacing = false;
  });
}

/** Goes to a page without adding a history entry (so Back skips over it). */
export function replaceHash(href: string) {
  if (window.location.hash === href) return;
  replacing = true;
  window.location.replace(href);
}

/**
 * "Back to X" for a page that normally comes right after X: steps back in history if X is the previous
 * page, otherwise swaps this page for X. Either way you never end up bouncing between two pages.
 */
export function backTo(href: string) {
  if (trail[at - 1] === href) window.history.back();
  else replaceHash(href);
}

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
