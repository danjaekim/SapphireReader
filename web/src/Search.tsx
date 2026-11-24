import { browse, search } from "./api";
import { FilterBar, useSourceChoices } from "./FilterBar";
import { Results, SkeletonResults } from "./Results";
import { navigate, pageHref } from "./route";
import { usePaged } from "./usePaged";
import { sortFrom, unsortedNote } from "./SortSelect";
import { rememberSearch, SearchStart } from "./SearchStart";
import { useEffect } from "react";

/**
 * Search box plus stackable genre filters, with results that keep loading as you scroll.
 * The query and genres live in the address (#/search?q=…&genre=…), so Back restores them.
 */
export function Search({ params, scopeTag }: { params: URLSearchParams; scopeTag: string }) {
  const q = (params.get("q") ?? "").trim();
  const genres = params.getAll("genre");
  const seed = params.get("seed") ?? undefined;
  const sort = sortFrom(params.get("sort"));
  const picked = params.getAll("source");
  const sourceList = useSourceChoices("search", scopeTag === "true");

  const active = genres.length > 0 || q.length >= 2;
  const { result, busy, error, more, loadMore } = usePaged(
    (page) => (genres.length > 0 ? browse(genres, q, page, undefined, seed, sort, picked) : search(q, page, sort, picked)),
    active ? `search|${scopeTag}|${q}|${genres.join(",")}|${seed ?? ""}|${sort}|${picked.join(",")}` : null,
  );

  // Remember each search that brought results back, for the empty Search page.
  const found = (result?.groups.length ?? 0) > 0;
  useEffect(() => {
    if (active && found) rememberSearch({ q, genres, adult: scopeTag === "true" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, found, q, genres.join("|"), scopeTag]);

  const go = (next: { q?: string; genre?: string[]; sort?: string; source?: string[] }) => {
    const s = next.sort ?? sort;
    navigate(pageHref("search", { q: next.q ?? q, genre: next.genre ?? genres, seed, sort: s === "relevance" ? undefined : s, source: next.source ?? picked }));
  };

  const extra = result as { textFallback?: boolean; unsorted?: string[] } | null;
  const textFallback = extra?.textFallback === true;
  const notes = [textFallback ? "No series matched those genres exactly, so these are plain text-search results for them." : undefined, unsortedNote(extra?.unsorted)].filter(Boolean);
  return (
    <section>
      <FilterBar
        search={{
          value: q,
          busy,
          canSubmitEmpty: genres.length > 0,
          placeholder: genres.length ? "Optional: add words to narrow it down" : picked.length ? "Search the sources you picked" : "Search all sources",
          onSubmit: (text) => go({ q: text }),
        }}
        genres={genres}
        onGenres={(g) => go({ genre: g })}
        sort={sort}
        onSort={(next) => go({ sort: next })}
        sources={{ list: sourceList, selected: picked, onChange: (ids) => go({ source: ids }) }}
      />
      {!active && <SearchStart adultOn={scopeTag === "true"} />}
      {error && <p className="bad">{error}</p>}
      {busy && <SkeletonResults label="Searching every source. This can take several seconds." />}
      {result && (
        <Results
          result={result}
          hasMore={more}
          onMore={loadMore}
          empty={genres.length > 0 ? "No series on your sources have all of those genres. Try removing one." : "Nothing found."}
          note={notes.length ? notes.join(" ") : undefined}
        />
      )}
    </section>
  );
}
