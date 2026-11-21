import { useEffect, useState, type FormEvent } from "react";
import { browse, search } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";
import { navigate, pageHref } from "./route";
import { usePaged } from "./usePaged";

/**
 * Search box plus stackable genre filters, with results that keep loading as you scroll.
 * The query and genres live in the address (#/search?q=…&genre=…), so Back restores them.
 */
export function Search({ params, scopeTag }: { params: URLSearchParams; scopeTag: string }) {
  const q = (params.get("q") ?? "").trim();
  const genres = params.getAll("genre");
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);

  const active = genres.length > 0 || q.length >= 2;
  const { result, busy, error, more, loadMore } = usePaged(
    (page) => (genres.length > 0 ? browse(genres, q, page) : search(q, page)),
    active ? `search|${scopeTag}|${q}|${genres.join(",")}` : null,
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next = text.trim();
    if (next.length >= 2 || genres.length > 0) navigate(pageHref("search", { q: next, genre: genres }));
  }

  const skipped = (result as { skipped?: string[] } | null)?.skipped ?? [];
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
      <GenrePicker selected={genres} onChange={(g) => navigate(pageHref("search", { q, genre: g }))} />
      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Searching every source. This can take several seconds.</p>}
      {result && (
        <Results
          result={result}
          hasMore={more}
          onMore={loadMore}
          empty={genres.length > 0 ? "No series on your sources have all of those genres. Try removing one." : "Nothing found."}
          note={skipped.length > 0 ? `${skipped.join(", ")} can't filter by these genres, so ${skipped.length === 1 ? "it was" : "they were"} not searched.` : undefined}
        />
      )}
    </section>
  );
}
