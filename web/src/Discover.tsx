import { useState } from "react";
import { browse, discoverList, forYou, type SearchResult } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";
import { usePaged } from "./usePaged";

type Mode = "For you" | "Popular" | "Latest";
const modes: Mode[] = ["For you", "Popular", "Latest"];

/** Browse without a search term: recommendations, each site's popular and latest lists, or genre filters. */
export function Discover({ adult = false }: { adult?: boolean }) {
  const [mode, setMode] = useState<Mode>("For you");
  const [genres, setGenres] = useState<string[]>([]);
  const [empty, setEmpty] = useState<string | undefined>();

  const { result, busy, error, more, loadMore } = usePaged(async (page): Promise<SearchResult> => {
    if (page === 1) setEmpty(undefined);
    if (genres.length > 0) {
      const b = await browse(genres, "", page);
      return { ...b, note: b.skipped.length ? `Left out because they can't filter by every genre picked: ${b.skipped.join(", ")}.` : undefined };
    }
    if (mode === "For you") {
      // Recommendations come as one list, not pages.
      if (page > 1) return { groups: [], failed: [], searched: 0 };
      const f = await forYou(adult);
      setEmpty(
        f.because.length === 0
          ? adult
            ? "Add a few 18+ series to your library and this page will start recommending similar ones. It never mixes with your regular recommendations."
            : "Add a few series to your library and Sapphire will start recommending similar ones here."
          : undefined,
      );
      return { groups: f.groups, failed: [], searched: 0, note: f.because.length ? `Because you like ${f.because.join(", ")}.` : undefined };
    }
    return discoverList(mode === "Latest" ? "latest" : "popular", adult, page);
  }, `${adult}|${mode}|${genres.join(",")}`);

  return (
    <section>
      <div className="chips" role="tablist" aria-label="Discover">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            className={`chip ${genres.length === 0 && mode === m ? "on" : ""}`}
            aria-selected={genres.length === 0 && mode === m}
            onClick={() => {
              setGenres([]);
              setMode(m);
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <GenrePicker selected={genres} onChange={setGenres} />
      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Asking your sources. This can take several seconds.</p>}
      {result && <Results result={result} empty={empty} lookups={false} hasMore={more} onMore={loadMore} />}
    </section>
  );
}
