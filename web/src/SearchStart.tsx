import { useEffect, useState } from "react";
import { genreList } from "./api";
import { canonLabel } from "./genres";
import { pageHref } from "./route";

/** A search you ran, kept on this device so the empty Search page can offer it again. */
export interface RecentSearch {
  q: string;
  genres: string[];
  /** Run while 18+ mode was on: only offered again while it's on. */
  adult: boolean;
}

const KEY = "sapphire.recentSearches";
const MAX = 8;

function load(): RecentSearch[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as RecentSearch[]).filter((r) => typeof r?.q === "string" && Array.isArray(r.genres)) : [];
  } catch {
    return [];
  }
}
function save(list: RecentSearch[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Private mode or storage off: recent searches just aren't kept.
  }
}
const same = (a: RecentSearch, b: RecentSearch) => a.q.toLowerCase() === b.q.toLowerCase() && a.genres.join("|") === b.genres.join("|");

export function rememberSearch(entry: RecentSearch) {
  if (entry.q.length < 2 && entry.genres.length === 0) return;
  save([entry, ...load().filter((r) => !same(r, entry))]);
}

const label = (r: RecentSearch) => [r.q && `“${r.q}”`, ...r.genres.map(canonLabel)].filter(Boolean).join(" · ");

/** What the Search page shows before you search: your recent searches and the genres your sources offer most. */
export function SearchStart({ adultOn }: { adultOn: boolean }) {
  const [recent, setRecent] = useState(() => load());
  const [genres, setGenres] = useState<string[] | null>(null);
  useEffect(() => {
    genreList().then((r) => setGenres([...r.genres].sort((a, b) => b.sources - a.sources).slice(0, 16).map((g) => g.name)), () => setGenres([]));
  }, []);
  const shown = recent.filter((r) => adultOn || !r.adult);
  const forget = (r: RecentSearch) => {
    const next = recent.filter((x) => !same(x, r));
    setRecent(next);
    save(next);
  };
  const clear = () => {
    const next = recent.filter((r) => r.adult && !adultOn);
    setRecent(next);
    save(next);
  };

  return (
    <div className="searchStart">
      {shown.length > 0 && (
        <section>
          <div className="searchStartHead">
            <h3>Recent</h3>
            <button type="button" className="linkish" onClick={clear}>Clear</button>
          </div>
          <ul className="recentList">
            {shown.map((r) => (
              <li key={label(r)}>
                <a href={pageHref("search", { q: r.q || undefined, genre: r.genres })}>
                  <span aria-hidden="true" className="recentIcon">↺</span>
                  <span className="recentLabel">{label(r)}</span>
                </a>
                <button type="button" className="recentX" aria-label={`Forget ${label(r)}`} onClick={() => forget(r)}>×</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {genres && genres.length > 0 && (
        <section>
          <div className="searchStartHead"><h3>Browse by genre</h3></div>
          <div className="tagOpts">
            {genres.map((g) => (
              <a key={g} className="tagOpt" href={pageHref("search", { genre: [g] })}>{g}</a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
