import { Loading } from "./Loading";
import { useEffect, useState, type FormEvent } from "react";
import { browse, search } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";
import { navigate, pageHref } from "./route";
import { usePaged } from "./usePaged";
import { SortSelect, sortFrom, unsortedNote } from "./SortSelect";

/**
 * Search box plus stackable genre filters, with results that keep loading as you scroll.
 * The query and genres live in the address (#/search?q=…&genre=…), so Back restores them.
 */
export function Search({ params, scopeTag }: { params: URLSearchParams; scopeTag: string }) {
  const q = (params.get("q") ?? "").trim();
  const genres = params.getAll("genre");
  const seed = params.get("seed") ?? undefined;
  const sort = sortFrom(params.get("sort"));
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const active = genres.length > 0 || q.length >= 2;
  const { result, busy, error, more, loadMore } = usePaged(
    (page) => (genres.length > 0 ? browse(genres, q, page, undefined, seed, sort) : search(q, page, sort)),
    active ? `search|${scopeTag}|${q}|${genres.join(",")}|${seed ?? ""}|${sort}` : null,
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next = text.trim();
    if (next.length >= 2 || genres.length > 0) navigate(pageHref("search", { q: next, genre: genres, seed, sort: sort === "relevance" ? undefined : sort }));
  }

  const extra = result as { textFallback?: boolean; unsorted?: string[] } | null;
  const textFallback = extra?.textFallback === true;
  const notes = [textFallback ? "No series matched those genres exactly, so these are plain text-search results for them." : undefined, unsortedNote(extra?.unsorted)].filter(Boolean);
  return (
    <section>
      <form className="searchbar" onSubmit={onSubmit} role="search">
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={genres.length ? "Optional: add words to narrow it down" : "Search all sources"}
          aria-label="Search all sources"
        />
        <button type="submit" disabled={busy || (text.trim().length < 2 && genres.length === 0)}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      <div className="toolbar">
        <GenrePicker selected={genres} onChange={(g) => navigate(pageHref("search", { q, genre: g, seed, sort: sort === "relevance" ? undefined : sort }))} />
        <SortSelect value={sort} onChange={(next) => navigate(pageHref("search", { q, genre: genres, seed, sort: next === "relevance" ? undefined : next }))} />
      </div>
      {error && <p className="bad">{error}</p>}
      {busy && <Loading label="Searching every source. This can take several seconds." />}
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
