import { useEffect, useState, type FormEvent } from "react";
import { browse, search } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";
import { usePaged } from "./usePaged";

interface Request {
  genres: string[];
  q: string;
}

/** Search box plus stackable genre filters, with results that keep loading as you scroll. */
export function Search({ initialGenres = [] }: { initialGenres?: string[] }) {
  const [genres, setGenres] = useState<string[]>(initialGenres);
  const [query, setQuery] = useState("");
  // Results follow the last submitted request, not every keystroke. Arriving from a genre link submits at once.
  const [request, setRequest] = useState<Request | null>(initialGenres.length ? { genres: initialGenres, q: "" } : null);
  const canRun = genres.length > 0 || query.trim().length >= 2;

  const { result, busy, error, more, loadMore } = usePaged(
    (page) => (request!.genres.length > 0 ? browse(request!.genres, request!.q, page) : search(request!.q, page)),
    request ? JSON.stringify(request) : null,
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (canRun) setRequest({ genres, q: query.trim() });
  }

  const skipped = (result as { skipped?: string[] } | null)?.skipped ?? [];
  useEffect(() => {
    document.title = "Sapphire";
  }, []);

  return (
    <section>
      <form className="searchbar" onSubmit={onSubmit} role="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={genres.length ? "Optional: add words to narrow it down" : "Search all sources"}
          aria-label="Search all sources"
        />
        <button type="submit" disabled={busy || !canRun}>
          {busy ? "Searching…" : genres.length ? "Apply" : "Search"}
        </button>
      </form>
      <GenrePicker selected={genres} onChange={setGenres} />
      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Searching every source. This can take several seconds.</p>}
      {result && (
        <Results
          result={result}
          hasMore={more}
          onMore={loadMore}
          note={skipped.length > 0 ? `Left out because they can't filter by every genre picked: ${skipped.join(", ")}.` : undefined}
        />
      )}
    </section>
  );
}
