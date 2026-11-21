import { useEffect, useState } from "react";

export type Route =
  | { name: "tab"; genres: string[] }
  | { name: "series"; mangaId: number }
  | { name: "read"; mangaId: number; chapterId: number };

export function parseHash(hash: string): Route {
  const series = /^#\/series\/(\d+)$/.exec(hash);
  if (series) return { name: "series", mangaId: Number(series[1]) };
  const read = /^#\/read\/(\d+)\/(\d+)$/.exec(hash);
  if (read) return { name: "read", mangaId: Number(read[1]), chapterId: Number(read[2]) };
  const find = /^#\/search\?(.*)$/.exec(hash);
  if (find) return { name: "tab", genres: new URLSearchParams(find[1]).getAll("genre") };
  return { name: "tab", genres: [] };
}

/** Opens Search with these genres already selected. */
export const genreHref = (...genres: string[]) =>
  `#/search?${genres.map((g) => `genre=${encodeURIComponent(g)}`).join("&")}`;

export const seriesHref = (mangaId: number) => `#/series/${mangaId}`;
export const readHref = (mangaId: number, chapterId: number) => `#/read/${mangaId}/${chapterId}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
